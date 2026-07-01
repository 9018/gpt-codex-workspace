import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readVerificationReport, isVerificationReportReusable } from './verification-report.mjs';
import { runLocalShell } from './workspace-service.mjs';
import { classifyNoChangeRepairOutcome } from './no-change-repair-classifier.mjs';

const AUTO_INTEGRATION_STATUSES = new Set(['branch_pushed', 'pr_opened']);
const BLOCKED_INTEGRATION_STATUSES = new Set(['conflict', 'check_failed', 'push_failed', 'pr_failed', 'locked']);
const REPAIRABLE_INTEGRATION_STATUSES = new Set(['conflict', 'check_failed', 'push_failed', 'pr_failed']);

function blocker(code, message, source = 'auto_integration_completion') {
  return { severity: 'blocker', code, message, source };
}

function tail(value, max = 4000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

function git(repoPath, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 30_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function gitOk(repoPath, args) {
  try {
    git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

function gitCapture(repoPath, args) {
  try {
    return { ok: true, stdout: git(repoPath, args), stderr: '', exit_code: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: tail(err?.stdout),
      stderr: tail(err?.stderr || err?.message),
      exit_code: typeof err?.status === 'number' ? err.status : 1,
      error: err?.message || String(err),
    };
  }
}

function currentHead(repoPath) {
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function repoClean(repoPath) {
  return git(repoPath, ['status', '--porcelain']) === '';
}

function hasBlockerFindings(taskResult = {}) {
  const findings = [
    ...(Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : []),
    ...(Array.isArray(taskResult.findings) ? taskResult.findings : []),
    ...(Array.isArray(taskResult.verification?.findings) ? taskResult.verification.findings : []),
  ];
  return findings.some((finding) => finding?.severity === 'blocker' && finding?.resolved !== true);
}

function acceptancePassed(taskResult = {}) {
  if (taskResult.reviewer_decision?.decision?.passed === true) return true;
  if (taskResult.reviewer_decision?.passed === true) return true;
  if (taskResult.verification?.passed === true && !hasBlockerFindings(taskResult)) return true;
  return false;
}

export function isIntegrationRepairableStatus(status) {
  return REPAIRABLE_INTEGRATION_STATUSES.has(status);
}

export function classifyIntegrationQueueResult(integrationResult = {}) {
  const status = integrationResult?.status || null;
  if (integrationResult?.ok === true) {
    if (integrationResult.merged === true || status === 'merged' || status === 'skipped') {
      return {
        kind: 'terminal_completed',
        task_status: 'completed',
        should_attempt_auto_completion: false,
        should_attempt_repair: false,
      };
    }
    if (AUTO_INTEGRATION_STATUSES.has(status) && integrationResult.merged !== true) {
      return {
        kind: 'auto_completion_candidate',
        task_status: null,
        should_attempt_auto_completion: true,
        should_attempt_repair: false,
      };
    }
    return {
      kind: 'requires_review',
      task_status: 'waiting_for_review',
      should_attempt_auto_completion: false,
      should_attempt_repair: false,
    };
  }
  if (isIntegrationRepairableStatus(status)) {
    return {
      kind: 'repairable_failure',
      task_status: null,
      should_attempt_auto_completion: false,
      should_attempt_repair: true,
    };
  }
  return {
    kind: 'waiting_for_integration',
    task_status: 'waiting_for_integration',
    should_attempt_auto_completion: false,
    should_attempt_repair: false,
  };
}

export function applySuccessfulAutoIntegrationCompletion({ taskResult = {}, integrationResult = {}, autoCompletion = {} } = {}) {
  const commit = autoCompletion.commit || taskResult.commit || integrationResult.commit || null;
  return {
    ...taskResult,
    integration: {
      ...integrationResult,
      status: 'merged',
      merged: true,
      auto_completed: true,
      commit,
    },
    commit: autoCompletion.commit || taskResult.commit || null,
    local_head: autoCompletion.commit || taskResult.local_head || null,
    repo_head: autoCompletion.commit || taskResult.repo_head || null,
    verification: autoIntegrationVerificationFromReport(autoCompletion),
    needs_integration: false,
    needs_restart_check: false,
  };
}

export function applyFailedAutoIntegrationCompletion({ taskResult = {}, autoCompletion = {} } = {}) {
  const findings = Array.isArray(taskResult.acceptance_findings) ? [...taskResult.acceptance_findings] : [];
  findings.push({
    severity: 'blocker',
    code: 'auto_integration_completion_failed',
    message: autoCompletion.blockers?.[0]?.message || autoCompletion.reason || 'Auto integration completion failed.',
    source: 'auto_integration_completion',
  });
  return {
    ...taskResult,
    reason: 'auto_integration_completion_failed: ' + (autoCompletion.reason || 'unknown'),
    requires_review: true,
    acceptance_findings: findings,
  };
}

function candidatePaths(resolvedRepo = {}) {
  const lifecycle = resolvedRepo.worktree_lifecycle || {};
  return {
    canonicalRepoPath: resolvedRepo.canonical_repo_path || null,
    taskWorktreePath: resolvedRepo.task_worktree_path || lifecycle.worktree_path || null,
    taskBranch: lifecycle.branch_name || resolvedRepo.task_branch || null,
    baseSha: lifecycle.base_sha || resolvedRepo.base_sha || null,
  };
}

export function analyzeAutoIntegrationCandidate({ task, taskResult = {}, resolvedRepo = {}, integrationResult = taskResult.integration || {} } = {}) {
  const blockers = [];
  const warnings = [];
  const status = integrationResult?.status || null;
  const { canonicalRepoPath, taskWorktreePath, taskBranch, baseSha } = candidatePaths(resolvedRepo);
  const changedFiles = Array.isArray(taskResult.changed_files) ? taskResult.changed_files.filter(Boolean) : [];
  const commit = taskResult.commit || integrationResult?.commit || taskResult.local_head || null;
  const noChangeRepair = classifyNoChangeRepairOutcome({ task, taskResult, integrationResult });
  const noChangeRepairEligible = noChangeRepair.completion_eligible === true;

  if (!integrationResult || integrationResult.ok !== true) {
    blockers.push(blocker('integration_not_successful', 'Integration result is not successful.'));
  }
  if (integrationResult?.merged === true || status === 'merged') {
    blockers.push(blocker('already_marked_merged', 'Integration is already marked merged; auto completion is unnecessary.'));
  } else if (!AUTO_INTEGRATION_STATUSES.has(status)) {
    blockers.push(blocker(BLOCKED_INTEGRATION_STATUSES.has(status) ? `integration_${status}` : 'integration_status_not_eligible', `Integration status ${status || 'unknown'} is not eligible for local auto completion.`));
  }
  if (!acceptancePassed(taskResult)) {
    blockers.push(blocker('acceptance_not_passed', 'Reviewer decision or verification has not passed.'));
  }
  if (hasBlockerFindings(taskResult)) {
    blockers.push(blocker('blocker_findings_present', 'Existing blocker findings prevent automatic completion.'));
  }
  if (changedFiles.length === 0 && !noChangeRepairEligible) {
    blockers.push(blocker('changed_files_missing', 'No changed_files evidence is present.'));
  }
  if ((!commit || commit === 'none') && !noChangeRepairEligible) {
    blockers.push(blocker('commit_missing', 'No task commit evidence is present.'));
  }
  if (!taskBranch && !noChangeRepairEligible) {
    blockers.push(blocker('task_branch_missing', 'Task branch evidence is missing.'));
  }
  if (resolvedRepo?.worktree_lifecycle?.mode !== 'git_worktree' && !noChangeRepairEligible) {
    blockers.push(blocker('worktree_mode_not_git_worktree', 'Auto completion requires git_worktree lifecycle mode.'));
  }
  if (!taskWorktreePath && !noChangeRepairEligible) {
    blockers.push(blocker('task_worktree_missing', 'Task worktree path is missing.'));
  }
  if (!canonicalRepoPath) {
    blockers.push(blocker('canonical_repo_missing', 'Canonical repo path is missing.'));
  }

  return {
    eligible: blockers.length === 0,
    reason: blockers.length === 0 ? 'eligible' : blockers[0].code,
    blockers,
    warnings,
    task_id: task?.id || null,
    goal_id: task?.goal_id || null,
    base_sha: baseSha,
    commit,
    task_branch: taskBranch,
    task_worktree_path: taskWorktreePath,
    canonical_repo_path: canonicalRepoPath,
    no_change_repair: noChangeRepair,
  };
}

function reportSummary(report) {
  return {
    passed: report?.passed === true,
    profile: report?.profile || report?.mode || null,
    requested_profile: report?.requested_profile || null,
    head: report?.repo?.head || null,
    dirty: report?.repo?.dirty ?? null,
    steps: Array.isArray(report?.steps) ? report.steps.length : 0,
    failures: Array.isArray(report?.failures) ? report.failures.length : 0,
  };
}

function buildReportPath({ config = {}, taskId, profile }) {
  const root = config.autoIntegrationReportDir
    || (config.defaultWorkspaceRoot ? join(config.defaultWorkspaceRoot, '.gptwork', 'reports') : join(process.cwd(), '.gptwork', 'reports'));
  return join(root, `auto-integration-${taskId || 'task'}-${profile}.json`);
}

async function runVerificationCommand({ command, cwd, timeoutMs, maxOutputBytes, runCommandFn }) {
  const started = Date.now();
  const runner = runCommandFn || runLocalShell;
  try {
    const result = await runner(command, cwd, timeoutMs, maxOutputBytes);
    return {
      cmd: command,
      cwd,
      exit_code: result?.returncode ?? result?.exit_code ?? 1,
      duration_ms: Date.now() - started,
      stdout_tail: tail(result?.stdout),
      stderr_tail: tail(result?.stderr),
    };
  } catch (err) {
    return {
      cmd: command,
      cwd,
      exit_code: typeof err?.status === 'number' ? err.status : 1,
      duration_ms: Date.now() - started,
      stdout_tail: tail(err?.stdout),
      stderr_tail: tail(err?.stderr || err?.message),
      error: err?.message || String(err),
    };
  }
}

async function verifyPostMerge({ config, taskId, baseSha, canonicalRepoPath, expectedHead, runCommandFn, evidence }) {
  const backendCwd = existsSync(join(canonicalRepoPath, 'backend')) ? join(canonicalRepoPath, 'backend') : canonicalRepoPath;
  const timeoutMs = config.autoIntegrationVerificationTimeout || config.resultRecoveryCommandTimeout || config.shellTimeout || 600_000;
  const maxOutputBytes = config.maxShellOutputBytes || 1_000_000;
  const attempts = [];

  const changedReportPath = buildReportPath({ config, taskId, profile: 'changed' });
  await mkdir(dirname(changedReportPath), { recursive: true }).catch(() => {});
  const changedCommand = `node scripts/release-delivery-check.mjs --profile changed --base ${baseSha || expectedHead} --json-report ${changedReportPath}`;
  const changedCommandResult = await runVerificationCommand({ command: changedCommand, cwd: backendCwd, timeoutMs, maxOutputBytes, runCommandFn });
  evidence.commands.push(changedCommandResult);
  attempts.push({ profile: 'changed', reportPath: changedReportPath, command: changedCommandResult });

  let selected = await validateVerificationReport({ reportPath: changedReportPath, expectedHead, profile: 'changed' });
  if (changedCommandResult.exit_code === 0 && selected.ok) {
    return { ...selected, path: changedReportPath, attempts };
  }

  evidence.warnings.push('changed_profile_verification_failed; fell back to fast profile');
  const fastReportPath = buildReportPath({ config, taskId, profile: 'fast' });
  await mkdir(dirname(fastReportPath), { recursive: true }).catch(() => {});
  const fastCommand = `node scripts/release-delivery-check.mjs --fast --json-report ${fastReportPath}`;
  const fastCommandResult = await runVerificationCommand({ command: fastCommand, cwd: backendCwd, timeoutMs, maxOutputBytes, runCommandFn });
  evidence.commands.push(fastCommandResult);
  attempts.push({ profile: 'fast', reportPath: fastReportPath, command: fastCommandResult });

  selected = await validateVerificationReport({ reportPath: fastReportPath, expectedHead, profile: 'fast' });
  return { ...selected, path: fastReportPath, attempts };
}

async function validateVerificationReport({ reportPath, expectedHead, profile }) {
  let report = null;
  try {
    report = await readVerificationReport(reportPath);
  } catch (err) {
    return { ok: false, reason: 'report_unreadable', error: err?.message || String(err), report: null, validation: { reusable: false, reason: 'report_unreadable' } };
  }
  const validation = isVerificationReportReusable(report, {
    repoHead: expectedHead,
    profile,
    maxAgeMs: null,
  });
  return { ok: validation.reusable === true, reason: validation.reason, report, validation };
}

export async function runAutoIntegrationCompletion({ task, goal, taskResult = {}, resolvedRepo = {}, integrationResult = taskResult.integration || {}, config = {}, runCommandFn } = {}) {
  const started = Date.now();
  const candidate = analyzeAutoIntegrationCandidate({ task, taskResult, resolvedRepo, integrationResult });
  const evidence = {
    attempted: true,
    eligible: candidate.eligible,
    completed: false,
    reason: candidate.reason,
    blockers: [...candidate.blockers],
    warnings: [...candidate.warnings],
    task_id: task?.id || null,
    goal_id: goal?.id || task?.goal_id || null,
    base_sha: candidate.base_sha,
    commit: candidate.commit,
    task_branch: candidate.task_branch,
    task_worktree_path: candidate.task_worktree_path,
    canonical_repo_path: candidate.canonical_repo_path,
    canonical_clean_before: null,
    canonical_clean_after: null,
    merge: { mode: 'ff_only', attempted: false, merged: false, commit: candidate.commit || null },
    verification_report_path: null,
    verification_report: null,
    verification_report_validation: null,
    commands: [],
    duration_ms: 0,
    no_change_repair: candidate.no_change_repair || null,
  };

  try {
    if (!candidate.eligible) return evidence;

    if (!existsSync(candidate.canonical_repo_path)) {
      evidence.reason = 'canonical_repo_missing';
      evidence.blockers.push(blocker('canonical_repo_missing', 'Canonical repo path does not exist.'));
      return evidence;
    }
    if (candidate.no_change_repair?.completion_eligible !== true && !existsSync(candidate.task_worktree_path)) {
      evidence.reason = 'task_worktree_missing';
      evidence.blockers.push(blocker('task_worktree_missing', 'Task worktree path does not exist.'));
      return evidence;
    }

    evidence.canonical_clean_before = repoClean(candidate.canonical_repo_path);
    if (!evidence.canonical_clean_before) {
      evidence.reason = 'canonical_dirty';
      evidence.blockers.push(blocker('canonical_dirty', 'Canonical repo is dirty before auto integration.'));
      return evidence;
    }

    if (candidate.no_change_repair?.completion_eligible === true) {
      evidence.canonical_clean_before = repoClean(candidate.canonical_repo_path);
      if (!evidence.canonical_clean_before) {
        evidence.reason = 'canonical_dirty';
        evidence.blockers.push(blocker('canonical_dirty', 'Canonical repo is dirty before no-change repair completion.'));
        return evidence;
      }
      evidence.canonical_clean_after = evidence.canonical_clean_before;
      const canonicalHead = currentHead(candidate.canonical_repo_path);
      evidence.commit = candidate.commit || canonicalHead;
      evidence.merge = {
        ...evidence.merge,
        attempted: false,
        merged: true,
        skipped: true,
        already_integrated: true,
        no_change_repair: true,
        commit: candidate.commit || canonicalHead,
      };
      evidence.verification_report = {
        passed: true,
        profile: taskResult.verification?.profile || taskResult.acceptance_profile || 'repair_noop',
        requested_profile: taskResult.verification?.requested_profile || null,
        head: taskResult.verification?.head || canonicalHead,
        dirty: false,
        steps: Array.isArray(taskResult.verification?.commands) ? taskResult.verification.commands.length : 0,
        failures: 0,
      };
      evidence.completed = true;
      evidence.eligible = true;
      evidence.reason = 'no_change_repair_already_integrated_and_verified';
      return evidence;
    }

    const worktreeClean = repoClean(candidate.task_worktree_path);
    if (!worktreeClean && taskResult.delivery_result_recovery?.recovered !== true) {
      evidence.reason = 'task_worktree_dirty';
      evidence.blockers.push(blocker('task_worktree_dirty', 'Task worktree is dirty and was not recovered.'));
      return evidence;
    }

    const commitExists = gitOk(candidate.canonical_repo_path, ['cat-file', '-e', `${candidate.commit}^{commit}`])
      || gitOk(candidate.task_worktree_path, ['cat-file', '-e', `${candidate.commit}^{commit}`]);
    if (!commitExists) {
      evidence.reason = 'commit_missing';
      evidence.blockers.push(blocker('commit_missing', `Task commit ${candidate.commit} does not exist.`));
      return evidence;
    }
    const taskBranchExists = gitOk(candidate.canonical_repo_path, ['show-ref', '--verify', `refs/heads/${candidate.task_branch}`])
      || gitOk(candidate.task_worktree_path, ['show-ref', '--verify', `refs/heads/${candidate.task_branch}`]);
    if (!taskBranchExists) {
      evidence.reason = 'task_branch_missing';
      evidence.blockers.push(blocker('task_branch_missing', `Task branch ${candidate.task_branch} does not exist.`));
      return evidence;
    }

    const canonicalHeadBefore = currentHead(candidate.canonical_repo_path);
    evidence.base_sha = evidence.base_sha || canonicalHeadBefore;
    const alreadyIntegrated = candidate.commit === canonicalHeadBefore
      || gitOk(candidate.canonical_repo_path, ['merge-base', '--is-ancestor', candidate.commit, canonicalHeadBefore]);

    if (alreadyIntegrated) {
      evidence.merge = { ...evidence.merge, skipped: true, merged: true, already_integrated: true };
    } else {
      evidence.merge.attempted = true;
      const merge = gitCapture(candidate.canonical_repo_path, ['merge', '--ff-only', candidate.commit]);
      evidence.commands.push({ cmd: `git merge --ff-only ${candidate.commit}`, cwd: candidate.canonical_repo_path, exit_code: merge.exit_code, stdout_tail: merge.stdout, stderr_tail: merge.stderr });
      if (!merge.ok) {
        evidence.reason = 'ff_only_merge_failed';
        evidence.blockers.push(blocker('ff_only_merge_failed', merge.stderr || merge.error || 'git merge --ff-only failed.'));
        evidence.canonical_clean_after = repoClean(candidate.canonical_repo_path);
        return evidence;
      }
      evidence.merge.merged = true;
    }

    const canonicalHeadAfterMerge = currentHead(candidate.canonical_repo_path);
    evidence.commit = canonicalHeadAfterMerge;
    evidence.merge.commit = canonicalHeadAfterMerge;

    const verification = await verifyPostMerge({
      config,
      taskId: task?.id,
      baseSha: evidence.base_sha,
      canonicalRepoPath: candidate.canonical_repo_path,
      expectedHead: canonicalHeadAfterMerge,
      runCommandFn,
      evidence,
    });
    evidence.verification_report_path = verification.path;
    evidence.verification_report = reportSummary(verification.report);
    evidence.verification_report_validation = verification.validation;

    evidence.canonical_clean_after = repoClean(candidate.canonical_repo_path);
    if (!verification.ok || evidence.verification_report?.passed !== true || evidence.verification_report?.head !== canonicalHeadAfterMerge || evidence.verification_report?.dirty !== false || !evidence.canonical_clean_after) {
      evidence.reason = 'post_merge_verification_failed';
      evidence.merged_but_verification_failed = true;
      evidence.blockers.push(blocker('post_merge_verification_failed', `Post-merge verification failed: ${verification.reason || 'unknown'}.`));
      return evidence;
    }

    evidence.completed = true;
    evidence.eligible = true;
    evidence.reason = alreadyIntegrated ? 'already_integrated_and_verified' : 'ff_only_merged_and_verified';
    return evidence;
  } finally {
    evidence.duration_ms = Date.now() - started;
  }
}

export function autoIntegrationVerificationFromReport(autoCompletion = {}) {
  const report = autoCompletion.verification_report || null;
  return {
    passed: autoCompletion.completed === true && report?.passed === true,
    status: autoCompletion.completed === true && report?.passed === true ? 'completed' : 'waiting_for_review',
    source: 'auto_integration_completion',
    report_path: autoCompletion.verification_report_path || null,
    profile: report?.profile || null,
    head: report?.head || null,
    dirty: report?.dirty ?? null,
    commands: Array.isArray(autoCompletion.commands) ? autoCompletion.commands : [],
    findings: autoCompletion.completed === true ? [] : (Array.isArray(autoCompletion.blockers) ? autoCompletion.blockers : []),
  };
}
