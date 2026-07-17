import { realpath, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { selectWorkspace } from "./auth-context.mjs";
import { goalWorkspaceFiles } from "./goal-files.mjs";
import { acquireRepoLock, releaseLockForTask } from "./repo-lock.mjs";
import { buildTaskResult } from "./codex-result-parser.mjs";
import { prepareCodexTaskRun } from "./task-run-setup.mjs";
import { executeCodexTaskRun } from "./task-codex-execution.mjs";
import { finalizeCodexTaskRun } from "./task-final-writeback.mjs";
import { applyAutonomyValidation, applyRuntimeCodeChangeGuard, classifyResultContractFindings, deriveTaskStatusFromTaskResult, isP0TaskTitle, validateResultContract } from "./task-result-status.mjs";
import { updateTask } from "./task-lifecycle.mjs";
import { appendGoalMessage, ensureTaskGoal } from "./goal-task-lifecycle.mjs";
import { resolveTaskRepositoryPlan as _resolveTaskRepositoryPlan, materializeTaskWorktree as _materializeTaskWorktree } from "./task-repo-resolution.mjs";
import { buildReviewerDecision } from "./acceptance-policy.mjs";
import { runAcceptanceAgent, ACCEPTANCE_PROFILES, hasCodeOrConfigOrRuntimeChanges } from './acceptance-agent.mjs';
import { createRepairGoalFromFindings, shouldAttemptRepair } from './repair-loop.mjs';
import { runIntegrationQueue } from './integration-queue.mjs';
import { createGoal } from './goal-task-goals.mjs';
import { determineHealingAction } from './self-healing-policy.mjs';
import { classifyFailure, failureClassIsTerminalNonRepairable } from './failure-classifier.mjs';
import { sanitizeTaskBranchName } from './task-worktree-manager.mjs';
import { convergeTaskAfterRun, detectAcceptanceProfile } from "./task-convergence.mjs";
import { isCodexTuiEnabled, taskUsesCodexTuiGoal, CODEX_EXECUTION_PROVIDERS } from "./codex-execution-provider.mjs";
import { startCodexTuiGoalSession, stopCodexTuiSession } from "./codex-tui-session-manager.mjs";
import { runCodexTuiEvidenceCycle } from "./codex-tui-evidence-cycle.mjs";
import { analyzeDeliveryRecoveryCandidate, runDeliveryRecovery } from "./delivery-result-recovery.mjs";
import { applyFailedAutoIntegrationCompletion, applySuccessfulAutoIntegrationCompletion, classifyIntegrationQueueResult, runAutoIntegrationCompletion } from "./auto-integration-completion.mjs";
import { executeAgentBackendRun, resolveAgentBackendId } from "./agent-execution-backends.mjs";
import { writeBuilderAgentRun, writeIntegratorAgentRun, writeContextCuratorAgentRun, writeVerifierAgentRun, writeReviewerAgentRun, writeFinalizerAgentRun, writePlannerAgentRun, completeQueuedAgentRuns, skipDownstreamAgentRunsForBlocker } from "./agent-run-writeback.mjs";
import { applyPipelineGateBeforeClosure, ensurePipelineRunsForTask, isLegacyTask } from "./pipeline-orchestration.mjs";
import { syncAgentRunProgress } from "./subagent-progress-bridge.mjs";
import { resolvePathContext } from "./path-context/path-context-resolver.mjs";
import { dispatchTaskProvider } from "./task-processing/task-provider-dispatcher.mjs";

const RETRY_HEALING_ACTIONS = new Set([
  "retry_with_backoff",
  "cleanup_and_retry",
  "compact_and_retry",
  "reconcile_lock_and_retry",
  "recover_and_retry",
  "fallback_parse_and_retry",
]);

function recordAgentRunWritebackFailure(taskResult, role, err) {
  if (!taskResult || typeof taskResult !== "object") return;
  const message = String(err?.message || err || "agent run writeback failed").slice(0, 500);
  taskResult.agent_run_writeback = Array.isArray(taskResult.agent_run_writeback) ? taskResult.agent_run_writeback : [];
  taskResult.agent_run_writeback.push({ role, status: "failed", reason: message });
  taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
  taskResult.warnings.push({ code: "agent_run_writeback_failed", role, severity: "warning", message });
}

function applyRepairMetadata(args = {}, repairGoal = {}) {
  for (const key of [
    "root_task_id",
    "parent_task_id",
    "repair_attempt",
    "max_attempts",
    "repair_of_goal_id",
    "repair_of_task_id",
    "repair_of_worktree",
    "repair_of_branch",
  ]) {
    if (repairGoal[key] !== undefined) args[key] = repairGoal[key];
  }
  return args;
}

function statusForHealingAction(action) {
  if (action === "waiting_for_review") return "waiting_for_review";
  if (RETRY_HEALING_ACTIONS.has(action)) return "queued";
  return "waiting_for_review";
}

function isVerifiedNoChangeResult(result = {}) {
  const nonMutatingOps = ['readonly_validation', 'noop', 'already_integrated', 'diagnostic'];
  if (nonMutatingOps.includes(result.operation_kind)) {
    return result?.status === "completed";
  }
  return result?.status === "completed"
    && Array.isArray(result.changed_files)
    && result.changed_files.length === 0
    && !result.commit
    && result.verification?.passed === true;
}

function applyLegacyNoChangeCompatibility(result = {}) {
  if (!isVerifiedNoChangeResult(result)) return result;
  const nonMutatingOps = ['readonly_validation', 'noop', 'already_integrated', 'diagnostic'];
  if (nonMutatingOps.includes(result.operation_kind)) {
    // Already correctly typed as non-mutating; just set evidence defaults
    result.no_mutation = result.no_mutation === true ? true : true;
    result.repo_mutated = result.repo_mutated === false ? false : false;
    return result;
  }
  result.noop = result.noop === true ? true : true;
  result.noop_reason = result.noop_reason || "No changed files were reported and verification passed.";
  result.operation_kind = result.operation_kind || "noop";
  result.no_mutation = result.no_mutation === true ? true : true;
  result.repo_mutated = result.repo_mutated === false ? false : false;
  return result;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeCommitEvidence(value) {
  if (value === undefined || value === null) return "none";
  const commit = String(value).trim();
  return commit && commit !== "null" ? commit : "none";
}

function normalizeTuiVerification({ resultJson, snapshot, findings, status, tests }) {
  const rawVerification = asPlainObject(resultJson.verification);
  const commands = Array.isArray(rawVerification.commands)
    ? rawVerification.commands
    : (tests && tests !== "none" ? [{ cmd: String(tests), exit_code: 0, passed: true }] : []);
  const hasBlockingFinding = findings.some((finding) => ["blocker", "major"].includes(finding?.severity));
  const worktreeClean = snapshot.worktree_clean !== false;
  const hasPassingEvidence = rawVerification.passed === true
    || (rawVerification.passed !== false && status === "completed" && commands.length > 0);
  const passed = hasPassingEvidence && !hasBlockingFinding && worktreeClean;
  return {
    ...rawVerification,
    passed,
    commands,
    findings,
  };
}

export function normalizeTuiEvidenceToTaskResult(collected, task = {}, goal = {}, session = {}) {
  const cycle = asPlainObject(collected);
  const snapshot = asPlainObject(cycle.collected || cycle.completion || {});
  const resultJson = asPlainObject(cycle.result_json || snapshot.result_json);
  const findings = [
    ...asList(resultJson.acceptance_findings),
    ...asList(resultJson.findings),
    ...asList(snapshot.findings),
    cycle.finding,
  ].filter(Boolean);
  const changedFiles = asList(resultJson.changed_files).length > 0
    ? asList(resultJson.changed_files)
    : asList(snapshot.changed_files);
  const commit = normalizeCommitEvidence(resultJson.commit ?? snapshot.commit);
  const verificationCommands = Array.isArray(resultJson.verification?.commands)
    ? resultJson.verification.commands
    : [];
  const tests = resultJson.tests
    || snapshot.tests
    || (verificationCommands.length > 0 ? verificationCommands.map((command) => command.cmd || command.command || String(command)).join("; ") : null);
  const status = ["completed", "failed", "timed_out"].includes(resultJson.status)
    ? resultJson.status
    : "completed";
  const verification = normalizeTuiVerification({ resultJson, snapshot, findings, status, tests });
  const operationKind = resultJson.operation_kind
    || (changedFiles.length > 0 ? "code_change" : "diagnostic");
  const integrationNotRequired = resultJson.integration_not_required ?? (changedFiles.length === 0);

  return {
    ...resultJson,
    kind: status === "timed_out" ? "codex_timeout" : status === "failed" ? "codex_failed" : "codex_executed",
    status,
    structured: true,
    from_json: true,
    summary: resultJson.summary || snapshot.summary || `Codex TUI session ${session.id || cycle.session_id || "unknown"} completed`,
    changed_files: changedFiles,
    tests: tests || null,
    commit,
    remote_head: resultJson.remote_head || "none",
    warnings: asList(resultJson.warnings),
    followups: asList(resultJson.followups),
    acceptance_findings: findings,
    verification,
    operation_kind: operationKind,
    integration_not_required: integrationNotRequired,
    integration: asPlainObject(resultJson.integration),
    provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    codex_execution_provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    execution_backend: "codex_tui_superpowers",
    execution_backend_role: "operator",
    session_id: session.id || cycle.session_id || snapshot.session_id || null,
    tui_phase: "evidence_ready",
    result_json_path: snapshot.result_json_path || resultJson.result_json_path || null,
    result_md_present: snapshot.result_md_present === true || resultJson.result_md_present === true,
    worktree_clean: snapshot.worktree_clean !== false,
    completed_at: resultJson.completed_at || new Date().toISOString(),
  };
}

async function parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error, healingAction, prefix }) {
  const status = statusForHealingAction(healingAction.action);
  const retryCount = RETRY_HEALING_ACTIONS.has(healingAction.action) ? (task.healing_retry_count || 0) + 1 : (task.healing_retry_count || 0);
  const summary = `${prefix}: ${error?.message || String(error || "unknown error")}`;
  if (repoLockPath) {
    try { await releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id); } catch {}
  }
  await updateTaskFn(store, task.id, (item) => {
    item.status = status;
    if (RETRY_HEALING_ACTIONS.has(healingAction.action)) item.healing_retry_count = retryCount;
    item.result = {
      kind: "operational_error",
      summary,
      completed_at: new Date().toISOString(),
      error_code: error?.code || null,
      healing_action: healingAction.action,
      healing_retry_count: retryCount,
      retry_budget: healingAction.retry_budget ?? null,
      reason: healingAction.reason || summary,
    };
    item.logs.push({ time: new Date().toISOString(), message: summary });
    item.logs.push({ time: new Date().toISOString(), message: `[worker] self-healing ${healingAction.action}: status=${status} retry=${retryCount} reason=${healingAction.reason || "none"}` });
  });
  if (goal) {
    try {
      await appendGoalMessageFn(store, config, {
        goal_id: goal.id,
        role: "codex",
        content: summary + " (healing: " + healingAction.action + ")",
      }, context);
    } catch {}
  }
  return { task_id: task.id, status, kind: "operational_error", reason: summary, healing_action: healingAction.action, healing_retry_count: retryCount };
}

