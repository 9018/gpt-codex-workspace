/**
 * acceptance-agent.mjs — Universal acceptance agent for evidence-based verification.
 *
 * Runs configurable acceptance profiles against completed task results.
 * Checks: result.json validity, summary presence, verification commands,
 * worktree cleanliness, changed file safety, commit/patch evidence.
 */

import { evaluateAcceptance, buildReviewerDecision } from './acceptance-policy.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export const ACCEPTANCE_PROFILES = {
  DEFAULT: 'default',
  CODE_CHANGE: 'code_change',
  DOCS_ONLY: 'docs_only',
  CONFIG_CHANGE: 'config_change',
  DEPLOY: 'deploy',
  NOOP: 'noop',
};

function isManagedGitStatusLine(line) {
  const path = String(line || "").slice(3).trim();
  return path === ".gptwork" || path.startsWith(".gptwork/") || path === "worktrees" || path.startsWith("worktrees/");
}

/**
 * Build evidence from git status, diff, and verification log.
 *
 * @param {object} options
 * @param {string} options.repoPath - Path to the git repo (canonical or worktree)
 * @param {string} [options.worktreePath] - Optional worktree path for git operations
 * @param {string} [options.verificationLogPath] - Path to verification.log file
 * @param {string} [options.resultJsonPath] - Path to result.json file
 * @returns {Promise<object>} Evidence object
 */
