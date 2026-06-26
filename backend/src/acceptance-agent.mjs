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
  RUNTIME_CHANGE: 'runtime_change',
  SYNC_ONLY: 'sync_only',
  GITHUB_SYNC_ONLY: 'github_sync_only',
  NOOP: 'noop',
  REPAIR_NOOP: 'repair_noop',
  REPAIR_CODE_CHANGE: 'repair_code_change',
  VERIFICATION_ONLY: 'verification_only',
  NETWORK_RETRY: 'network_retry',
  INTEGRATION_ONLY: 'integration_only',
  DOCS_ONLY: 'docs_only',
  CONFIG_CHANGE: 'config_change',
  DEPLOY: 'deploy',
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
 * @param {string} [options.baseSha] - Base SHA for task-specific diff; uses `<baseSha>..HEAD` for commit evidence
 * @returns {Promise<object>} Evidence object
 */
export async function buildEvidence({ repoPath, worktreePath, verificationLogPath, resultJsonPath, baseSha } = {}) {
  const gitPath = worktreePath || repoPath;
  const evidence = {
    git_status: null,
    git_diff_summary: null,
   commit_exists: false,
   changed_files: [],
    git_changed_files: [],
    result_changed_files: [],
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

    // Determine diff range for task-scoped evidence
    // Use baseSha..HEAD when available; fall back to HEAD~1..HEAD for
    // backward compatibility when no baseSha is provided.
    const diffRange = baseSha ? `${baseSha}..HEAD` : 'HEAD~1..HEAD';

    // Check for task-specific commits using diff range
    // This prevents unrelated repo history from falsely satisfying commit_or_patch_evidence
    if (baseSha) {
      try {
        const stdout = execFileSync('git', ['rev-list', '--count', diffRange], {
          cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        });
        const count = parseInt(stdout.trim(), 10);
        evidence.commit_exists = count > 0;
      } catch {
        evidence.commit_exists = false;
      }
    } else {
      evidence.commit_exists = false;
    }

    // Changed files from git diff over the task-scoped range
    try {
      const stdout = execFileSync('git', ['diff', '--name-only', diffRange, '--relative'], {
        cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      const files = stdout.trim().split('\n').filter(Boolean);
      if (files.length > 0) {
        evidence.changed_files = files;
        evidence.git_changed_files = files;
      }
    } catch {
      // HEAD~1 might not exist on first commit; try diff against empty tree
      try {
        const stdout = execFileSync('git', ['diff', '--name-only', '4b825dc642cb6eb9a060e54bf899d1530366c0a', 'HEAD', '--relative'], {
          cwd: gitPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        });
        const files = stdout.trim().split('\n').filter(Boolean);
        if (files.length > 0) {
          evidence.changed_files = files;
          evidence.git_changed_files = files;
        }
      } catch {
        // If everything fails, leave changed_files empty
      }
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
      if (Array.isArray(parsed.changed_files)) evidence.result_changed_files = parsed.changed_files;
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
    baseSha: task?.worktree_lifecycle?.base_sha || result?.base_sha,
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
  // Check for explicit mode-based profiles
  if (task.mode === 'sync') return ACCEPTANCE_PROFILES.SYNC_ONLY;
  if (task.mode === 'github_sync') return ACCEPTANCE_PROFILES.GITHUB_SYNC_ONLY;
  if (task.mode === 'verification') return ACCEPTANCE_PROFILES.VERIFICATION_ONLY;
  if (task.mode === 'integration') return ACCEPTANCE_PROFILES.INTEGRATION_ONLY;
  if (task.mode === 'network_retry') return ACCEPTANCE_PROFILES.NETWORK_RETRY;
  if (task.mode === 'deploy') return ACCEPTANCE_PROFILES.DEPLOY;
  if (result.noop === true || task.noop === true || task.mode === 'noop') return ACCEPTANCE_PROFILES.NOOP;

  // Check for repair tasks
  if (task.parent_task_id || task.repair_of_task_id) {
    const changed = Array.isArray(result.changed_files) ? result.changed_files :
      Array.isArray(task.changed_files) ? task.changed_files : [];
    if (changed.length > 0) return ACCEPTANCE_PROFILES.REPAIR_CODE_CHANGE;
    return ACCEPTANCE_PROFILES.REPAIR_NOOP;
  }

  // Check for runtime change (deploy or runtime files)
  if (task.mode === 'runtime_change' || task.mode === 'runtime') return ACCEPTANCE_PROFILES.RUNTIME_CHANGE;

  const changed = Array.isArray(result.changed_files) ? result.changed_files :
    Array.isArray(task.changed_files) ? task.changed_files : [];

  // No changed files: return DEFAULT for backward compatibility
  // (default profile still checks verification and changed_files_match_git)
  // sync_only is only returned for explicit sync mode tasks
  if (changed.length === 0) return ACCEPTANCE_PROFILES.DEFAULT;

  const allDocs = changed.length > 0 && changed.every((f) => f.startsWith('docs/') || f.endsWith('.md'));
  if (allDocs) return ACCEPTANCE_PROFILES.DOCS_ONLY;

  const allConfig = changed.length > 0 && changed.every((f) =>
    f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml')
  );
  if (allConfig) return ACCEPTANCE_PROFILES.CONFIG_CHANGE;

  // Changed files with runtime/server paths (specific paths only)
  const runtimeFiles = changed.filter(f =>
    f.startsWith('backend/src/') ||
    f.includes('/worker') || f.includes('/runtime') || f.includes('/server') ||
    f.includes('codex-worker') || f.includes('gptwork-server')
  );
  if (runtimeFiles.length > 0 && (task.mode === 'deploy' || task.mode === 'runtime' || task.mode === 'runtime_change')) {
    return ACCEPTANCE_PROFILES.RUNTIME_CHANGE;
  }

  return ACCEPTANCE_PROFILES.CODE_CHANGE;
}

function getProfileChecks(profile) {
  // Profile contract definitions matching GOAL.md requirements:
  // sync_only: changed_files not required, tests not required, verification required
  // github_sync_only: changed_files not required, tests not required, verification required
  // verification_only: changed_files not required, tests not required, verification required
  // noop: changed_files not required, tests not required, verification optional
  // repair_noop: changed_files not required, tests not required, verification required
  // network_retry: changed_files not required, tests not required, verification optional
  // integration_only: changed_files optional, tests not required, verification required
  // runtime_change: changed_files required, tests required, verification required + restart check
  // repair_code_change: changed_files required, tests required, verification required
  // code_change: changed_files required, tests required, verification required
  // docs_only: changed_files required, tests relaxed
  // config_change: changed_files required, tests relaxed
  const profiles = {
    default: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'git_diff_check', 'commit_or_patch_evidence',
        'changed_files_match_git'],
      relaxed: [],
    },
    sync_only: {
      required: ['result_json_valid', 'summary_present',
        'worktree_clean', 'no_blocker_or_major_findings', 'git_diff_check'],
      relaxed: [],
    },
    github_sync_only: {
      required: ['result_json_valid', 'summary_present',
        'worktree_clean', 'no_blocker_or_major_findings'],
      relaxed: [],
    },
    verification_only: {
      required: ['result_json_valid', 'summary_present',
        'worktree_clean', 'no_blocker_or_major_findings',
        'verification_present_for_non_noop', 'verification_passed'],
      relaxed: [],
    },
    noop: {
      required: ['result_json_valid', 'summary_present', 'noop_reason_present'],
      relaxed: [],
    },
    repair_noop: {
      required: ['result_json_valid', 'summary_present',
        'worktree_clean', 'no_blocker_or_major_findings'],
      relaxed: ['tests_present', 'changed_files_match_git'],
    },
    repair_code_change: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'tests_present', 'commit_or_patch_evidence',
        'changed_files_match_git'],
      relaxed: [],
    },
    network_retry: {
      required: ['result_json_valid', 'summary_present'],
      relaxed: ['tests_present', 'verification_passed', 'changed_files_match_git'],
    },
    integration_only: {
      required: ['result_json_valid', 'summary_present',
        'worktree_clean', 'no_blocker_or_major_findings'],
      relaxed: [],
    },
    code_change: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'tests_present', 'commit_or_patch_evidence',
        'changed_files_match_git'],
      relaxed: [],
    },
    runtime_change: {
      required: ['result_json_valid', 'summary_present', 'changed_files_safe_paths',
        'verification_present_for_non_noop', 'verification_passed', 'worktree_clean',
        'no_blocker_or_major_findings', 'tests_present', 'commit_or_patch_evidence'],
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
      if (evidence.git_status === 'unknown' || evidence.git_status == null) {
        return { severity: 'major', code: 'worktree_clean_unknown', message: 'Unable to verify worktree cleanliness', source: 'acceptance_agent' };
      }
      return null;

    case 'no_blocker_or_major_findings':
      // Check result for existing findings
      if (Array.isArray(result?.acceptance_findings)) {
        const blockers = result.acceptance_findings.filter(f => (f.severity === 'blocker' || f.severity === 'major') && !f.resolved);
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
      // Only require commit/patch evidence when there are actual changed files
      const commitHasChangedFiles = (evidence.changed_files && evidence.changed_files.length > 0)
        || (result?.changed_files && result.changed_files.length > 0);
      if (commitHasChangedFiles && evidence.commit_exists !== true && !result?.commit && !result?.patch_evidence) {
        return { severity: 'major', code: 'commit_or_patch_missing', message: 'No commit or patch evidence for changed files', source: 'acceptance_agent' };
      }
      return null;

   case 'changed_files_match_git':
      // Use evidence.result_changed_files (from actual result.json parse) as primary
      // source. Only flag a mismatch when the result EXPLICITLY claims changed files
      // that disagree with git. When result doesn't claim any files, skip the check
      // to avoid false positives from repair/noop tasks where git shows parent-task
      // changes but the repair result didn't list changed_files.
      const resultHasExplicitFiles = evidence.result_changed_files && evidence.result_changed_files.length > 0;
      const resultFiles = new Set(
        (resultHasExplicitFiles ? evidence.result_changed_files : (result?.changed_files || [])).map(f => f.replace(/^\/+/, ''))
      );
      const gitFiles = new Set((evidence.git_changed_files || evidence.changed_files || []).map(f => f.replace(/^\/+/, '')));
      // Skip check if neither side has files — no changes to verify
      if (resultFiles.size === 0 && gitFiles.size === 0) return null;
      // P0: If result didn't claim any files, skip mismatch check even if git shows
      // changes. Prevents false positives for repair/noop tasks.
      if (resultFiles.size === 0 && gitFiles.size > 0) return null;
      if (resultFiles.size > 0 && gitFiles.size > 0) {
        const missing = [...resultFiles].filter(f => !gitFiles.has(f));
        const extra = [...gitFiles].filter(f => !resultFiles.has(f));
        if (missing.length > 0) {
          return { severity: 'major', code: 'changed_files_mismatch', message: `Files in result not found in git diff: ${missing.join(', ')}`, source: 'acceptance_agent' };
        }
        if (extra.length > 0) {
          return { severity: 'major', code: 'changed_files_extra_in_git', message: `Files in git diff not listed in result: ${extra.join(', ')}`, source: 'acceptance_agent' };
        }
      }
      // P0: If result claims files but git shows none, that's a real mismatch
      if (resultFiles.size > 0 && gitFiles.size === 0) {
        return { severity: 'major', code: 'changed_files_mismatch', message: `Result claims changed_files but git diff shows no changes: ${[...resultFiles].join(', ')}`, source: 'acceptance_agent' };
      }
      return null;

    case 'git_diff_check':
      // Check that git diff --check passes (no whitespace errors).
      // If the path is not a git repo, skip silently — the worktree_clean
      // check covers repo availability separately.
      if (repoPath) {
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: 'ignore' });
          execFileSync('git', ['diff', '--check'], { cwd: repoPath, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        } catch (err) {
          // Only report if git rev-parse succeeded (it's a git repo) but diff --check failed
          // If rev-parse failed, the path is not a git repo — skip silently
          if (err.message && err.message.includes('rev-parse')) {
            return null; // not a git repo, skip
          }
          const stderr = err.stderr?.toString()?.trim() || err.message || 'git diff --check failed';
          return { severity: 'blocker', code: 'git_diff_check_failed', message: `Git diff --check reported issues: ${stderr.slice(0, 500)}`, source: 'acceptance_agent' };
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
    // Only docs-only changes skip integration; config-only changes require it
    if (allDocs) return false;
 }
  return true;
}