function gitOutput(repoPath, args) {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
}

function shortSha(value) {
  return typeof value === "string" && value.length >= 7 ? value.slice(0, 7) : value;
}

function commandListFromConfig(config = {}) {
  if (Array.isArray(config.deliveryResultRecoveryCommands)) return config.deliveryResultRecoveryCommands;
  if (Array.isArray(config.resultRecoveryVerificationCommands)) return config.resultRecoveryVerificationCommands;
  return [];
}

function recoveryCommandListFromConfig(config = {}) {
  if (Array.isArray(config.deliveryResultRecoveryCommands) && config.deliveryResultRecoveryCommands.length > 0) return config.deliveryResultRecoveryCommands;
  if (Array.isArray(config.resultRecoveryVerificationCommands) && config.resultRecoveryVerificationCommands.length > 0) return config.resultRecoveryVerificationCommands;
  if (Array.isArray(config.integrationCheckCommands) && config.integrationCheckCommands.length > 0) return config.integrationCheckCommands;
  return null;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.length > 0))];
}

function clearResolvedDeliveryFindings(findings = []) {
  const resolvedCodes = new Set(["commit_missing", "dirty_worktree_after_codex"]);
  return findings.map((finding) => resolvedCodes.has(finding?.code)
    ? { ...finding, severity: "followup", resolved: true, message: (finding.message || finding.code) + " (resolved by delivery_result_recovery)" }
    : finding);
}

function applySuccessfulDeliveryRecovery(taskResult, recovery, summary) {
  const recoveredSummary = recovery.summary || summary || taskResult.summary || "Recovered Codex delivery result from dirty worktree.";
  // P0-MA11-R1: For already_integrated recovery, preserve the original commit
  // and integration status rather than overwriting with a new recovery merge.
  if (recovery.reason === "already_integrated") {
    const alreadyIntegrated = {
      ...taskResult,
      kind: "codex_executed",
      summary: recoveredSummary,
      commit: recovery.commit || taskResult.commit,
      local_head: recovery.local_head || taskResult.local_head,
      remote_head: recovery.remote_head || taskResult.remote_head,
      tests: recovery.tests || taskResult.tests,
      verification: recovery.verification || taskResult.verification,
      integration: { ...(taskResult.integration || {}), ...(recovery.integration || {}), status: "already_integrated", merged: true, required: false },
      delivery_result_recovery: recovery,
      reviewer_decision: { ...(taskResult.reviewer_decision || {}), status: "accepted", passed: true },
      acceptance_findings: clearResolvedDeliveryFindings(taskResult.acceptance_findings || []),
      warnings: Array.isArray(taskResult.warnings) ? [...taskResult.warnings, "Delivery already integrated: " + (recovery.warnings?.[0] || "no staged changes needed")] : (taskResult.warnings || []),
      followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
      failure_class: null,
      convergence: { ...(taskResult.convergence || {}), nextStatus: "completed", closureReason: "already_integrated" },
    };
    if (Array.isArray(recovery.warnings)) {
      alreadyIntegrated.warnings = uniqueStrings([...alreadyIntegrated.warnings, ...recovery.warnings]);
    } else {
      alreadyIntegrated.warnings = uniqueStrings(alreadyIntegrated.warnings);
    }
    return alreadyIntegrated;
  }
  return {
    ...taskResult,
    kind: "codex_executed",
    summary: recoveredSummary,
    changed_files: Array.isArray(recovery.changed_files) ? recovery.changed_files : (Array.isArray(taskResult.changed_files) ? taskResult.changed_files : []),
    tests: recovery.tests || taskResult.tests || "delivery recovery verification passed",
    commit: recovery.commit,
    local_head: recovery.local_head,
    remote_head: recovery.remote_head,
    verification: recovery.verification,
    integration: { ...(taskResult.integration || {}), ...(recovery.integration || {}), status: "merged", merged: true },
    delivery_result_recovery: recovery,
    reviewer_decision: { ...(taskResult.reviewer_decision || {}), status: "accepted", passed: true },
    acceptance_findings: clearResolvedDeliveryFindings(taskResult.acceptance_findings || []),
    warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
    followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
    failure_class: null,
    convergence: { ...(taskResult.convergence || {}), nextStatus: "completed", closureReason: "delivery_result_recovery" },
  };
}