export async function buildEvidence({ repoPath, worktreePath, verificationLogPath, resultJsonPath } = {}) {
  const gitPath = worktreePath || repoPath;
  const evidence = {
    git_status: null,
    git_diff_summary: null,
    commit_exists: false,
    changed_files: [],
    verification_log_exists: false,
    result_json_valid: null,  // null = not checked (pass), false = checked+invalid (fail)
  };

  if (gitPath) {
    // Git status
    try {
      const stdout = execFileSync('git', ['status', '--porcelain'], {
        cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      const dirtyFiles = stdout.trim().split('\n').filter(Boolean).filter((line) => !isManagedGitStatusLine(line));
      evidence.git_status = dirtyFiles.length === 0 ? 'clean' : 'dirty';
      evidence.git_status_dirty_files = dirtyFiles.length > 0 ? dirtyFiles : [];
    } catch {
      evidence.git_status = 'unknown';
    }

    // Git diff summary
    try {
      const stdout = execFileSync('git', ['diff', '--stat'], {
        cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      evidence.git_diff_summary = stdout.trim() || '(no diff)';
    } catch {
      evidence.git_diff_summary = '(git diff failed)';
    }

    // Check for recent commits
    try {
      const stdout = execFileSync('git', ['log', '--oneline', '-1'], {
        cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      evidence.commit_exists = Boolean(stdout.trim());
    } catch {
      evidence.commit_exists = false;
    }

    // Changed files from git
    try {
      const stdout = execFileSync('git', ['diff', '--name-only', 'HEAD~1..HEAD', '--relative'], {
        cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      const files = stdout.trim().split('\n').filter(Boolean);
      if (files.length > 0) {
        evidence.changed_files = files;
      }
    } catch {
      // HEAD~1 might not exist; try diff against empty tree
    }
  }

  // Verification log
  if (verificationLogPath) {
    try {
      await access(verificationLogPath, constants.F_OK);
      evidence.verification_log_exists = true;
    } catch {
      evidence.verification_log_exists = false;
    }
  }

  // Result JSON validity
  if (resultJsonPath) {
    try {
      const content = await readFile(resultJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      evidence.result_json_valid = Boolean(parsed.status) && Boolean(parsed.summary);
      if (parsed.status) evidence.result_status = parsed.status;
      if (parsed.summary) evidence.result_summary = parsed.summary;
      if (Array.isArray(parsed.changed_files)) evidence.changed_files = parsed.changed_files;
      if (parsed.verification) evidence.verification = parsed.verification;
    } catch {
      evidence.result_json_valid = false;
    }
  }

  return evidence;
}

/**
 * Run the acceptance agent against a task result.
 *
 * @param {object} options
 * @param {object} options.task - Task object
 * @param {object} options.goal - Goal object
 * @param {object} options.result - Parsed result object from Codex
 * @param {string} options.repoPath - Path to the git repo
 * @param {string} [options.profile] - Acceptance profile name (default inferred)
 * @param {object} [options.evidence] - Pre-built evidence (built automatically if omitted)
 * @returns {Promise<{ passed: boolean, status: string, findings: Array, findings, repair_proposals: Array, next_tasks: Array, evidence: object }>}
 */
export async function runAcceptanceAgent({ task, goal, result, repoPath, profile, evidence: preBuiltEvidence } = {}) {
  // Build evidence if not provided
  const evidence = preBuiltEvidence || await buildEvidence({
    repoPath,
    worktreePath: task?.worktree_path,
    verificationLogPath: result?.verification_log_path,
    resultJsonPath: result?.result_json_path,
  });

  // Determine profile
  const activeProfile = profile || inferProfileFromTask(task, result);
  const profileConfig = getProfileChecks(activeProfile);

  const findings = [];

  // Run required checks
  for (const check of profileConfig.required) {
    const chkResult = await runCheck(check, { task, result, evidence, repoPath });
    if (chkResult) findings.push(chkResult);
    
  }

  // Run relaxed checks (only if they fail — don't add findings for passes)
  if (Array.isArray(profileConfig.relaxed)) {
    for (const check of profileConfig.relaxed) {
      const err = await runCheck(check, { task, result, evidence, repoPath });
      if (err && err.severity !== 'blocker') {
        // Downgrade relaxed check findings to minor
        findings.push({ ...err, severity: 'minor' });
      }
    }
  }

  const acceptance = evaluateAcceptance({ findings, needs_gpt_review: false });
  const reviewer = buildReviewerDecision({ result, findings });

  return {
    passed: acceptance.passed,
    status: acceptance.status,
    profile: activeProfile,
    findings,
    repair_proposals: acceptance.repair_proposals,
    next_tasks: acceptance.next_tasks,
    evidence,
    reviewer_decision: reviewer,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function inferProfileFromTask(task = {}, result = {}) {
  if (task.mode === 'deploy') return ACCEPTANCE_PROFILES.DEPLOY;
  if (result.noop === true || task.noop === true || task.mode === 'noop') return ACCEPTANCE_PROFILES.NOOP;

  const changed = Array.isArray(result.changed_files) ? result.changed_files :
    Array.isArray(task.changed_files) ? task.changed_files : [];
  const allDocs = changed.length > 0 && changed.every((f) => f.startsWith('docs/') || f.endsWith('.md'));
  if (allDocs) return ACCEPTANCE_PROFILES.DOCS_ONLY;

  const allConfig = changed.length > 0 && changed.every((f) =>
    f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml')
  );
  if (allConfig) return ACCEPTANCE_PROFILES.CONFIG_CHANGE;

  if (changed.length > 0) return ACCEPTANCE_PROFILES.CODE_CHANGE;
  return ACCEPTANCE_PROFILES.DEFAULT;
}

function getProfileChecks(profile) {
  const profiles = {
    default: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings'],
      relaxed: [],
    },
    code_change: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'tests_present', 'commit_or_patch_evidence',
        'changed_files_match_git'],
      relaxed: [],
    },
    docs_only: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'docs_paths_only'],
      relaxed: ['tests_present', 'verification_passed'],
    },
    config_change: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'commit_or_patch_evidence'],
      relaxed: ['tests_present'],
    },
    deploy: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'tests_present', 'commit_or_patch_evidence',
        'changed_files_match_git', 'safe_restart_evidence', 'post_restart_verification'],
      relaxed: [],
    },
    noop: {
      required: ['result_json_valid', 'summary_present', 'noop_reason_present'],
      relaxed: [],
    },
  };
  return profiles[profile] || profiles.default;
}

async function runCheck(check, { task, result, evidence, repoPath }) {
  switch (check) {
    case 'result_json_valid':
      // null = not checked (pass), false = checked and invalid (fail)
      if (evidence.result_json_valid === false) {
        return { severity: 'blocker', code: 'result_json_invalid', message: 'result.json is missing or invalid', source: 'acceptance_agent' };
      }
      return null;

    case 'summary_present':
      if (!evidence.result_summary && !result?.summary) {
        return { severity: 'blocker', code: 'summary_missing', message: 'Task summary is missing from result', source: 'acceptance_agent' };
      }
      return null;

    case 'changed_files_safe_paths':
      const files = evidence.changed_files || result?.changed_files || [];
      const unsafe = files.filter(f => f.startsWith('/') || f.startsWith('..') || f.includes('node_modules'));
      if (unsafe.length > 0) {
        return { severity: 'blocker', code: 'unsafe_changed_file_paths', message: `Unsafe changed file paths: ${unsafe.join(', ')}`, source: 'acceptance_agent' };
      }
      return null;

    case 'verification_present_for_non_noop':
      if (result?.noop === true) return null;
      // Tasks without changed files don't need verification (query/analysis/noop-like)
      const verify_changedFiles = evidence.changed_files || result?.changed_files || [];
      if (verify_changedFiles.length === 0) return null;
      if (!result?.verification?.commands?.length) {
        return { severity: 'major', code: 'verification_missing', message: 'Verification commands not present in result for non-noop task', source: 'acceptance_agent' };
      }
      return null;

    case 'verification_passed':
      if (result?.verification && result.verification.passed === false) {
        return { severity: 'blocker', code: 'verification_failed', message: 'Verification commands did not pass', source: 'acceptance_agent' };
      }
      return null;

    case 'worktree_clean':
      if (evidence.git_status === 'dirty') {
        return { severity: 'major', code: 'worktree_dirty', message: `Worktree has ${evidence.git_status_dirty_files?.length || 0} dirty file(s)`, source: 'acceptance_agent' };
      }
      return null;

    case 'no_blocker_or_major_findings':
      // Check result for existing findings
      if (Array.isArray(result?.acceptance_findings)) {
        const blockers = result.acceptance_findings.filter(f => f.severity === 'blocker' || f.severity === 'major');
        if (blockers.length > 0) {
          return { severity: 'blocker', code: 'existing_blocking_findings', message: `Task has ${blockers.length} existing blocker/major finding(s)`, source: 'acceptance_agent' };
        }
      }
      return null;

    case 'tests_present':
      if (!result?.tests && (!evidence.verification_log_exists)) {
        return { severity: 'major', code: 'tests_missing', message: 'No test evidence found for code change task', source: 'acceptance_agent' };
      }
      return null;

    case 'commit_or_patch_evidence':
      if (!evidence.commit_exists && !result?.commit && !result?.patch_evidence) {
        return { severity: 'major', code: 'commit_or_patch_missing', message: 'No commit or patch evidence for changed files', source: 'acceptance_agent' };
      }
      return null;

    case 'changed_files_match_git':
      const resultFiles = new Set((result?.changed_files || []).map(f => f.replace(/^\/+/, '')));
      const gitFiles = new Set((evidence.changed_files || []).map(f => f.replace(/^\/+/, '')));
      if (resultFiles.size > 0 && gitFiles.size > 0) {
        const missing = [...resultFiles].filter(f => !gitFiles.has(f));
        if (missing.length > 0) {
          return { severity: 'major', code: 'changed_files_mismatch', message: `Files in result not found in git diff: ${missing.join(', ')}`, source: 'acceptance_agent' };
        }
      }
      return null;

    case 'docs_paths_only':
      const allFiles = evidence.changed_files || result?.changed_files || [];
      const nonDocs = allFiles.filter(f => !f.startsWith('docs/') && !f.endsWith('.md') && !f.endsWith('.txt'));
      if (nonDocs.length > 0) {
        return { severity: 'blocker', code: 'non_docs_changed', message: `Non-documentation files changed in docs-only profile: ${nonDocs.join(', ')}`, source: 'acceptance_agent' };
      }
      return null;

    case 'safe_restart_evidence':
      if (!result?.restart_state && !result?.restart_verified_at) {
        return { severity: 'blocker', code: 'safe_restart_missing', message: 'Deploy task requires safe restart evidence', source: 'acceptance_agent' };
      }
      return null;

    case 'post_restart_verification':
      if (!result?.post_restart_verified) {
        return { severity: 'major', code: 'post_restart_verification_missing', message: 'Post-restart verification not confirmed', source: 'acceptance_agent' };
      }
      return null;

    case 'noop_reason_present':
      if (!result?.noop_reason && !result?.summary?.toLowerCase().includes('noop')) {
        return { severity: 'followup', code: 'noop_reason_missing', message: 'Noop tasks should include a reason', source: 'acceptance_agent' };
      }
      return null;

    default:
      return null;
  }
}

/**
 * Determine if the task result contains real code/config/runtime changes
 * that require integration. Returns false for noop, docs-only, or no changes.
 *
 * @param {object} options
 * @param {object} [options.acceptanceResult] - Result from runAcceptanceAgent
 * @param {object} [options.task] - Task object
 * @param {object} [options.result] - Parsed result from Codex
 * @returns {boolean}
 */
export function hasCodeOrConfigOrRuntimeChanges({ acceptanceResult, task, result } = {}) {
  const profile = acceptanceResult?.profile
    || (task ? inferProfileFromTask(task, result) : null);
  if (profile === ACCEPTANCE_PROFILES.NOOP || profile === ACCEPTANCE_PROFILES.DOCS_ONLY) {
    return false;
  }

  const changedFiles = acceptanceResult?.evidence?.changed_files
    || result?.changed_files
    || task?.changed_files
    || (task?.result?.changed_files)
    || [];

  if (changedFiles.length === 0) {
    return false;
  }

  // All non-docs, non-config-only changes count as real changes
  const allDocs = changedFiles.every(f => f.startsWith('docs/') || f.endsWith('.md'));
  const allConfig = changedFiles.every(f => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'));

  if (allDocs || allConfig) {
    return false;
  }
  return true;
}