async function isDirectory(path) {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function verifyRealTaskWorktree({ resolvedRepo, plan }) {
  const worktreePath = resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path;
  const canonicalRepoPath = resolvedRepo?.canonical_repo_path || plan?.canonical_repo_path;
  const lifecycle = resolvedRepo?.worktree_lifecycle;
  if (lifecycle?.ok !== true || lifecycle?.mode !== "git_worktree") {
    return { valid: false, error: lifecycle?.error || "task worktree lifecycle is not verified git_worktree" };
  }
  if (!(await isDirectory(worktreePath))) {
    return { valid: false, error: `expected task worktree is unavailable: ${worktreePath || "missing task_worktree_path"}` };
  }
  if (!canonicalRepoPath) {
    return { valid: false, error: "canonical repository path is unavailable for worktree verification" };
  }

  try {
    const worktreeTop = await realpath(gitOutput(worktreePath, ["rev-parse", "--show-toplevel"]));
    const canonicalTop = await realpath(gitOutput(canonicalRepoPath, ["rev-parse", "--show-toplevel"]));
    const worktreeGitDir = await realpath(resolve(worktreeTop, gitOutput(worktreePath, ["rev-parse", "--git-dir"])));
    const worktreeCommonDir = await realpath(resolve(worktreeTop, gitOutput(worktreePath, ["rev-parse", "--git-common-dir"])));
    const canonicalCommonDir = await realpath(resolve(canonicalTop, gitOutput(canonicalRepoPath, ["rev-parse", "--git-common-dir"])));
    if (worktreeTop === canonicalTop) {
      return { valid: false, error: "task worktree resolves to the canonical repository" };
    }
    if (worktreeGitDir === worktreeCommonDir || worktreeCommonDir !== canonicalCommonDir) {
      return { valid: false, error: "task path is not a linked worktree of the canonical repository" };
    }
    return {
      valid: true,
      worktree_top: worktreeTop,
      canonical_top: canonicalTop,
      common_git_dir: worktreeCommonDir,
    };
  } catch (err) {
    return { valid: false, error: `task worktree git verification failed: ${err?.message || String(err)}` };
  }
}

async function buildDeliveryResultRecoveryEvidence({ config, taskResult, resolvedRepo, cr, runCommandFn }) {
  if (!resolvedRepo?.canonical_repo_path || !resolvedRepo?.task_worktree_path) return null;
  const exitCode = cr?.returncode ?? null;
  const isMissingResultFailure = taskResult?.failure_class === "result_missing" || taskResult?.kind === "codex_failed";
  if (!isMissingResultFailure || exitCode === 0) return null;

  let worktreeCommit = null;
  let localHead = null;
  let remoteHead = null;
  let canonicalClean = false;
  let commitIntegrated = false;
  try {
    worktreeCommit = gitOutput(resolvedRepo.task_worktree_path, ["rev-parse", "HEAD"]);
    localHead = gitOutput(resolvedRepo.canonical_repo_path, ["rev-parse", "HEAD"]);
    remoteHead = gitOutput(resolvedRepo.canonical_repo_path, ["rev-parse", "origin/" + (config.defaultBranch || "main")]);
    canonicalClean = gitOutput(resolvedRepo.canonical_repo_path, ["status", "--short"]) === "";
    commitIntegrated = worktreeCommit === localHead || worktreeCommit === remoteHead;
    if (!commitIntegrated) {
      try {
        gitOutput(resolvedRepo.canonical_repo_path, ["merge-base", "--is-ancestor", worktreeCommit, localHead]);
        commitIntegrated = true;
      } catch {}
    }
  } catch {
    return null;
  }

  const commandsToRun = commandListFromConfig(config);
  if (!canonicalClean || !commitIntegrated || !commandsToRun.length) {
    return {
      reason: "result_missing_but_verified_commit",
      canonical_clean: canonicalClean,
      commit_integrated: commitIntegrated,
      commit: localHead,
      local_head: localHead,
      remote_head: remoteHead,
      worktree_commit: worktreeCommit,
      verification: { passed: false, commands: [], reason: commandsToRun.length ? null : "no recovery verification commands configured" },
      passed: false,
    };
  }

  const commands = [];
  for (const cmd of commandsToRun) {
    const started = Date.now();
    const result = await runCommandFn(cmd, resolvedRepo.canonical_repo_path, config.resultRecoveryCommandTimeout || config.shellTimeout || 600_000, config.maxShellOutputBytes || 1_000_000);
    commands.push({
      cmd,
      exit_code: result?.returncode ?? 1,
      duration_ms: Date.now() - started,
      stdout_tail: typeof result?.stdout === "string" ? result.stdout.slice(-4000) : "",
      stderr_tail: typeof result?.stderr === "string" ? result.stderr.slice(-4000) : "",
    });
  }
  const verificationPassed = commands.length > 0 && commands.every((command) => command.exit_code === 0);
  return {
    reason: "result_missing_but_verified_commit",
    canonical_clean: canonicalClean,
    commit_integrated: commitIntegrated,
    commit: localHead,
    local_head: localHead,
    remote_head: remoteHead,
    worktree_commit: worktreeCommit,
    summary: `Recovered missing delivery result: worktree ${shortSha(worktreeCommit)} integrated into canonical ${shortSha(localHead)} and verification passed.`,
    tests: verificationPassed ? `${commands.length} recovery verification command(s) passed` : `${commands.filter((command) => command.exit_code !== 0).length} recovery verification command(s) failed`,
    verification: { passed: verificationPassed, commands },
    passed: verificationPassed,
  };
}

function taskWithRepairContext(task, resolvedRepo) {
  return {
    ...task,
    worktree_path: task.worktree_path || resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path || null,
    worktree: task.worktree || {
      path: resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path || null,
      branch: resolvedRepo?.worktree_lifecycle?.branch_name || resolvedRepo?.task_branch || null,
    },
    repo_id: task.repo_id || resolvedRepo?.repo_id || null,
    result: {
      ...(task.result || {}),
      repo_resolution: resolvedRepo || task.result?.repo_resolution || null,
      worktree_lifecycle: resolvedRepo?.worktree_lifecycle || task.result?.worktree_lifecycle || null,
    },
  };
}

export async function processGeneralTask(store, config, task, context, github) {
  return processGeneralTaskWithDeps(store, config, task, context, github, {});
}

export async function processGeneralTaskWithDeps(store, config, task, context, github, deps = {}) {
  const resolveTaskRepositoryPlanFn = deps.resolveTaskRepositoryPlanFn || _resolveTaskRepositoryPlan;
  const materializeTaskWorktreeFn = deps.materializeTaskWorktreeFn || _materializeTaskWorktree;
  const verifyTaskWorktreeFn = deps.verifyTaskWorktreeFn || verifyRealTaskWorktree;
  const acquireRepoLockFn = deps.acquireRepoLockFn || acquireRepoLock;
  const releaseLockForTaskFn = deps.releaseLockForTaskFn || releaseLockForTask;
  const prepareCodexTaskRunFn = deps.prepareCodexTaskRunFn || prepareCodexTaskRun;
  const executeCodexTaskRunFn = deps.executeCodexTaskRunFn || executeCodexTaskRun;
  const runCommandFn = deps.runCommandFn;
  const executeAgentBackendRunFn = deps.executeAgentBackendRunFn || ((args) => executeAgentBackendRun(args, { runCodexTaskFn: executeCodexTaskRunFn, runLocalShellFn: runCommandFn }));
  const resolvePathContextFn = deps.resolvePathContextFn || resolvePathContext;
  const finalizeCodexTaskRunFn = deps.finalizeCodexTaskRunFn || finalizeCodexTaskRun;
  const updateTaskFn = deps.updateTaskFn || updateTask;
  const appendGoalMessageFn = deps.appendGoalMessageFn || appendGoalMessage;
  const ensureTaskGoalFn = deps.ensureTaskGoalFn || ensureTaskGoal;
  const selectWorkspaceFn = deps.selectWorkspaceFn || selectWorkspace;
  // Acceptance/repair/integration deps
  const runAcceptanceAgentFn = deps.runAcceptanceAgentFn || runAcceptanceAgent;
  const createRepairGoalFromFindingsFn = deps.createRepairGoalFromFindingsFn || createRepairGoalFromFindings;
  const shouldAttemptRepairFn = deps.shouldAttemptRepairFn || shouldAttemptRepair;
  const runIntegrationQueueFn = deps.runIntegrationQueueFn || runIntegrationQueue;
  const runAutoIntegrationCompletionFn = deps.runAutoIntegrationCompletionFn || runAutoIntegrationCompletion;
  const createGoalFn = deps.createGoalFn || createGoal;
  const determineHealingActionFn = deps.determineHealingActionFn || determineHealingAction;
  const convergeTaskAfterRunFn = deps.convergeTaskAfterRunFn || convergeTaskAfterRun;
  const startCodexTuiGoalSessionFn = deps.startCodexTuiGoalSessionFn || startCodexTuiGoalSession;
  const runCodexTuiEvidenceCycleFn = deps.runCodexTuiEvidenceCycleFn || runCodexTuiEvidenceCycle;
  const stopCodexTuiSessionFn = deps.stopCodexTuiSessionFn || stopCodexTuiSession;
  const taskProviderDispatcherFn = deps.taskProviderDispatcherFn || dispatchTaskProvider;
  const analyzeDeliveryRecoveryCandidateFn = deps.analyzeDeliveryRecoveryCandidateFn || analyzeDeliveryRecoveryCandidate;
  const runDeliveryRecoveryFn = deps.runDeliveryRecoveryFn || runDeliveryRecovery;
  const now = new Date().toISOString();
  await updateTaskFn(store, task.id, (item) => {
    delete item.lock_blocked_at;
    delete item.lock_blocked_by;
    item.logs.push({ time: now, message: `[worker] started: ${task.title}` });
  });

  // Ensure goal early so we can append transcript messages for non-hosted workspaces
  const linked = await ensureTaskGoalFn(store, config, task.id, context, { assign_to_codex: true });
  const goal = linked.goal;
  const workspaceFiles = linked.workspace_files || (goal ? goalWorkspaceFiles(goal) : { dir: '.gptwork/goals/unknown' });
  // Agent run writeback: context_curator (non-blocking)
  if (goal && workspaceFiles) {
    await writeContextCuratorAgentRun(store, {
      task_id: task.id,
      goal_id: goal.id,
      artifacts: {
        codex_entry: { path: workspaceFiles.codex_entry_md, required: true },
        context_bundle: { path: workspaceFiles.context_bundle_md, required: true },
        context_manifest: { path: workspaceFiles.context_manifest_json, required: true },
      },
    }, context).catch(() => {});

    // P0-MA11-R1: Write planner agent_run after context is prepared
    // Planner's work is represented by the existing goal files.
    await writePlannerAgentRun(store, {
      task_id: task.id,
      goal_id: goal.id,
      planEvidence: {
        codex_entry: { path: workspaceFiles.codex_entry_md, required: true },
        context_bundle: { path: workspaceFiles.context_bundle_md || '', present: Boolean(workspaceFiles.context_bundle_md) },
        context_manifest: { path: workspaceFiles.context_manifest_json || '', present: Boolean(workspaceFiles.context_manifest_json) },
        goal_prompt: { path: workspaceFiles.goal_md || '', present: Boolean(workspaceFiles.goal_md) },
      },
    }, context).catch(() => {});
  }

  // P0-MA11/P0-04: Force agent-run pipeline initialization for new non-legacy tasks.
  // Pipeline init failure must not be silently ignored for new tasks.
  // The gate check will see no agent runs and block the task when gates are enforced.
  if (!isLegacyTask(task)) {
    try {
      await ensurePipelineRunsForTask(store, { task_id: task.id, goal_id: goal?.id || "" }, context);
    } catch (err) {
      // P0-04: Pipeline init failure must be visible, not silently ignored.
      // Gate check will handle blocking since no agent runs exist for new tasks.
      if (goal) {
        appendGoalMessageFn(store, config, {
          goal_id: goal.id,
          role: "codex",
          content: `Pipeline init warning for new task ${task.id}: ${err.message} — gate will block if pipeline runs missing`,
        }, context).catch(() => {});
      }
    }
  }

  // Resolve repo plan first (no git mutation) — safe for queue/dry-run
  const resolvedRepoPlan = await resolveTaskRepositoryPlanFn({ task, goal, config, registry: config.registry || null });
  if (!resolvedRepoPlan || !resolvedRepoPlan.repo_id) {
    throw new Error(`resolveTaskRepositoryPlan returned no plan for task ${task.id}`);
  }

  const workspace = await selectWorkspaceFn(store, task.workspace_id, context);
  if (workspace.type !== "hosted") {
    const msg = `[worker] paused: unsupported workspace type "${workspace.type}" — moving to waiting_for_review. This workspace type does not support builder/deploy/admin execution.`;
    await updateTaskFn(store, task.id, (item) => {
      item.status = "waiting_for_review";
      item.logs.push({ time: new Date().toISOString(), message: msg });
    });
    if (goal) {
      await appendGoalMessageFn(store, config, {
        goal_id: goal.id,
        role: "codex",
        content: msg
      }, context);
    }
    return { task_id: task.id, status: "waiting_for_review", skipped: true, transitioned: true, progressed: true, reason: `unsupported workspace type: ${workspace.type}` };
  }

  // No pre-materialization lock — worktree tasks use independent worktree paths
  // for true concurrent execution on the same canonical repo.
  let repoLockPath = null;
  // Enter materializing_worktree state (only now do we create the worktree)
  const enableWorktrees = config.enableTaskWorktrees !== false;
  let resolvedRepo = resolvedRepoPlan;
  // Determine if the task should use canonical (in-place) execution instead of a worktree.
  // canonical execution is used for deploy/admin tasks or when worktrees are disabled.
  const usesCanonicalExecution = !enableWorktrees || task.execution_mode === 'canonical' || task.mode === 'deploy' || task.mode === 'admin';
  let executionCwd = usesCanonicalExecution ? (resolvedRepoPlan.canonical_repo_path || config.defaultRepoPath) : null;
  let worktreeMaterialized = usesCanonicalExecution; // canonical execution doesn't need worktree materialization
  let tuiEvidenceReady = null;
  let providerExecutionReady = null;
  let pathContext = null;

  async function ensurePathContext() {
    if (pathContext) return pathContext;
    pathContext = await resolvePathContextFn({
      workspaceRoot: config.defaultWorkspaceRoot || config.workspaceRoot,
      task: {
        ...task,
        canonical_repo_path: resolvedRepo.canonical_repo_path,
        task_worktree_path: executionCwd || resolvedRepo.task_worktree_path,
      },
      repository: { canonical_path: resolvedRepo.canonical_repo_path },
      config,
    });
    return pathContext;
  }

  async function materializeExecutionWorktree() {
    if (worktreeMaterialized) return { ok: true };
    if (!enableWorktrees) {
      // Worktrees disabled — default to canonical repo execution.
      // Repo-lock serialization handles concurrent access to the canonical repo.
      executionCwd = resolvedRepo.canonical_repo_path || resolvedRepoPlan.canonical_repo_path || config.defaultRepoPath;
      worktreeMaterialized = true;
      return { ok: true, canonical: true };
    }

    // Deploy/admin tasks use canonical execution — no worktree needed.
    if (usesCanonicalExecution) {
      worktreeMaterialized = true;
      return { ok: true, canonical: true };
    }

    await updateTaskFn(store, task.id, (item) => {
      item.status = "materializing_worktree";
      item.logs.push({ time: new Date().toISOString(), message: "[worker] materializing worktree" });
    });

    const materialized = await materializeTaskWorktreeFn(resolvedRepoPlan, { config });
    resolvedRepo = { ...resolvedRepoPlan, ...materialized };
    if (resolvedRepo.worktree_lifecycle?.ok !== true || resolvedRepo.worktree_lifecycle?.mode !== "git_worktree") {
      return {
        ok: false,
        reason: resolvedRepo.worktree_lifecycle?.error || "task worktree lifecycle is not verified git_worktree",
      };
    }
    const verification = await verifyTaskWorktreeFn({ resolvedRepo, plan: resolvedRepoPlan, task, goal, config });
    resolvedRepo.worktree_verification = verification;
    if (!verification?.valid) {
      const lifecycleError = resolvedRepo.worktree_lifecycle?.error;
      const reason = lifecycleError || verification?.error || "unknown worktree verification error";
      return { ok: false, reason };
    }

    executionCwd = resolvedRepo.task_worktree_path || resolvedRepo.worktree_lifecycle?.worktree_path;
    resolvedRepo.task_worktree_path = executionCwd;
    worktreeMaterialized = true;
    return { ok: true };
  }

  async function failWorktree(reason) {
    const failMsg = `[worker] failed to materialize verified task worktree: ${reason}`;
    await updateTaskFn(store, task.id, (item) => {
      item.status = "failed";
      item.result = {
        kind: "worktree_error",
        summary: failMsg,
        completed_at: new Date().toISOString(),
        task_worktree_path: resolvedRepo.task_worktree_path || null,
        canonical_repo_path: resolvedRepo.canonical_repo_path || null,
        worktree_lifecycle: resolvedRepo.worktree_lifecycle || null,
        worktree_verification: resolvedRepo.worktree_verification || null,
      };
      item.logs.push({ time: new Date().toISOString(), message: failMsg });
    });
    return { task_id: task.id, status: "failed", kind: "worktree_error", reason: failMsg };
  }

  const _goalId = goal ? goal.id : task.id;
  const _goalStateDir = config.defaultWorkspaceRoot + "/.gptwork/goals/" + _goalId;
  const _resultJsonPath = _goalStateDir + "/result.json";
  const _resultMdPath = _goalStateDir + "/result.md";
  let promptFile = null;
  let runFilePath = null;
  let runId = null;
  const mode = task.mode || "full";
  let summary = "";
  let parsedResult = null;
  let cr = null;
  let codexMeta = null;
  let healingAction = null;

  if (taskUsesCodexTuiGoal(task) && task.metadata?.tui_session_owner === "manual") {
    return {
      kind: "codex_tui_owned_by_manual",
      provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
      status: "running",
      task_id: task.id,
      goal_id: goal?.id || null,
      session_id: task.metadata?.tui_session_id || task.result?.session_id || null,
      starting: task.metadata?.manual_tui_session_starting === true,
      skipped: true,
      reason: "Manual Codex TUI execution already owns this task",
    };
  }

  const executionWorktree = await materializeExecutionWorktree();
  if (!executionWorktree.ok) return failWorktree(executionWorktree.reason);
  const executionPathContext = await ensurePathContext();
  const _executionRepoPath = executionCwd || resolvedRepo.task_worktree_path || resolvedRepo.canonical_repo_path || config.defaultRepoPath;
  const lockPath = usesCanonicalExecution
    ? (resolvedRepo.canonical_repo_path || resolvedRepoPlan.canonical_repo_path || config.defaultRepoPath || resolvedRepo.task_worktree_path)
    : (resolvedRepo.lock_repo_path || resolvedRepo.task_worktree_path);
  if (lockPath) {
    const lockResult = await acquireRepoLockFn(config.defaultWorkspaceRoot, lockPath, {
      taskId: task.id,
      runId: null,
      mode: task.mode || "full",
    });
    if (!lockResult.acquired) {
      const lockMsg = "[worker] execution path locked by task " + lockResult.heldByTask + ", retry after completion. Skipping.";
      await updateTaskFn(store, task.id, (item) => {
        item.status = "waiting_for_lock";
        item.lock_blocked_at = new Date().toISOString();
        item.lock_blocked_by = lockResult.heldByTask;
        item.logs.push({ time: new Date().toISOString(), message: lockMsg });
      });
      return { task_id: task.id, status: "waiting_for_lock", skipped: true, reason: lockMsg };
    }
    repoLockPath = lockPath;
  }

  await updateTaskFn(store, task.id, (item) => {
    item.status = "running";
    item.logs.push({ time: new Date().toISOString(), message: "[worker] execution provider dispatch started" });
  });

  try {
    const prepResult = await prepareCodexTaskRunFn({
      task,
      goal,
      workspaceFiles,
      workspaceRoot: workspace.root,
      config,
      repoLockPath,
      executionRepoPath: _executionRepoPath,
      goalStateDir: _goalStateDir,
      resultJsonPath: _resultJsonPath,
      resultMdPath: _resultMdPath,
    });
    promptFile = prepResult.promptFile;
    runFilePath = prepResult.runFilePath;
    runId = prepResult.runId;
  } catch (prepErr) {
    const prepHealingAction = determineHealingActionFn({
      error: prepErr,
      task,
      retryCount: task.healing_retry_count || 0,
    });
    return parkTaskForHealingRetry({
      store, config, task, goal, context, updateTaskFn, appendGoalMessageFn,
      releaseLockForTaskFn, repoLockPath, error: prepErr, healingAction: prepHealingAction,
      prefix: "[worker] failed during prompt preparation",
    });
  }

  try {
    providerExecutionReady = await taskProviderDispatcherFn({
      workspaceRoot: config.defaultWorkspaceRoot || workspace.root,
      task,
      goal,
      executionCwd,
      pathContext: executionPathContext,
      inputSnapshot: {
        digest: `${task.id}:${runId || "no-run"}`,
        task_id: task.id,
        goal_id: goal?.id || null,
        acceptance_contract: task.acceptance_contract || goal?.acceptance_contract || null,
      },
      tuiAvailable: isCodexTuiEnabled(config),
      codexTuiEvidenceWaitMs: config.codexTuiEvidenceWaitMs ?? 120_000,
      context: {
        config,
        workspaceRoot: workspace.root,
        candidateWorkspaceRoots: [config.defaultWorkspaceRoot, workspace.root].filter(Boolean),
        task,
        goal,
        resultJsonPath: _resultJsonPath,
        promptFile,
        runFilePath,
        runId,
        repoLockPath,
        executionCwd,
        pathContext: executionPathContext,
        executionId: runId,
        worktreePath: executionCwd,
        branch: resolvedRepo.worktree_lifecycle?.branch_name || resolvedRepo.task_branch || null,
        baseCommit: resolvedRepo.worktree_lifecycle?.base_sha || resolvedRepo.base_sha || null,
        releaseLockFn: () => releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id),
      },
    }, {
      executeCodexTaskRunFn: (args) => executeAgentBackendRunFn({
        ...args,
        role: task.role || task.agent_role || goal?.role || goal?.agent_role || mode,
      }),
      startCodexTuiGoalSessionFn,
      runCodexTuiEvidenceCycleFn,
      stopCodexTuiSessionFn,
      tuiAvailableFn: async ({ tuiAvailable }) => tuiAvailable !== false,
      repositorySnapshot: deps.repositorySnapshotFn,
      acceptanceSnapshot: deps.acceptanceSnapshotFn,
      sleepFn: deps.executionProviderSleepFn,
      ...(deps.executionProviderObserveIntervalMs !== undefined
        ? { observeIntervalMs: deps.executionProviderObserveIntervalMs }
        : {}),
      ...(deps.executionProviderMaxObserveCycles !== undefined
        ? { maxObserveCycles: deps.executionProviderMaxObserveCycles }
        : {}),
    });
  } catch (error) {
    healingAction = determineHealingActionFn({
      error,
      task,
      retryCount: task.healing_retry_count || 0,
    });
    return parkTaskForHealingRetry({
      store, config, task, goal, context, updateTaskFn, appendGoalMessageFn,
      releaseLockForTaskFn, repoLockPath, error, healingAction,
      prefix: "[worker] failed during execution provider dispatch",
    });
  } finally {
    try { await rm(promptFile, { force: true }); } catch {}
  }

  if (providerExecutionReady.status === "provider_unavailable") {
    const unavailableResult = {
      kind: taskUsesCodexTuiGoal(task) && !isCodexTuiEnabled(config) ? "codex_tui_disabled" : "execution_provider_unavailable",
      provider: taskUsesCodexTuiGoal(task) ? CODEX_EXECUTION_PROVIDERS.TUI_GOAL : providerExecutionReady.provider,
      status: "provider_unavailable",
      task_id: task.id,
      goal_id: goal?.id || null,
      commit: "none",
      changed_files: [],
      tests: null,
      failure: providerExecutionReady.failure || providerExecutionReady.attempt?.failure || null,
    };
    await updateTaskFn(store, task.id, (item) => {
      item.status = "failed";
      item.result = unavailableResult;
      item.logs.push({ time: new Date().toISOString(), message: "[worker] execution provider unavailable" });
    });
    if (repoLockPath) await releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id).catch(() => {});
    return unavailableResult;
  }

  if (providerExecutionReady.status === "waiting_for_supervisor") {
    const supervisorResult = {
      kind: "waiting_for_supervisor",
      provider: providerExecutionReady.provider,
      status: "waiting_for_supervisor",
      task_id: task.id,
      goal_id: goal?.id || null,
      checkpoint: providerExecutionReady.checkpoint || providerExecutionReady.attempt?.checkpoint || null,
      session_id: providerExecutionReady.attempt?.provider_handle?.session_id || null,
      native_session_id: providerExecutionReady.attempt?.provider_handle?.native_session_id || null,
    };
    await updateTaskFn(store, task.id, (item) => {
      item.status = "waiting_for_supervisor";
      item.result = supervisorResult;
      item.logs.push({ time: new Date().toISOString(), message: "[worker] bounded supervisor checkpoint persisted" });
    });
    if (repoLockPath) await releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id).catch(() => {});
    return supervisorResult;
  }

  if (providerExecutionReady.provider === "codex_tui" && providerExecutionReady.evidence) {
    const handle = providerExecutionReady.attempt?.provider_handle || {};
    const completion = handle.completion || providerExecutionReady.evidence.raw || {};
    const session = { id: handle.session_id || null, cwd: handle.cwd || executionCwd };
    tuiEvidenceReady = {
      session,
      collected: completion,
      taskResult: normalizeTuiEvidenceToTaskResult({
        evidence_ready: true,
        collected: completion,
        result_json: completion.result_json || providerExecutionReady.evidence.raw || {},
      }, task, goal, session),
    };
  }

  if (
    providerExecutionReady
    && !providerExecutionReady.evidence
    && !providerExecutionReady.attempt?.provider_handle?.result
    && providerExecutionReady.status === "failed"
  ) {
    const providerFailure = providerExecutionReady.attempt?.failure || providerExecutionReady.failure || {};
    const providerError = Object.assign(
      new Error(providerFailure.message || providerFailure.detail || providerFailure.code || "execution provider failed"),
      { code: providerFailure.code || null },
    );
    healingAction = determineHealingActionFn({
      error: providerError,
      task,
      retryCount: task.healing_retry_count || 0,
    });
    if (RETRY_HEALING_ACTIONS.has(healingAction?.action)) {
      return parkTaskForHealingRetry({
        store, config, task, goal, context, updateTaskFn, appendGoalMessageFn,
        releaseLockForTaskFn, repoLockPath, error: providerError, healingAction,
        prefix: "[worker] execution provider failed",
      });
    }
  }

  if (!providerExecutionReady && taskUsesCodexTuiGoal(task)) {
    if (!isCodexTuiEnabled(config)) {
      const disabledResult = {
        kind: "codex_tui_disabled",
        provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
        status: "provider_unavailable",
        task_id: task.id,
        goal_id: goal?.id || null,
        commit: "none",
        changed_files: [],
        tests: null,
        followup: "Set GPTWORK_CODEX_TUI_ENABLED=true to allow explicit codex_tui_goal tasks to start TUI sessions.",
      };
      await updateTaskFn(store, task.id, (item) => {
        item.status = "waiting_for_review";
        item.result = disabledResult;
        item.logs.push({ time: new Date().toISOString(), message: "[worker] codex_tui_goal disabled by configuration" });
      });
      return disabledResult;
    }

    // P0: PTY availability preflight — fail fast with terminal status
    // before any session I/O or lock acquisition.
    const { checkPtyAvailability } = await import('./codex-tui-pty-adapter.mjs');
    const ptyReport = await checkPtyAvailability();
    if (!ptyReport.node_pty && !ptyReport.script) {
      const ptyFailedResult = {
        kind: 'codex_tui_pty_unavailable',
        provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
        status: 'failed',
        task_id: task.id,
        goal_id: goal?.id || null,
        commit: 'none',
        changed_files: [],
        tests: null,
        pty_report: ptyReport,
        diagnostic: {
          code: 'pty_mechanism_unavailable',
          message: ptyReport.diagnostic,
          detail: ptyReport.detail,
        },
        followup: 'Install node-pty via: npm install node-pty, or ensure script(1) is available on the system PATH.',
        error: 'No PTY mechanism available for TUI session.',
      };
      await updateTaskFn(store, task.id, (item) => {
        item.status = 'failed';
        item.result = ptyFailedResult;
        item.logs.push({ time: new Date().toISOString(), message: '[worker] codex_tui_goal failed: ' + ptyReport.diagnostic });
      });
      if (goal) {
        await appendGoalMessageFn(store, config, {
          goal_id: goal.id,
          role: 'codex',
          content: '[worker] codex_tui_goal failed: ' + ptyReport.diagnostic + ' - ' + ptyReport.detail
        }, context);
      }
      return ptyFailedResult;
    }

    // P0: Warn if node-pty is missing but script fallback is available
    if (!ptyReport.node_pty && ptyReport.script) {
      // Log diagnostic, but allow the session to proceed with script(1) fallback
      await updateTaskFn(store, task.id, (item) => {
        item.logs.push({ time: new Date().toISOString(), message: '[worker] codex_tui_goal warning: ' + ptyReport.detail });
      });
    }

    // P0-UA6-G4: Superpowers plugin preflight for TUI fallback
    const { checkSuperpowersPluginForTuiFallback } = await import('./codex-execution-provider.mjs');
    const superpowersCheck = checkSuperpowersPluginForTuiFallback(config);
    if (superpowersCheck.available === false) {
      const pluginMissingResult = {
        kind: 'codex_tui_superpowers_missing',
        provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
        status: 'provider_unavailable',
        task_id: task.id,
        goal_id: goal?.id || null,
        commit: 'none',
        changed_files: [],
        tests: null,
        diagnostic: superpowersCheck.diagnostic,
        followup: superpowersCheck.diagnostic.remediation,
      };
      await updateTaskFn(store, task.id, (item) => {
        item.status = 'waiting_for_review';
        item.result = pluginMissingResult;
        item.logs.push({ time: new Date().toISOString(), message: '[worker] codex_tui_goal blocked: ' + (superpowersCheck.diagnostic?.code || 'superpowers_plugin_missing') });
      });
      return pluginMissingResult;
    }

    let workerClaimedTui = false;
    let manualOwner = null;
    await updateTaskFn(store, task.id, (item) => {
      const existingOwner = item.metadata?.tui_session_owner;
      if (existingOwner === "manual") {
        manualOwner = {
          session_id: item.metadata?.tui_session_id || item.result?.session_id || null,
          starting: item.metadata?.manual_tui_session_starting === true,
        };
        return;
      }
      if (existingOwner && existingOwner !== "worker") {
        manualOwner = { session_id: item.metadata?.tui_session_id || null, starting: true };
        return;
      }
      item.status = "running";
      item.metadata = {
        ...(item.metadata || {}),
        codex_execution_provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
        tui_session_owner: "worker",
        worker_tui_session_starting: true,
      };
      item.logs ||= [];
      item.logs.push({ time: new Date().toISOString(), message: "[worker] claimed Codex TUI execution ownership" });
      workerClaimedTui = true;
    });
    if (!workerClaimedTui) {
      return {
        kind: "codex_tui_owned_by_manual",
        provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
        status: "running",
        task_id: task.id,
        goal_id: goal?.id || null,
        session_id: manualOwner?.session_id || null,
        starting: manualOwner?.starting === true,
        skipped: true,
        reason: "Manual Codex TUI execution already owns this task",
      };
    }

    const tuiWorktree = await materializeExecutionWorktree();
    if (!tuiWorktree.ok) return failWorktree(tuiWorktree.reason);
    const tuiPathContext = await ensurePathContext();

    // Acquire repo lock before starting TUI session
    const tuiLockPath = resolvedRepo.lock_repo_path || executionCwd;
    let tuiLockAcquired = false;
    if (tuiLockPath) {
      const lockResult = await acquireRepoLockFn(config.defaultWorkspaceRoot, tuiLockPath, {
        taskId: task.id,
        runId: null,
        mode: task.mode || "tui",
      });
      if (lockResult.acquired) {
        tuiLockAcquired = true;
        repoLockPath = tuiLockPath;
      }
    }

    const session = await startCodexTuiGoalSessionFn({
      task,
      goal,
      cwd: executionCwd,
      workspaceRoot: config.defaultWorkspaceRoot || executionCwd,
      repoLockId: tuiLockAcquired ? repoLockPath : null,
      worktreePath: executionCwd,
      branch: resolvedRepo.worktree_lifecycle?.branch_name || resolvedRepo.task_branch || null,
      baseCommit: resolvedRepo.worktree_lifecycle?.base_sha || resolvedRepo.base_sha || null,
      pathContext: tuiPathContext,
      executionId: task.execution_id || task.run_id || null,
      releaseLockFn: () => releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id),
    });

    const sessionStartedResult = {
      kind: "codex_tui_session_started",
      provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
      execution_backend: "codex_tui_superpowers",
      tui_phase: "session_started",
      status: "waiting_for_review",
      task_id: task.id,
      goal_id: goal.id,
      session_id: session.id,
      cwd: session.cwd || executionCwd,
      commit: "none",
      changed_files: [],
      tests: null,
      verification: {
        passed: false,
        findings: [{
          severity: "major",
          code: "tui_evidence_missing",
          message: "Codex TUI session started, but durable result evidence has not been collected yet.",
        }],
      },
    };

    await updateTaskFn(store, task.id, (item) => {
      item.status = "waiting_for_review";
      item.metadata = {
        ...(item.metadata || {}),
        tui_session_owner: "worker",
        worker_tui_session_starting: false,
        tui_session_id: session.id,
      };
      item.result = sessionStartedResult;
      item.logs.push({ time: new Date().toISOString(), message: `[worker] codex_tui_goal session started: ${session.id}` });
    });

    if (goal) {
      await appendGoalMessageFn(store, config, {
        goal_id: goal.id,
        role: "codex",
        content: `[worker] Codex TUI goal session started for task ${task.id}: ${session.id}`,
      }, context);
    }
    // P2: Evidence collect loop — wait for result.json, then collect durable evidence.
    const collected = await runCodexTuiEvidenceCycleFn({
      task,
      goal,
      sessionId: session.id,
      workspaceRoot: config.defaultWorkspaceRoot,
      maxWaitMs: config.codexTuiEvidenceWaitMs ?? 120_000,
    });

    if (!collected?.evidence_ready) {
      const evidenceTimedOut = collected?.status === "timed_out";
      try {
        await stopCodexTuiSessionFn(session.id, {
          reason: evidenceTimedOut ? "evidence_timeout" : "evidence_collection_failed",
          workspaceRoot: config.defaultWorkspaceRoot,
        });
      } catch { /* state transition must still proceed */ }
      const terminalStatus = evidenceTimedOut ? "retry_wait" : "failed";
      await updateTaskFn(store, task.id, (item) => {
        item.status = terminalStatus;
        item.metadata = { ...(item.metadata || {}), tui_session_id: session.id };
        delete item.metadata.tui_session_owner;
        delete item.metadata.worker_tui_session_starting;
        item.result = {
          ...sessionStartedResult,
          status: terminalStatus,
          failure_class: evidenceTimedOut ? "result_missing" : "tui_result_missing",
          tui_phase: "blocked_missing_evidence",
          expected_result_json: collected?.expected_result_json || null,
          expected_result_md: collected?.expected_result_md || null,
          finding: collected?.finding || null,
          verification: {
            passed: false,
            findings: [collected?.finding || {
              severity: "blocker",
              code: evidenceTimedOut ? "tui_result_json_timeout" : "tui_result_json_failed",
              message: `TUI session evidence collection resulted in terminal state: ${collected?.reason || "no evidence"} after evidence wait period.`,
            }],
          },
          collect_result: collected,
        };
        item.logs.push({ time: new Date().toISOString(), message: `[worker] codex_tui_goal ${terminalStatus}: ${collected?.reason || "no evidence"}` });
      });
      return {
        kind: "codex_tui_awaiting_evidence",
        status: terminalStatus,
        session_id: session.id,
        expected_result_json: collected?.expected_result_json || null,
        finding: collected?.finding || null,
        collect_result: collected || null,
        reason: collected?.reason || "result evidence missing",
      };
    }

    // Evidence collected — continue through normal acceptance/finalizer path.
    tuiEvidenceReady = {
      session,
      collected,
      taskResult: normalizeTuiEvidenceToTaskResult(collected, task, goal, session),
    };
    executionCwd = session.cwd || executionCwd;
    await updateTaskFn(store, task.id, (item) => {
      item.logs.push({ time: new Date().toISOString(), message: `[worker] codex_tui_goal evidence ready for closure: ${session.id}` });
    });
  }

  if (!providerExecutionReady && !tuiEvidenceReady && goal) {
    await appendGoalMessageFn(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Starting Codex execution for task ${task.id}. Reading ${workspaceFiles.goal_md}.`
    }, context);
  }

  if (!providerExecutionReady && !tuiEvidenceReady && !worktreeMaterialized) {
    const workerWorktree = await materializeExecutionWorktree();
    if (!workerWorktree.ok) return failWorktree(workerWorktree.reason);
  }

  // Compute contract paths once for the full prepare -> execute -> finalize chain
  // Acquire execution lock on task worktree path (not canonical repo).
  // In worktree mode, each task uses its own worktree path as lock resource,
  // so concurrent tasks on different worktrees are NOT serialized by this lock.
  // In legacy mode (no worktrees), lock on canonical repo path.
  if (!providerExecutionReady && !tuiEvidenceReady) {
    const lockPath = usesCanonicalExecution
      ? (resolvedRepo.canonical_repo_path || resolvedRepoPlan.canonical_repo_path || config.defaultRepoPath || resolvedRepo.task_worktree_path)
      : (resolvedRepo.lock_repo_path || resolvedRepo.task_worktree_path);
    if (lockPath) {
      const lockResult = await acquireRepoLockFn(config.defaultWorkspaceRoot, lockPath, {
        taskId: task.id,
        runId: null,
        mode: task.mode || "full"
      });
      if (!lockResult.acquired) {
        const lockMsg = "[worker] execution path locked by task " + lockResult.heldByTask + ", retry after completion. Skipping.";
        await updateTaskFn(store, task.id, (item) => {
          item.status = "waiting_for_lock";
          item.lock_blocked_at = new Date().toISOString();
          item.lock_blocked_by = lockResult.heldByTask;
          item.logs.push({ time: new Date().toISOString(), message: lockMsg });
        });
        if (goal) {
          await appendGoalMessageFn(store, config, {
            goal_id: goal.id,
            role: "codex",
            content: lockMsg
          }, context);
        }
        return { task_id: task.id, status: "waiting_for_lock", skipped: true, reason: lockMsg };
      }
      repoLockPath = lockPath;
    }
  }

  const executionBackendRole = tuiEvidenceReady ? "operator" : (task.role || task.agent_role || goal?.role || goal?.agent_role || mode);
  const executionBackend = tuiEvidenceReady ? "codex_tui_superpowers" : resolveAgentBackendId({ config, role: executionBackendRole, task });

  if (providerExecutionReady && !tuiEvidenceReady) {
    const providerHandle = providerExecutionReady.attempt?.provider_handle || {};
    const execResult = providerHandle.result || null;
    if (execResult) {
      ({ cr, parsedResult, summary, codexMeta } = execResult);
      const failure = providerExecutionReady.attempt?.failure || providerExecutionReady.failure || null;
      if (failure?.failure_class && parsedResult && !parsedResult.failure_class) {
        parsedResult.failure_class = failure.failure_class;
      }
    } else {
      const failure = providerExecutionReady.attempt?.failure || providerExecutionReady.failure || {};
      const timedOut = providerExecutionReady.status === "timed_out";
      summary = failure.message || failure.detail || `Execution provider ended in ${providerExecutionReady.status}`;
      parsedResult = {
        structured: true,
        status: timedOut ? "timed_out" : "failed",
        summary,
        changed_files: [],
        tests: null,
        commit: "none",
        verification: { passed: false, commands: [], findings: [failure] },
        failure_class: failure.failure_class || (timedOut ? "execution_timeout" : "execution_failed"),
      };
      cr = { returncode: timedOut ? 124 : 1, stdout: "", stderr: summary, timed_out: timedOut };
      codexMeta = { provider: providerExecutionReady.provider, native_session_id: failure.native_session_id || null };
    }
  } else if (tuiEvidenceReady) {
    parsedResult = tuiEvidenceReady.taskResult;
    summary = parsedResult.summary;
    cr = { returncode: 0, stdout: "", stderr: "", timed_out: false };
    codexMeta = { provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL, model: parsedResult.model || null };
  } else {
    await updateTaskFn(store, task.id, (item) => {
      item.status = "running";
      item.logs.push({ time: new Date().toISOString(), message: "[worker] codex exec started" });
    });

    // ---------------------------------------------------------------------------
    // Prepare prompt file — this may fail with ENOSPC or other operational errors
    // ---------------------------------------------------------------------------
    try {
      const prepResult = await prepareCodexTaskRunFn({
        task,
        goal,
        workspaceFiles,
        workspaceRoot: workspace.root,
        config,
        repoLockPath,
        executionRepoPath: _executionRepoPath,
        goalStateDir: _goalStateDir,
        resultJsonPath: _resultJsonPath,
        resultMdPath: _resultMdPath,
      });
      promptFile = prepResult.promptFile;
      runFilePath = prepResult.runFilePath;
      runId = prepResult.runId;
    } catch (prepErr) {
      // If prepareCodexTaskRun fails (e.g. ENOSPC), classify via self-healing policy
      // and either requeue within budget or park for review.
      const failMsg = `[worker] failed during prompt preparation`;
      // Classify the error via self-healing policy
      const prepHealingAction = determineHealingActionFn({
        error: prepErr,
        task,
        retryCount: task.healing_retry_count || 0,
      });
      return parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error: prepErr, healingAction: prepHealingAction, prefix: failMsg });
    }

    try {
      const execPathContext = await ensurePathContext();
      ({ cr, parsedResult, summary, codexMeta } = await executeAgentBackendRunFn({
        config,
        workspaceRoot: workspace.root,
        task,
        goal,
        role: executionBackendRole,
        resultJsonPath: _resultJsonPath,
        promptFile,
        runFilePath,
        runId,
        repoLockPath,
        executionCwd,
        pathContext: execPathContext,
        executionId: runId,
      }));
    } catch (e) {
      summary = "[ERROR] " + e.message;
      healingAction = determineHealingActionFn({
        error: e,
        task,
        retryCount: task.healing_retry_count || 0,
      });
      // Execution failures use the same bounded self-healing state machine.
      if (healingAction && healingAction.action !== "waiting_for_review") {
        return parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error: e, healingAction, prefix: "[worker] failed during Codex execution" });
      }
      if (healingAction?.action === "waiting_for_review") {
        return parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error: e, healingAction, prefix: "[worker] failed during Codex execution" });
      }
    } finally {
      try { await rm(promptFile, { force: true }); } catch {}
    }
  }
  if (!summary) summary = "Task completed (no output captured)";

  const timedOut = cr?.timed_out || false;
  if (parsedResult && parsedResult.structured && parsedResult.status === "completed" && cr && cr.returncode !== 0) {
    parsedResult.status = "failed";
  }
  let taskResult;
  if (tuiEvidenceReady) {
    taskResult = parsedResult;
  } else {
    taskResult = parsedResult
      ? buildTaskResult(parsedResult, { timedOut, timeoutSeconds: config.codexExecTimeout, returnCode: cr?.returncode ?? 0, cr })
      : {
        kind: cr?.no_first_output_timeout ? "no_first_output_timeout" : timedOut ? "codex_timeout" : "codex_failed",
        healing_action: healingAction?.action || null,
        summary: cr?.no_first_output_timeout ? "Codex produced no stdout/stderr before the first-output timeout." : summary,
        completed_at: new Date().toISOString(),
        stdout_bytes: cr?.stdout_bytes ?? 0,
        stderr_bytes: cr?.stderr_bytes ?? 0,
        first_stdout_at: cr?.first_stdout_at || null,
        first_stderr_at: cr?.first_stderr_at || null,
        first_output_delay_ms: cr?.first_output_delay_ms ?? null,
        no_first_output_timeout: cr?.no_first_output_timeout || false,
        ...(timedOut ? { timed_out: true, timeout_seconds: cr?.no_first_output_timeout ? cr?.first_output_timeout_seconds : config.codexExecTimeout } : { timed_out: false })
      };
  }

  const providerFindings = providerExecutionReady?.evidence?.verification?.findings;
  if (Array.isArray(providerFindings) && providerFindings.length > 0) {
    taskResult.acceptance_findings = [
      ...(Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : []),
      ...providerFindings.filter((finding) => !taskResult.acceptance_findings?.some(
        (existing) => existing?.code === finding?.code && existing?.message === finding?.message,
      )),
    ];
  }

  taskResult.repo_resolution = {
    repo_id: resolvedRepo.repo_id,
    canonical_repo_path: resolvedRepo.canonical_repo_path,
    lock_repo_path: resolvedRepo.lock_repo_path,
    task_worktree_path: resolvedRepo.task_worktree_path,
    uses_default_fallback: resolvedRepo.uses_default_fallback,
    worktree_lifecycle: resolvedRepo.worktree_lifecycle,
  };
  taskResult.execution_backend = executionBackend;
  taskResult.execution_backend_role = executionBackendRole;
  taskResult.worktree_lifecycle = resolvedRepo.worktree_lifecycle;
  taskResult.execution_cwd = executionCwd;
  taskResult.execution_cwd_proof = {
    cwd: executionCwd,
    task_worktree_path: resolvedRepo.task_worktree_path || null,
    canonical_repo_path: resolvedRepo.canonical_repo_path || null,
    used_task_worktree_path: Boolean(resolvedRepo.task_worktree_path) && executionCwd === resolvedRepo.task_worktree_path,
  };

  // P0: Record effective model/provider from the execution header
  if (codexMeta) {
    taskResult.model = codexMeta.model || taskResult.model || null;
    taskResult.provider = codexMeta.provider || taskResult.provider || null;
    taskResult.reasoning_effort = codexMeta.reasoning_effort || taskResult.reasoning_effort || null;
    taskResult.codex_config_source = codexMeta.config_source || null;
    taskResult.codex_effective_args = codexMeta.effective_args || null;
  } else if (parsedResult) {
    taskResult.model = parsedResult.model || taskResult.model || null;
    taskResult.provider = parsedResult.provider || taskResult.provider || null;
  }

  if (
    providerExecutionReady?.provider === "codex_tui"
    && !providerExecutionReady.evidence
    && ["failed", "timed_out"].includes(providerExecutionReady.status)
  ) {
    const handle = providerExecutionReady.attempt?.provider_handle || {};
    const failure = providerExecutionReady.attempt?.failure || providerExecutionReady.failure || {};
    taskResult.session_id = handle.session_id || null;
    taskResult.native_session_id = handle.native_session_id || failure.native_session_id || null;
    taskResult.tui_phase = "automatic_recovery_pending";
    taskResult.failure_class = failure.failure_class || "result_missing";
    taskResult.collect_result = failure.cycle || null;
    taskResult.verification = {
      passed: false,
      commands: [],
      findings: [failure.cycle?.finding || failure].filter(Boolean),
    };
    await updateTaskFn(store, task.id, (item) => {
      item.status = "retry_wait";
      item.metadata = { ...(item.metadata || {}), tui_session_id: taskResult.session_id };
      delete item.metadata.tui_session_owner;
      item.result = structuredClone(taskResult);
      item.logs.push({
        time: new Date().toISOString(),
        message: `[worker] Codex TUI evidence unavailable; automatic recovery scheduled (${taskResult.failure_class})`,
      });
    });
  }

  if (parsedResult) applyLegacyNoChangeCompatibility(parsedResult);
  applyLegacyNoChangeCompatibility(taskResult);

  // Agent run writeback: builder
  await writeBuilderAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    taskResult,
    summary,
  }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "builder", err));


  // ---- P0: Network failure retry gate ----
  // If Codex CLI failed with a network-class error (rate_limited, gateway_error,
  // transient_network_error), retry with backoff instead of entering the
  // acceptance/repair pipeline. Network failures are NOT code-level failures
  // and should NOT trigger code repair loops.
  const _fc = taskResult.failure_class || classifyFailure({
    resultJson: taskResult,
    result: taskResult,
    message: taskResult.summary || '',
    codexTimeout: taskResult.kind === 'codex_timeout',
    missingResultJson: taskResult.kind === 'codex_failed' && !parsedResult,
    noFirstOutputTimeout: taskResult.no_first_output_timeout,
  });
  taskResult.failure_class = _fc;
  if (_fc === "codex_transport_404") {
    const finding = taskResult.blocking_finding || {
      severity: "blocker",
      code: "provider_endpoint_not_found",
      message: taskResult.summary || "The configured provider returned 404 for /v1/responses.",
      source: "codex_transport",
    };
    taskResult.status = "blocked";
    taskResult.pipeline_halted = true;
    taskResult.next_action = taskResult.next_action || "Configure a provider endpoint that implements the Codex Responses transport, then requeue the task.";
    taskResult.acceptance_findings = [finding];
    taskResult.verification = {
      passed: false,
      status: "skipped",
      commands: [],
      failure_class: "codex_transport_404",
      findings: [finding],
      next_action: taskResult.next_action,
      skipped: true,
    };
    taskResult.reviewer_decision = {
      status: "skipped",
      passed: false,
      reason: "pipeline_halted_by_provider_endpoint_not_found",
    };
    taskResult.integration = {
      status: "skipped",
      required: false,
      terminal: true,
      reason: "pipeline_halted_by_provider_endpoint_not_found",
    };

    await skipDownstreamAgentRunsForBlocker(store, {
      task_id: task.id,
      goal_id: goal?.id,
      finding,
      next_action: taskResult.next_action,
    }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "pipeline", err));
    await writeFinalizerAgentRun(store, {
      task_id: task.id,
      goal_id: goal?.id,
      taskResult,
      taskStatus: "blocked",
    }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "finalizer", err));

    return finalizeCodexTaskRunFn({
      store,
      config,
      task,
      taskStatus: "blocked",
      taskResult,
      doneAt: new Date().toISOString(),
      cr,
      workspace,
      goal,
      workspaceFiles,
      summary: taskResult.summary,
      context,
      runFilePath,
      repoLockPath,
      resolvedRepo,
      github,
      appendGoalMessageFn,
      resultJsonPath: _resultJsonPath,
      verifyTaskCompletionFn: deps.verifyTaskCompletionFn,
      autoStartNextOnTaskCompletedFn: deps.autoStartNextOnTaskCompletedFn,
      runIntegrationQueueFn,
      shouldAttemptRepairFn,
      createRepairGoalFromFindingsFn,
      createGoalFn,
      deliveryResultRecovery: null,
    });
  }
  if (_fc && failureClassIsTerminalNonRepairable(_fc)) {
    const _healing = determineHealingActionFn({
      error: new Error(taskResult.summary || _fc),
      task,
      retryCount: task.healing_retry_count || 0,
    });
    if (_healing.action === 'retry_with_backoff') {
      return parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error: new Error(taskResult.summary || _fc), healingAction: _healing, prefix: '[worker] network/terminal failure during Codex execution' });
    }
    // Budget exceeded — fall through to acceptance; the repair-is-terminal check
    // in the finalizer will also prevent code-repair for network failures.
  }

  const doneAt = new Date().toISOString();
  let taskStatus = deriveTaskStatusFromTaskResult(taskResult);
  if (
    providerExecutionReady?.provider === "codex_tui"
    && !providerExecutionReady.evidence
    && taskResult.failure_class === "result_missing"
  ) {
    taskStatus = "retry_wait";
  }
  taskStatus = applyAutonomyValidation(taskStatus, taskResult, goal, parsedResult);
  taskStatus = await applyRuntimeCodeChangeGuard({
    taskStatus,
    taskResult,
    mode,
    parsedResult,
    workspaceRoot: config.defaultWorkspaceRoot,
    taskId: task.id,
    isP0Task: isP0TaskTitle(task.title),
  });

  // P0: result contract validation — escalate to review on contract violation
  const acceptanceFindings = Array.isArray(parsedResult?.acceptance_findings) ? [...parsedResult.acceptance_findings] : [];
  if (taskStatus === "completed" && parsedResult) {
    const validateRepoPath = resolvedRepo.task_worktree_path || resolvedRepo.canonical_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot;
    const contractValidation = validateResultContract(parsedResult, { repoPath: validateRepoPath });
    if (!contractValidation.valid) {
      const profile = detectAcceptanceProfile(task, taskResult);
      const diagnosisMsg = "Contract violation: " + contractValidation.diagnosis_codes.join(", ");
      const classifiedFindings = classifyResultContractFindings({
        diagnosisCodes: contractValidation.diagnosis_codes,
        profile,
      });
      const blockingCodes = classifiedFindings.blocking_codes;
      const nonBlockingCodes = classifiedFindings.non_blocking_codes;
      if (blockingCodes.length > 0) {
        taskStatus = "waiting_for_review";
        taskResult.warnings = taskResult.warnings || [];
        taskResult.warnings.push(diagnosisMsg);
        for (const code of blockingCodes) {
          acceptanceFindings.push({ severity: "major", code, message: diagnosisMsg, source: "result_contract" });
        }
      } else {
        taskResult.warnings = taskResult.warnings || [];
        taskResult.warnings.push("Non-blocking contract finding for " + profile + ": " + nonBlockingCodes.join(", "));
        for (const code of nonBlockingCodes) {
          acceptanceFindings.push({ severity: "followup", code, message: diagnosisMsg, source: "result_contract" });
        }
      }
    }
  }

  if (resolvedRepo.worktree_lifecycle?.mode !== "git_worktree" || resolvedRepo.worktree_lifecycle?.ok !== true) {
    acceptanceFindings.push({
      severity: "followup",
      code: "git_worktree_lifecycle_metadata_only",
      message: "Task repo resolution records a future worktree path, but git worktree add/remove lifecycle is not enabled yet.",
      source: "worktree_reliability_policy",
    });
  }

  if (taskStatus === "failed" || taskStatus === "timed_out") {
    acceptanceFindings.push({
      severity: "blocker",
      code: `codex_${taskStatus}`,
      message: taskResult.summary || `Codex task ended with status ${taskStatus}`,
      source: "acceptance_agent",
    });
  }

  let deliveryResultRecovery = null;
  let deliveryRecoveryCompleted = false;
  if (taskStatus === "failed" && taskResult.kind === "codex_failed") {
    deliveryResultRecovery = await buildDeliveryResultRecoveryEvidence({
      config,
      taskResult,
      resolvedRepo,
      cr,
      runCommandFn: runCommandFn || (await import("./workspace-service.mjs")).runLocalShell,
    });
    if (deliveryResultRecovery) {
      taskResult.delivery_result_recovery = deliveryResultRecovery;
    }
  }

  const reviewer = buildReviewerDecision({
    result: { status: taskStatus, summary: taskResult.summary },
    findings: acceptanceFindings,
    needs_gpt_review: taskStatus === "waiting_for_review",
    review_reason: taskStatus === "waiting_for_review" ? "result_contract_or_operational_guard" : null,
  });
  taskResult.reviewer_decision = parsedResult?.reviewer_decision || reviewer.decision;
  taskResult.acceptance_findings = acceptanceFindings;
  taskResult.next_tasks = Array.isArray(parsedResult?.next_tasks) && parsedResult.next_tasks.length > 0
    ? parsedResult.next_tasks
    : reviewer.next_tasks;
  if (reviewer.decision.repair_proposals.length > 0) {
    taskResult.repair_proposals = reviewer.decision.repair_proposals;
  }

  const recoveryCandidate = analyzeDeliveryRecoveryCandidateFn({ task, taskResult, parsedResult, resolvedRepo, cr });
  const shouldRunDeliveryRecovery = recoveryCandidate.eligible === true
    && (taskStatus === "waiting_for_review" || taskStatus === "failed" || taskStatus === "completed");
  if (shouldRunDeliveryRecovery) {
    deliveryResultRecovery = await runDeliveryRecoveryFn({
      task,
      goal,
      config,
      resolvedRepo,
      taskResult,
      parsedResult,
      cr,
      verificationCommands: recoveryCommandListFromConfig(config),
      runCommandFn: runCommandFn || (await import("./workspace-service.mjs")).runLocalShell,
    });
    taskResult.delivery_result_recovery = deliveryResultRecovery;
    if (deliveryResultRecovery.recovered === true) {
      taskStatus = "completed";
      deliveryRecoveryCompleted = true;
      summary = deliveryResultRecovery.summary || summary;
      taskResult.acceptance_findings = acceptanceFindings;
      taskResult = applySuccessfulDeliveryRecovery(taskResult, deliveryResultRecovery, summary);
    } else if (deliveryResultRecovery.attempted === true) {
      taskStatus = "waiting_for_review";
      taskResult.requires_review = true;
      taskResult.reason = "delivery_result_recovery_failed: " + (deliveryResultRecovery.reason || "unknown");
      taskResult.acceptance_findings = Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : acceptanceFindings;
      taskResult.acceptance_findings.push({
        severity: "blocker",
        code: "delivery_result_recovery_failed",
        message: deliveryResultRecovery.blockers?.[0]?.message || deliveryResultRecovery.reason || "Delivery result recovery failed.",
        source: "delivery_result_recovery",
      });
    }
  }
  // P0: Collect verification evidence before cleanup
  if (taskStatus === "completed" && executionCwd) {
    try {
      const { collectVerificationEvidence } = await import("./verification-evidence.mjs");
      const evidenceResult = await collectVerificationEvidence({
        repoPath: resolvedRepo.canonical_repo_path,
        worktreePath: resolvedRepo.task_worktree_path,
        outputDir: _goalStateDir,
        resultJsonPath: _resultJsonPath,
        acceptanceFindings,
        baseSha: resolvedRepo.worktree_lifecycle?.base_sha,
      });
      if (evidenceResult && evidenceResult.evidence_paths) {
        taskResult.evidence_paths = evidenceResult.evidence_paths;
      }
    } catch (evidenceErr) {
      taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
      taskResult.warnings.push("Evidence collection failed (non-blocking): " + evidenceErr.message);
    }
  }


  
  // ================================================================
  // PR0: Acceptance agent — evidence-based verification
  // ================================================================
  if (taskStatus === 'completed' && (parsedResult || taskResult) && !deliveryRecoveryCompleted) {
    const acceptanceResult = await runAcceptanceAgentFn({
      task,
      goal,
      result: parsedResult || taskResult,
      repoPath: _executionRepoPath,
    });

    // Merge acceptance agent findings with existing findings
    const aaFindings = Array.isArray(acceptanceResult.findings) ? acceptanceResult.findings : [];
    const mergedFindings = [...acceptanceFindings];

    // Add acceptance agent findings that are not duplicates
    for (const f of aaFindings) {
      const isDup = mergedFindings.some(ex => ex.code === f.code && ex.message === f.message);
      if (!isDup) mergedFindings.push(f);
    }

    taskResult.acceptance_findings = mergedFindings;
    taskResult.acceptance_profile = acceptanceResult.profile;
    // Prefer acceptance agent's reviewer decision over the lightweight one
    if (acceptanceResult.reviewer_decision) {
      taskResult.reviewer_decision = acceptanceResult.reviewer_decision;
    }
    if (Array.isArray(acceptanceResult.repair_proposals) && acceptanceResult.repair_proposals.length > 0) {
      taskResult.repair_proposals = acceptanceResult.repair_proposals;
    }
    if (Array.isArray(acceptanceResult.next_tasks) && acceptanceResult.next_tasks.length > 0) {
      taskResult.next_tasks = acceptanceResult.next_tasks;
    }

    // ================================================================
    // P0: Task state convergence — auto-closure and retry decisions
    // ================================================================
    const convergenceResult = convergeTaskAfterRunFn({
      task,
      taskResult,
      acceptance: acceptanceResult,
      runtimeState: taskResult.runtime_state || {},
      attempt: task.repair_attempt || 0,
      now: new Date().toISOString(),
    });
    // Merge convergence findings with acceptance findings
    if (Array.isArray(convergenceResult.findings)) {
      for (const f of convergenceResult.findings) {
        const isDup = mergedFindings.some(function(ex) { return ex.code === f.code && ex.message === f.message; });
        if (!isDup) mergedFindings.push(f);
      }
      taskResult.acceptance_findings = mergedFindings;
    }
    // Store convergence metadata for downstream use
    taskResult.convergence = {
      nextStatus: convergenceResult.nextStatus,
      closureReason: convergenceResult.closureReason,
      profile: convergenceResult.profile,
    };
    // P0: Use convergence result to drive task status before repair creation.
    // Execution/provider failures such as result_missing must not be converted
    // into summary_missing repair loops by the acceptance layer.
    const convergenceTerminalOrRetryStatuses = new Set(["completed", "retry_wait", "quota_wait", "failed", "blocked", "restart_pending"]);
    if (convergenceTerminalOrRetryStatuses.has(convergenceResult.nextStatus) && taskStatus !== convergenceResult.nextStatus) {
      taskStatus = convergenceResult.nextStatus;
    }

    if (!acceptanceResult.passed) {
      // === Acceptance FAILED → attempt repair or escalate ===
      taskResult.acceptance_decision = acceptanceResult.reviewer_decision?.decision || null;

      const convergenceBlocksRepair = convergenceResult.repairPlan === null
        && ["retry_wait", "quota_wait", "failed", "blocked", "restart_pending"].includes(convergenceResult.nextStatus);

      // Respect convergence completion: if convergence already determined
      // completion, do not create repair/review work for non-blocking findings.
      if (convergenceResult.nextStatus === "completed") {
        taskStatus = "completed";
        taskResult.reason = convergenceResult.reason || convergenceResult.closureReason || "convergence_completed";
      } else if (convergenceBlocksRepair) {
        taskStatus = convergenceResult.nextStatus;
        taskResult.reason = convergenceResult.reason || ("non_repairable_failure: " + (taskResult.failure_class || "unknown"));
        taskResult.repair_denied_reason = "Convergence classified this as non-repairable; no repair task created.";
      } else {
        const canRepair = await shouldAttemptRepairFn({ task, tasks: store.state?.tasks || [], maxAttempts: config.maxRepairAttempts });

        if (canRepair.should_repair) {
        const repairGoal = await createRepairGoalFromFindingsFn({
          task: taskWithRepairContext(task, resolvedRepo),
          goal,
          findings: mergedFindings,
          repairProposals: acceptanceResult.repair_proposals,
        });

        taskStatus = 'waiting_for_repair';
        taskResult.repair_goal = repairGoal;
        taskResult.repair_attempt = repairGoal.repair_attempt;
        taskResult.failure_class = mergedFindings.find((finding) => finding.severity === 'blocker')?.code || taskResult.failure_class || 'acceptance_failed';
        taskResult.reason = 'acceptance_failed: ' + canRepair.reason;

        // Create repair goal/task in the store so it can be picked up by the worker
        try {
          const repairCreated = await createGoalFn(store, config, applyRepairMetadata({
            user_request: repairGoal.user_request,
            goal_prompt: repairGoal.goal_prompt,
            title: 'Repair: ' + task.title + ' (attempt ' + repairGoal.repair_attempt + ')',
            project_id: task.project_id || (goal ? goal.project_id : 'default'),
            workspace_id: repairGoal.workspace_id || task.workspace_id || (goal ? goal.workspace_id : 'hosted-default'),
            mode: repairGoal.mode || 'full',
            assign_to_codex: true,
            skip_created_notification: false,
          }, repairGoal));
          taskResult.repair_goal_id = repairCreated.goal ? repairCreated.goal.id : null;
          taskResult.repair_task_id = repairCreated.task ? repairCreated.task.id : null;
        } catch (repairErr) {
          taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
          taskResult.warnings.push('Repair goal creation failed (non-blocking): ' + repairErr.message);
        }
        } else {
          taskStatus = taskResult.failure_class === 'result_missing' ? 'failed' : 'waiting_for_review';
          taskResult.repair_denied_reason = canRepair.reason;
          taskResult.reason = 'acceptance_failed: ' + canRepair.reason;
        }
      }
    } else {
      // === Acceptance PASSED → check if integration is needed ===
      const hasChanges = hasCodeOrConfigOrRuntimeChanges({
        acceptanceResult,
        task,
        result: parsedResult || taskResult,
      });

      if (hasChanges) {
        // Integration is needed — run serial integration queue
        const gitPath = resolvedRepo.task_worktree_path || resolvedRepo.canonical_repo_path || _executionRepoPath;
        const integrationResult = await runIntegrationQueueFn({
          repoId: resolvedRepo.repo_id,
          targetBranch: config.defaultBranch || 'main',
          worktreePath: gitPath,
          canonicalRepoPath: resolvedRepo.canonical_repo_path,
          taskBranch: (resolvedRepo.worktree_lifecycle && resolvedRepo.worktree_lifecycle.branch_name) || sanitizeTaskBranchName(task.id),
          integrationMode: config.integrationMode || 'push_branch',
          checkCommands: config.integrationCheckCommands,
          locksBasePath: config.defaultWorkspaceRoot,
          taskId: task.id,
        });

        taskResult.integration = { ...integrationResult };
        const integrationDecision = classifyIntegrationQueueResult(integrationResult);

        if (integrationDecision.kind === 'terminal_completed') {
          taskStatus = integrationDecision.task_status;
        } else if (integrationDecision.should_attempt_auto_completion) {
            const autoCompletion = await runAutoIntegrationCompletionFn({
              task,
              goal,
              taskResult,
              resolvedRepo,
              integrationResult,
              config,
              runCommandFn: runCommandFn || (await import("./workspace-service.mjs")).runLocalShell,
            });
            taskResult.auto_integration_completion = autoCompletion;
            if (autoCompletion.completed === true) {
              taskStatus = 'completed';
              taskResult = applySuccessfulAutoIntegrationCompletion({ taskResult, integrationResult, autoCompletion });
            } else {
              taskStatus = 'waiting_for_review';
              taskResult = applyFailedAutoIntegrationCompletion({ taskResult, autoCompletion });
            }
        } else if (integrationDecision.should_attempt_repair) {
          // Integration failure — create repair or escalate
          const intCanRepair = await shouldAttemptRepairFn({ task, tasks: store.state?.tasks || [], maxAttempts: config.maxRepairAttempts || task.max_attempts || 2 });
          const conflictFindings = [{
            severity: 'blocker',
            code: 'integration_' + integrationResult.status,
            message: integrationResult.error || 'Integration ' + integrationResult.status,
            source: 'integration_queue',
            conflict_files: integrationResult.conflict_files || [],
          }];

          if (intCanRepair.should_repair) {
            const intRepairGoal = await createRepairGoalFromFindingsFn({
              task: taskWithRepairContext(task, resolvedRepo),
              goal,
              findings: conflictFindings,
              repairProposals: [{
                title: 'Resolve integration failure',
                proposed_action: 'Fix integration ' + integrationResult.status + ' and rerun integration.',
              }],
            });

            taskStatus = 'waiting_for_repair';
            taskResult.repair_goal = intRepairGoal;
            taskResult.repair_attempt = intRepairGoal.repair_attempt;
            taskResult.failure_class = conflictFindings[0]?.code || taskResult.failure_class || 'integration_failed';
            taskResult.reason = 'integration_' + integrationResult.status + ': ' + (integrationResult.error || 'unknown');

            try {
              const intRepairCreated = await createGoalFn(store, config, applyRepairMetadata({
                user_request: intRepairGoal.user_request,
                goal_prompt: intRepairGoal.goal_prompt,
                title: 'Repair: ' + task.title + ' (attempt ' + intRepairGoal.repair_attempt + ', integration conflict)',
                project_id: task.project_id || (goal ? goal.project_id : 'default'),
                workspace_id: intRepairGoal.workspace_id || task.workspace_id || (goal ? goal.workspace_id : 'hosted-default'),
                mode: intRepairGoal.mode || 'full',
                assign_to_codex: true,
                skip_created_notification: false,
              }, intRepairGoal));
              taskResult.repair_goal_id = intRepairCreated.goal ? intRepairCreated.goal.id : null;
              taskResult.repair_task_id = intRepairCreated.task ? intRepairCreated.task.id : null;
            } catch (intRepairErr) {
              taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
              taskResult.warnings.push('Integration repair goal creation failed (non-blocking): ' + intRepairErr.message);
            }
          } else {
            taskStatus = 'waiting_for_review';
            taskResult.repair_denied_reason = intCanRepair.reason;
            taskResult.reason = 'integration_' + integrationResult.status + ': ' + (integrationResult.error || 'unknown');
          }
        } else {
          // Integration locked or other non-terminal state
          taskStatus = integrationDecision.task_status || 'waiting_for_integration';
        }
      } else {
        // P0-C5: Explicit integration_not_required terminal evidence.
        // When acceptance passes but there are no code/config/runtime changes,
        // set integration to not_required as terminal evidence.
        taskResult.integration = {
          status: 'not_required',
          required: false,
          terminal: true,
          evidence: {
            reason: 'no_code_or_config_or_runtime_changes',
            profile: acceptanceResult.profile,
            operation_kind: taskResult.operation_kind || task.mode || 'unknown',
          },
        };
      }
      // NOTE: For multi-process integration, replace INTEGRATION_LOCKS Map with
      // persistent repo-lock-lifecycle locks.
    }
  }




  // Agent run writeback: verifier (non-blocking)
  await writeVerifierAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    verification: taskResult.verification || {},
  }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "verifier", err));

  // Agent run writeback: reviewer (non-blocking)
  await writeReviewerAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    reviewer_decision: taskResult.reviewer_decision || {},
  }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "reviewer", err));

  // Agent run writeback: integrator
  if (taskResult.integration?.status || taskResult.integration?.satisfied === true || taskResult.auto_integration_completion?.attempted === true) {
    await writeIntegratorAgentRun(store, {
      task_id: task.id,
      goal_id: goal?.id,
      integrationResult: taskResult.integration || {},
    }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "integrator", err));
  }

  // P0-MA12-G1: Write finalizer agent_run with result artifact before pipeline gate evaluation
  // so evaluateTaskPipelineGates sees the completed finalizer with kind=result artifact
  // and does not generate a false pipeline_gate_blocking finding.
  // Agent run writeback: finalizer
  await writeFinalizerAgentRun(store, {
    task_id: task.id,
    goal_id: goal?.id,
    taskResult,
    taskStatus,
  }, context).catch((err) => recordAgentRunWritebackFailure(taskResult, "finalizer", err));




  // P0-MA11-R1: Complete any queued agent runs from task result evidence before gate check
  // Tasks that already have a commit and passing tests should not keep agent_runs queued.
  if (taskResult && taskResult.commit && taskResult.verification?.passed === true) {
    await completeQueuedAgentRuns(store, {
      task_id: task.id,
      goal_id: goal?.id,
      taskResult,
    }, context).catch(() => {});
  } else if (!isLegacyTask(task)) {
    // For any non-legacy task that has passed the execution phase, try to
    // complete queued agent runs even without a commit (might be noop/sync).
    const hasResultEvidence = taskResult && Object.keys(taskResult).length > 0;
    if (hasResultEvidence) {
      await completeQueuedAgentRuns(store, {
        task_id: task.id,
        goal_id: goal?.id,
        taskResult,
      }, context).catch(() => {});
    }
  }

  // P0-MA4: Pipeline gate check before closure
  {
    const allowMissingGates = !!isLegacyTask(task);
    const gateResult = await applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, { allowMissingGates }).catch(() => null);
    // P0-MA11: Add legacy_pipeline_bypass marker when legacy bypass is used
    if (gateResult && allowMissingGates && gateResult.gatesSatisfied !== false) {
      taskResult.legacy_pipeline_bypass = true;
    }
    if (gateResult) {
      taskStatus = gateResult.taskStatus;
      taskResult = gateResult.taskResult;
    }
  }

  // P0-MA12-G5: Sync agent run progress to progress.json/subagents.json
  // This bridges the agent-run lifecycle to the subagent progress store
  // that the parent TUI reads via codex_tui_progress / codex_tui_subagents.
  if (goal && config?.defaultWorkspaceRoot) {
    syncAgentRunProgress({
      store,
      workspaceRoot: config.defaultWorkspaceRoot,
      goalId: goal.id,
      taskId: task.id,
    }).catch(() => {});
  }

  return finalizeCodexTaskRunFn({
    store,
    config,
    task,
    taskStatus,
    taskResult,
    doneAt,
    cr,
    workspace,
    goal,
    workspaceFiles,
    summary,
    context,
    runFilePath,
    repoLockPath,
    resolvedRepo,
    github,
    appendGoalMessageFn,
    resultJsonPath: _resultJsonPath,
    verifyTaskCompletionFn: deps.verifyTaskCompletionFn,
    autoStartNextOnTaskCompletedFn: deps.autoStartNextOnTaskCompletedFn,
    runIntegrationQueueFn,
    shouldAttemptRepairFn,
    createRepairGoalFromFindingsFn,
    createGoalFn,
    deliveryResultRecovery,
  });
}
