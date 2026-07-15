import {
  requireScope,
  canAccessProject,
  canAccessWorkspace,
  defaultTokenContext,
} from "./auth-context.mjs";
import { normalizeLegacyModes, updateTask } from "./task-lifecycle.mjs";
import { isCodexSessionInventoryTask } from "./task-status.mjs";
import { completeCodexSessionInventoryTask } from "./tool-groups/session-inventory-tools-group.mjs";
import { mapConcurrent } from "./codex-worker-concurrency.mjs";
import { startQueuedGoals } from "./goal-queue.mjs";
import { runIntegrationQueue } from "./integration-queue.mjs";
import { runAutoIntegrationCompletion, applySuccessfulAutoIntegrationCompletion, applyFailedAutoIntegrationCompletion, classifyIntegrationQueueResult } from "./auto-integration-completion.mjs";
import { createRepairGoalFromFindings, shouldAttemptRepair, handleRepairCompletion } from "./repair-loop.mjs";
import { createGoal } from "./goal-task-goals.mjs";
import { sanitizeTaskBranchName } from "./task-worktree-manager.mjs";
import { sweepStaleTaskStates, applySweepActions } from "./stale-state-sweeper.mjs";
import { ACTIVE_EXECUTION_STATUSES, TASK_STATUSES, isCompletedStatus } from "./task-status-taxonomy.mjs";
import { reconcileAllActiveTaskRuntimes } from "./runtime/task-runtime-reconciler.mjs";
import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";
import { sendCodexTuiSessionInput, stopCodexTuiSession } from "./codex-tui-session-manager.mjs";
import { releaseLockForTask } from "./repo-lock.mjs";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";


const activeBackgroundTaskRuns = new Map();

export function getActiveBackgroundTaskIds() {
  return [...activeBackgroundTaskRuns.keys()].sort();
}

export function launchTaskInBackground(taskId, run) {
  if (activeBackgroundTaskRuns.has(taskId)) {
    return { started: false, promise: activeBackgroundTaskRuns.get(taskId) };
  }
  let started;
  try { started = run(); } catch (error) { started = Promise.reject(error); }
  const promise = Promise.resolve(started);
  activeBackgroundTaskRuns.set(taskId, promise);
  promise.finally(() => {
    if (activeBackgroundTaskRuns.get(taskId) === promise) activeBackgroundTaskRuns.delete(taskId);
  }).catch(() => {});
  return { started: true, promise };
}

const CODEX_ACTIVE_QUEUE_CANDIDATE_STATUSES = [
  ...ACTIVE_EXECUTION_STATUSES,
  TASK_STATUSES.WAITING_FOR_REPAIR,
].filter((status) => status !== TASK_STATUSES.RUNNING);

function isHistoricalNonActionableTask(task) {
  if (!task) return false;
  if (task.retention_compacted === true || task.historical_import === true) return true;
  const imported = task.source === "github-import" || task.created_by === "github-import";
  return imported && task.auto_advance !== true;
}

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error || "unknown error");
}

async function transitionTaskForWorker(store, task, status, message, extra = {}) {
  const updated = await updateTask(store, task.id, (t) => {
    t.status = status;
    t.logs ||= [];
    t.logs.push({ time: new Date().toISOString(), message });
    if (extra.result) {
      t.result = { ...(t.result || {}), ...extra.result };
    }
  });
  return updated.task;
}

async function markTaskFailed(store, task, error, reason = "worker task failed") {
  const message = errorMessage(error);
  try {
    await transitionTaskForWorker(
      store,
      task,
      "failed",
      `[worker] ${reason}: ${message}`,
      { result: { worker_error: message } }
    );
  } catch {
    // If state update itself fails, still return a per-task failure so one bad
    // task never rejects the whole worker tick.
  }
  return { task_id: task.id, status: "failed", failed: true, progressed: true, error: message };
}

async function markTaskWaitingForReview(store, task, reason) {
  try {
    await transitionTaskForWorker(
      store,
      task,
      "waiting_for_review",
      `[worker] ${reason}`,
      { result: { review_reason: reason, requires_review: true } },
    );
  } catch (error) {
    return markTaskFailed(store, task, error, "failed to park unsupported task");
  }
  return { task_id: task.id, status: "waiting_for_review", skipped: true, transitioned: true, progressed: true, reason };
}

function normalizeWorkerResult(task, result, extra = {}) {
  const item = result && typeof result === "object" ? result : { task_id: task.id, status: task.status, result };
  return {
    task_id: item.task_id || task.id,
    ...item,
    ...extra,
    progressed: Boolean(
      item.progressed ||
      extra.progressed ||
      extra.transitioned ||
      item.transitioned ||
      isCompletedStatus(item.status) ||
      item.status === TASK_STATUSES.FAILED
    ),
  };
}

function acceptedByReviewer(result = {}) {
  const decision = result.reviewer_decision || {};
  if (decision.passed === true) return true;
  if (decision.status === "accepted" || decision.decision === "accepted") return true;
  if (decision.decision?.passed === true) return true;
  if (decision.decision?.status === "accepted" || decision.decision?.decision === "accepted") return true;
  return false;
}

function unresolvedBlockingFindings(result = {}) {
  const findings = [
    ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
    ...(Array.isArray(result.findings) ? result.findings : []),
    ...(Array.isArray(result.verification?.findings) ? result.verification.findings : []),
  ];
  return findings.filter((finding) =>
    (finding?.severity === "blocker" || finding?.severity === "major") && finding?.resolved !== true
  );
}

function integrationSatisfied(result = {}) {
  const integration = result.integration || {};
  if (integration.satisfied === true || integration.merged === true || integration.auto_completed === true) return true;
  return ["merged", "ff_only_merged", "skipped", "not_required"].includes(String(integration.status || "").toLowerCase());
}

function integrationTerminalization(result = {}) {
  const terminalization = result.integration_terminalization || {};
  if (terminalization.status === "waiting_for_external_integration") return terminalization;
  if (terminalization.status === "already_integrated_and_verified") return terminalization;
  if (terminalization.status === "ff_only_merged_and_verified") return terminalization;
  return null;
}

function isStableExternalIntegrationWait(result = {}) {
  return integrationTerminalization(result)?.status === "waiting_for_external_integration";
}

function integrationCommitForRetry(task = {}, integrationResult = {}) {
  return integrationResult.commit || task.result?.commit || task.result?.local_head || task.result?.repo_head || null;
}

function buildIntegrationRetryState({ task = {}, integrationResult = {}, stable = false } = {}) {
  const previous = task.result?.integration_retry_state || {};
  const status = integrationResult.status || null;
  const commit = integrationCommitForRetry(task, integrationResult);
  const sameResult = previous.last_status === status && previous.last_commit === commit;
  const repeatCount = sameResult ? (Number(previous.repeat_count) || 0) + 1 : 1;
  const retryDelayMs = stable ? 60 * 60 * 1000 : Math.min(5 * 60 * 1000, 30_000 * repeatCount);
  return {
    last_status: status,
    last_commit: commit,
    repeat_count: repeatCount,
    next_retry_after: new Date(Date.now() + retryDelayMs).toISOString(),
    stable_wait_reason: stable ? "branch_pushed_requires_external_integration" : previous.stable_wait_reason || null,
  };
}

function buildStableExternalIntegrationResult({ task = {}, integrationResult = {}, autoCompletion = null, reason = "branch_pushed_requires_external_integration" } = {}) {
  const status = integrationResult.status || task.result?.integration?.status || "branch_pushed";
  const retryState = buildIntegrationRetryState({ task, integrationResult: { ...integrationResult, status }, stable: true });
  return {
    integration: { ...integrationResult, status, merged: integrationResult.merged === true, ok: integrationResult.ok !== false },
    integration_retried: true,
    integration_retry_state: retryState,
    auto_integration_completion: autoCompletion || task.result?.auto_integration_completion || null,
    integration_terminalization: {
      status: "waiting_for_external_integration",
      last_status: status,
      last_commit: retryState.last_commit,
      repeat_count: retryState.repeat_count,
      stable_wait_reason: reason,
      reason,
      next_action: status === "pr_opened"
        ? "Wait for PR merge completion before retrying integration."
        : "Wait for external merge or PR completion before retrying integration.",
      next_retry_after: retryState.next_retry_after,
      decided_at: new Date().toISOString(),
    },
    requires_review: false,
  };
}

function stableWaitRetryNotDue(result = {}) {
  if (!isStableExternalIntegrationWait(result)) return false;
  const nextRetryAfter = result.integration_retry_state?.next_retry_after || result.integration_terminalization?.next_retry_after || null;
  if (!nextRetryAfter) return true;
  const ts = new Date(nextRetryAfter).getTime();
  return Number.isFinite(ts) && ts > Date.now();
}

function shouldRecoverAcceptedVerifiedReviewTask(task = {}) {
  if (task.status !== TASK_STATUSES.WAITING_FOR_REVIEW) return false;
  const result = task.result || {};
  if (isStableExternalIntegrationWait(result)) return false;
  if (result.kind === "codex_failed" || result.kind === "codex_timeout" || result.kind === "no_first_output_timeout") return false;
  if (acceptedByReviewer(result) !== true) return false;
  if (result.verification?.passed !== true) return false;
  if (unresolvedBlockingFindings(result).length > 0) return false;
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files.filter(Boolean) : [];
  if (changedFiles.length > 0 && !result.commit) return false;
  return true;
}

function repairFindingsForTask(task = {}) {
  const result = task.result || {};
  const findings = [
    ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
    ...(Array.isArray(result.findings) ? result.findings : []),
    ...(Array.isArray(result.verification?.findings) ? result.verification.findings : []),
  ].filter(Boolean);
  if (findings.length > 0) return findings;
  return [{ severity: "blocker", code: result.failure_class || result.kind || "waiting_for_repair", message: result.reason || result.summary || "Task is waiting for automatic repair.", source: "repair_backlog" }];
}

export function findLinkedRepair(tasks = [], item = {}) {
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);
  const isActiveRepair = (candidate) => candidate && !terminalStatuses.has(String(candidate.status || "").toLowerCase());
  const linked = item.result?.repair_task_id || item.repair_task_id || null;
  if (linked) {
    const candidate = tasks.find((entry) => entry.id === linked) || null;
    if (isActiveRepair(candidate)) return candidate;
  }
  return tasks.find((candidate) => candidate.id !== item.id && candidate.parent_task_id === item.id && isActiveRepair(candidate)) || null;
}

function buildFollowupPayload({ task = {}, goal = {}, descriptor = {} } = {}) {
  return {
    ...descriptor,
    user_request: descriptor.user_request,
    goal_prompt: descriptor.goal_prompt,
    title: `Followup: ${task.title || task.id}`,
    project_id: task.project_id || goal?.project_id || "default",
    workspace_id: descriptor.workspace_id || task.workspace_id || goal?.workspace_id || "hosted-default",
    mode: "full",
  };
}

function buildRecoveredContractVerification(result = {}) {
  return {
    ...(result.contract_verification || {}),
    contract_valid: result.contract_verification?.contract_valid !== false,
    blocking_passed: true,
    acceptance_status: "satisfied",
    completion_eligible: true,
    requires_review: false,
    blockers: [],
    non_blocking_followups: Array.isArray(result.contract_verification?.non_blocking_followups)
      ? result.contract_verification.non_blocking_followups
      : [],
    quality_notes: Array.isArray(result.contract_verification?.quality_notes)
      ? result.contract_verification.quality_notes
      : [],
    state_assertions: result.contract_verification?.state_assertions || { passed: true, failures: [] },
    recovered_from_review: true,
  };
}

function recoveryTargetStatus(result = {}) {
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files.filter(Boolean) : [];
  const hasCodeChange = changedFiles.length > 0 && Boolean(result.commit);
  const needsIntegration = result.needs_integration === true || result.closure_path === "integrate" || result.operation_kind === "code_change";
  if ((hasCodeChange || needsIntegration) && !integrationSatisfied(result)) return TASK_STATUSES.WAITING_FOR_INTEGRATION;
  return TASK_STATUSES.COMPLETED;
}

async function ensureRepairTaskForWaitingParent(store, config, task) {
  const state = await store.load();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const current = tasks.find((item) => item.id === task.id) || task;
  const linked = findLinkedRepair(tasks, current);
  if (linked) {
    await transitionTaskForWorker(store, current, TASK_STATUSES.WAITING_FOR_REPAIR, `[worker] repair task already exists: ${linked.id}`, {
      result: { repair_task_id: linked.id, repair_goal_id: linked.goal_id || current.result?.repair_goal_id || null, repair_status: linked.status },
    });
    return { task_id: current.id, status: TASK_STATUSES.WAITING_FOR_REPAIR, progressed: false, transitioned: true, repair_task_id: linked.id };
  }
  const canRepair = shouldAttemptRepair({ task: current, tasks, maxAttempts: config.maxRepairAttempts || current.max_attempts });
  if (!canRepair.should_repair) {
    await transitionTaskForWorker(store, current, TASK_STATUSES.WAITING_FOR_REVIEW, `[worker] repair budget exhausted: ${canRepair.reason}`, { result: { repair_denied_reason: canRepair.reason, requires_review: true } });
    return { task_id: current.id, status: TASK_STATUSES.WAITING_FOR_REVIEW, progressed: true, transitioned: true, reason: canRepair.reason };
  }
  const goal = Array.isArray(state.goals) ? state.goals.find((item) => item.id === current.goal_id) : null;
  const findings = repairFindingsForTask(current);
  const descriptor = createRepairGoalFromFindings({ task: current, goal, findings, repairProposals: current.result?.repair_proposals || [] });
  const created = await createGoal(store, config, { ...buildFollowupPayload({ task: current, goal, descriptor }), assign_to_codex: true, skip_created_notification: false });
  await transitionTaskForWorker(store, current, TASK_STATUSES.WAITING_FOR_REPAIR, `[worker] created repair task: ${created?.task?.id || created?.goal?.id || "unknown"}`, {
    result: { repair_goal_id: created?.goal?.id || null, repair_task_id: created?.task?.id || null, repair_goal: descriptor, repair_attempt: descriptor.repair_attempt, repair_status: "created", repair_created_at: new Date().toISOString(), requires_review: false },
  });
  return { task_id: current.id, status: TASK_STATUSES.WAITING_FOR_REPAIR, progressed: true, transitioned: true, repair_goal_id: created?.goal?.id || null, repair_task_id: created?.task?.id || null };
}

async function recoverAcceptedVerifiedReviewTasks(store, maxTasks = 10) {
  const state = await store.load();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const candidates = tasks
    .filter(shouldRecoverAcceptedVerifiedReviewTask)
    .slice(0, Math.max(0, Math.min(Number(maxTasks) || 10, 50)));
  if (candidates.length === 0) return { recovered: 0, tasks: [] };

  const recovered = [];
  await store.mutate(async (mutState) => {
    mutState.tasks ||= [];
    mutState.activities ||= [];
    for (const candidate of candidates) {
      const item = mutState.tasks.find((task) => task.id === candidate.id);
      if (!item || !shouldRecoverAcceptedVerifiedReviewTask(item)) continue;
      const result = item.result || {};
      const targetStatus = recoveryTargetStatus(result);
      const contractVerification = buildRecoveredContractVerification(result);
      const closureDecision = targetStatus === TASK_STATUSES.WAITING_FOR_INTEGRATION
        ? {
            status: "waiting_for_integration",
            reason: "accepted_verified_review_recovered_waiting_for_integration",
            blocking_passed: true,
            auto_complete_allowed: false,
            requires_human_decision: false,
            task_status: TASK_STATUSES.WAITING_FOR_INTEGRATION,
            blockers: [],
            repairable_blockers: [],
            non_blocking_followups: [],
            quality_notes: [],
          }
        : {
            status: "auto_completed_clean",
            reason: "accepted_verified_review_recovered_clean",
            blocking_passed: true,
            auto_complete_allowed: true,
            requires_human_decision: false,
            task_status: TASK_STATUSES.COMPLETED,
            blockers: [],
            repairable_blockers: [],
            non_blocking_followups: [],
            quality_notes: [],
          };

      item.status = targetStatus;
      item.result = {
        ...result,
        status: "completed",
        requires_review: false,
        contract_verification: contractVerification,
        acceptance_gate: {
          ...(result.acceptance_gate || {}),
          status: "passed",
          source: "accepted_verified_review_recovery",
          contract_verification: contractVerification,
          closure_decision: closureDecision,
        },
        closure_decision: closureDecision,
        recovered_from_review: {
          status: targetStatus,
          reason: closureDecision.reason,
          recovered_at: new Date().toISOString(),
        },
      };
      item.logs ||= [];
      item.logs.push({ time: new Date().toISOString(), message: `[worker] recovered accepted+verified review task to ${targetStatus}` });
      item.updated_at = new Date().toISOString();

      if (Array.isArray(mutState.goal_queue)) {
        const queueItem = mutState.goal_queue.find((entry) => entry.task_id === item.id || (item.goal_id && entry.goal_id === item.goal_id));
        if (queueItem) {
          queueItem.status = targetStatus === TASK_STATUSES.COMPLETED ? "completed" : "running";
          queueItem.completed_task_id = targetStatus === TASK_STATUSES.COMPLETED ? item.id : queueItem.completed_task_id || null;
          queueItem.blocked_reason = null;
          queueItem.updated_at = item.updated_at;
        }
      }

      mutState.activities.push({ time: item.updated_at, type: "task.review_recovered", task_id: item.id, status: item.status });
      recovered.push({ task_id: item.id, status: targetStatus, reason: closureDecision.reason });
    }
  });

  return { recovered: recovered.length, tasks: recovered };
}

function queueStatusForTaskStatus(taskStatus) {
  if (isCompletedStatus(taskStatus)) return "completed";
  if (taskStatus === TASK_STATUSES.FAILED || taskStatus === TASK_STATUSES.TIMED_OUT) return "failed";
  if ([TASK_STATUSES.WAITING_FOR_REVIEW, TASK_STATUSES.WAITING_FOR_REPAIR, TASK_STATUSES.WAITING_FOR_INTEGRATION, "waiting_for_capacity"].includes(taskStatus)) return "blocked";
  return null;
}

async function reconcileRunningQueueItems(store) {
  const state = await store.load();
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const stale = queue.filter((item) => {
    if (item.status !== "running" || !item.task_id) return false;
    const linkedTask = tasks.find((task) => task.id === item.task_id);
    if (!linkedTask) return false;
    return queueStatusForTaskStatus(linkedTask.status) !== null;
  });
  if (stale.length === 0) return { updated: 0, items: [] };

  const updated = [];
  await store.mutate(async (mutState) => {
    mutState.goal_queue ||= [];
    mutState.tasks ||= [];
    for (const candidate of stale) {
      const item = mutState.goal_queue.find((entry) => entry.queue_id === candidate.queue_id);
      const linkedTask = mutState.tasks.find((entry) => entry.id === candidate.task_id);
      const nextStatus = queueStatusForTaskStatus(linkedTask?.status);
      if (!item || !linkedTask || !nextStatus || item.status !== "running") continue;
      item.status = nextStatus;
      item.completed_task_id = nextStatus === "completed" ? linkedTask.id : item.completed_task_id || null;
      item.blocked_reason = nextStatus === "blocked" ? `linked task ${linkedTask.id} status=${linkedTask.status}` : null;
      item.updated_at = new Date().toISOString();
      updated.push({ queue_id: item.queue_id, task_id: linkedTask.id, status: item.status, task_status: linkedTask.status });
    }
  });

  return { updated: updated.length, items: updated };
}

// ---------------------------------------------------------------------------
// Integration retry handler — P0 fix for waiting_for_integration stuck tasks
// ---------------------------------------------------------------------------
// Called by runSingleCodexTask when a task is in "waiting_for_integration"
// status.  Retries the integration queue and either completes, creates a
// repair task, or escalates to review.  Non-terminal lock states preserve
// the waiting_for_integration status for a future retry.
async function retryIntegrationForTask(store, config, task) {
  if (stableWaitRetryNotDue(task.result || {})) {
    return { task_id: task.id, status: TASK_STATUSES.WAITING_FOR_INTEGRATION, progressed: false, transitioned: false, reason: "waiting_for_external_integration" };
  }

  const repoResolution = task.result?.repo_resolution || task.result?.worktree_lifecycle || null;
  if (!repoResolution) {
    return markTaskWaitingForReview(store, task, "integration retry: no repo resolution in task result");
  }

  const gitPath = repoResolution.task_worktree_path || null;
  const canonicalRepoPath = repoResolution.canonical_repo_path || null;
  const lifecycle = repoResolution.worktree_lifecycle || task.result?.worktree_lifecycle || null;
  if (!gitPath || !canonicalRepoPath || lifecycle?.mode !== "git_worktree" || lifecycle?.ok !== true || !existsSync(gitPath) || !existsSync(canonicalRepoPath)) {
    return markTaskWaitingForReview(store, task, "integration retry: verified task worktree is missing; canonical repository fallback is forbidden");
  }
  try {
    const gitOutput = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
    const gitPathReal = (cwd, args) => realpathSync(resolve(cwd, gitOutput(cwd, args)));
    const worktreeTop = realpathSync(gitOutput(gitPath, ["rev-parse", "--show-toplevel"]));
    const canonicalTop = realpathSync(gitOutput(canonicalRepoPath, ["rev-parse", "--show-toplevel"]));
    const worktreeGitDir = gitPathReal(gitPath, ["rev-parse", "--git-dir"]);
    const worktreeCommonDir = gitPathReal(gitPath, ["rev-parse", "--git-common-dir"]);
    const canonicalCommonDir = gitPathReal(canonicalRepoPath, ["rev-parse", "--git-common-dir"]);
    if (worktreeTop === canonicalTop) {
      return markTaskWaitingForReview(store, task, "integration retry: task worktree verification resolved to canonical repository; integration blocked");
    }
    if (worktreeGitDir === worktreeCommonDir || worktreeCommonDir !== canonicalCommonDir) {
      return markTaskWaitingForReview(store, task, "integration retry: task path is not a linked worktree of the canonical repository; common git dir proof failed");
    }
  } catch (err) {
    return markTaskWaitingForReview(store, task, `integration retry: task worktree git verification failed: ${errorMessage(err)}`);
  }

  const branchName = (repoResolution.worktree_lifecycle?.branch_name)
    || (task.result?.worktree_lifecycle?.branch_name)
    || null;

  try {
    const runIntegrationQueueFn = typeof config.runIntegrationQueueFn === "function" ? config.runIntegrationQueueFn : runIntegrationQueue;
    const runAutoIntegrationCompletionFn = typeof config.runAutoIntegrationCompletionFn === "function" ? config.runAutoIntegrationCompletionFn : runAutoIntegrationCompletion;
    const integrationResult = await runIntegrationQueueFn({
      repoId: repoResolution.repo_id || task.repo_id || "default",
      targetBranch: config.defaultBranch || "main",
      worktreePath: gitPath,
      canonicalRepoPath: repoResolution.canonical_repo_path || gitPath,
      taskBranch: branchName || sanitizeTaskBranchName(task.id),
      integrationMode: config.integrationMode || "ff_only",
      checkCommands: config.integrationCheckCommands,
      locksBasePath: config.defaultWorkspaceRoot,
      taskId: task.id,
    });

    const integrationDecision = classifyIntegrationQueueResult(integrationResult);

    if (integrationResult.ok) {
      if (integrationDecision.kind === 'terminal_completed') {
        await transitionTaskForWorker(
          store, task, "completed",
          "[worker] integration retry succeeded",
          { result: { integration: { ...integrationResult }, integration_retried: true, integration_retry_state: buildIntegrationRetryState({ task, integrationResult }) } }
        );
      } else if (integrationDecision.should_attempt_auto_completion) {
        const autoCompletion = await runAutoIntegrationCompletionFn({
          task,
          goal: { id: task.goal_id, mode: task.mode },
          taskResult: task.result || {},
          resolvedRepo: repoResolution,
          integrationResult,
          config,
        });
        if (autoCompletion.completed === true) {
          const completedResult = applySuccessfulAutoIntegrationCompletion({ taskResult: task.result || {}, integrationResult, autoCompletion });
          await transitionTaskForWorker(
            store, task, "completed",
            `[worker] integration retry auto-completed: ${autoCompletion.reason || "verified"}`,
            { result: { ...completedResult, auto_integration_completion: autoCompletion, integration_terminalization: { status: autoCompletion.reason || "ff_only_merged_and_verified", reason: autoCompletion.reason || "ff_only_merged_and_verified", decided_at: new Date().toISOString() }, integration_retry_state: buildIntegrationRetryState({ task, integrationResult }) } }
          );
        } else {
          const stableResult = buildStableExternalIntegrationResult({ task, integrationResult, autoCompletion });
          await transitionTaskForWorker(
            store, task, TASK_STATUSES.WAITING_FOR_INTEGRATION,
            `[worker] integration retry stable external integration wait: ${integrationResult.status}`,
            { result: stableResult }
          );
          return { task_id: task.id, status: TASK_STATUSES.WAITING_FOR_INTEGRATION, progressed: false, transitioned: true, reason: stableResult.integration_terminalization.reason };
        }
      } else {
        await transitionTaskForWorker(
          store, task, TASK_STATUSES.WAITING_FOR_REVIEW,
          "[worker] integration retry requires review: " + (integrationResult.status || "unknown"),
          { result: { integration: { ...integrationResult }, integration_retried: true, integration_retry_state: buildIntegrationRetryState({ task, integrationResult }), requires_review: true } }
        );
        return { task_id: task.id, status: TASK_STATUSES.WAITING_FOR_REVIEW, progressed: true, transitioned: true };
      }

      // P0: Repair parent-child loop — propagate completion to parent/root task
      if (task.parent_task_id || task.repair_of_task_id) {
        try {
          await handleRepairCompletion({
            store,
            config,
            completedTask: task,
            passed: true,
          });
        } catch (repairErr) {
          // Non-fatal: parent update failure should not fail integration
        }
      }
      return { task_id: task.id, status: TASK_STATUSES.COMPLETED, progressed: true, transitioned: true };
    }

    if (integrationResult.status === "locked") {
      // Still locked — preserve waiting_for_integration for another retry
      await transitionTaskForWorker(
        store, task, "waiting_for_integration",
        `[worker] integration retry still locked: ${integrationResult.error || "lock held"}`
      );
      return { task_id: task.id, status: "waiting_for_integration", progressed: false, reason: "lock held" };
    }

    // Repairable integration failure (conflict, check_failed, push_failed, pr_failed)
    const intCanRepair = shouldAttemptRepair({ task, tasks: [], maxAttempts: config.maxRepairAttempts || 2 });

    if (intCanRepair.should_repair) {
      const intRepairGoal = createRepairGoalFromFindings({
        task: { ...task, worktree_path: gitPath, repo_id: repoResolution.repo_id || task.repo_id },
        goal: { id: task.goal_id, mode: task.mode },
        findings: [{
          severity: "blocker",
          code: "integration_" + integrationResult.status,
          message: integrationResult.error || "Integration " + integrationResult.status,
          source: "integration_retry",
        }],
        repairProposals: [{
          title: "Resolve integration failure",
          proposed_action: "Fix integration " + integrationResult.status + " and rerun integration.",
        }],
      });

      const newGoalResult = await createGoal(store, config, {
        user_request: intRepairGoal.user_request,
        goal_prompt: intRepairGoal.goal_prompt,
        title: "Repair: " + (task.title || task.id) + " (integration attempt " + (intRepairGoal.repair_attempt || 1) + ")",
        project_id: task.project_id || "default",
        workspace_id: task.workspace_id || "hosted-default",
        mode: "full",
        assign_to_codex: true,
        skip_created_notification: false,
        ...intRepairGoal,
      });

      await transitionTaskForWorker(
        store, task, "waiting_for_repair",
        "[worker] integration retry failed, created repair task: " + integrationResult.status,
        { result: { integration: { ...integrationResult }, integration_retried: true, repair_goal_id: newGoalResult.goal?.id || null, repair_task_id: newGoalResult.task?.id || null } }
      );
      return { task_id: task.id, status: "waiting_for_repair", progressed: true, transitioned: true };
    }

    // Out of repair budget — escalate to review
    await transitionTaskForWorker(
      store, task, "waiting_for_review",
      "[worker] integration retry failed, no repair budget: " + (integrationResult.error || integrationResult.status),
      { result: { integration: { ...integrationResult }, integration_retried: true, repair_denied_reason: intCanRepair.reason } }
    );
    return { task_id: task.id, status: "waiting_for_review", progressed: true, transitioned: true };

  } catch (error) {
    return markTaskFailed(store, task, error, "integration retry failed");
  }
}

async function runSingleCodexTask(store, config, github, task, context, processGeneralTask) {
  let transitioned = false;
  try {
    const latestState = await store.load();
    const latestTask = typeof store.findTaskById === "function"
      ? await store.findTaskById(task.id)
      : latestState.tasks?.find((item) => item.id === task.id);
    if (!latestTask || !CODEX_ACTIVE_QUEUE_CANDIDATE_STATUSES.includes(latestTask.status)) {
      return {
        task_id: task.id,
        status: latestTask?.status || task.status,
        skipped: true,
        progressed: false,
        reason: "task status changed before worker execution",
      };
    }
    task = latestTask;
    if (isHistoricalNonActionableTask(task)) {
      return { task_id: task.id, status: task.status, skipped: true, progressed: false, reason: "historical task is non-actionable" };
    }

    // Auto-promote queued tasks to assigned.
    if (task.status === "queued") {
      await updateTask(store, task.id, (t) => {
        t.status = "assigned";
        if (!t.assignee) t.assignee = "codex";
        t.logs ||= [];
        t.logs.push({ time: new Date().toISOString(), message: "[worker] auto-assigned from queued" });
      });
      task.status = "assigned";
      transitioned = true;
    }

    // P0: Retry waiting_for_integration tasks that got stuck (lock held, etc.)
    if (task.status === "waiting_for_integration" || task.status === "integrating") {
      const result = await retryIntegrationForTask(store, config, task);
      return normalizeWorkerResult(task, result, { transitioned: result.transitioned || false });
    }

    if (task.status === "waiting_for_repair") {
      const result = await ensureRepairTaskForWaitingParent(store, config, task);
      return normalizeWorkerResult(task, result, { transitioned: result.transitioned || false });
    }

    if (isCodexSessionInventoryTask(task)) {
      const completed = await completeCodexSessionInventoryTask(store, config, github, task, context);
      return normalizeWorkerResult(task, {
        task_id: completed.task.id,
        status: completed.task.status,
        kind: completed.task.result?.kind || "unknown",
        count: completed.task.result?.sessions?.count ?? 0,
      }, { transitioned });
    }

    if (task.mode === "full") {
      if (typeof processGeneralTask !== "function") {
        return markTaskWaitingForReview(store, task, "unsupported worker mode: no general task processor is configured for this worker");
      }
      const result = await processGeneralTask(store, config, task, context, github);
      return normalizeWorkerResult(task, result, { transitioned });
    }

    return markTaskFailed(store, task, new Error(`task mode must be full, got '${task.mode || "unknown"}'`), "invalid task mode");
  } catch (error) {
    return markTaskFailed(store, task, error);
  }
}

export async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4, non_blocking = false } = {}, context = defaultTokenContext("system"), { processGeneralTask } = {}) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  let state = await store.load();
  await normalizeLegacyModes(store, state);
  const workspaceRoot = config.defaultWorkspaceRoot || config.defaultWorkspaceRootPath || null;
  let persistedSessions = [];
  if (workspaceRoot) {
    try { persistedSessions = await createCodexTuiSessionStore({ workspaceRoot }).listSessions(); } catch {}
  }
  const latestSessionByTask = new Map();
  for (const session of persistedSessions) {
    if (!session?.task_id || latestSessionByTask.has(session.task_id)) continue;
    latestSessionByTask.set(session.task_id, session);
  }
  const runtimeReconciliation = await reconcileAllActiveTaskRuntimes({
    store, config,
    sessionResolver: async (taskId) => latestSessionByTask.get(taskId) || null,
    sessionProvider: {
      sendInput: (sessionId, text) => sendCodexTuiSessionInput(sessionId, text, { workspaceRoot }),
      stop: (sessionId, options) => stopCodexTuiSession(sessionId, { ...options, workspaceRoot }),
    },
    releaseTaskLock: workspaceRoot ? (taskId) => releaseLockForTask(workspaceRoot, taskId) : null,
  }).catch((error) => ([{ action: "error", error: error.message }]));
  state = await store.load();
  const reviewRecovery = await recoverAcceptedVerifiedReviewTasks(store, maxTasks);
  const queueReconciliation = await reconcileRunningQueueItems(store);

  // Use indexed query from StateStore instead of full scan on state.tasks.
  // The query is fair across status buckets so large assigned backlogs do not
  // starve queued or waiting_for_lock tasks.
  // Added waiting_for_integration — P0 fix: prevent stuck integration tasks.
  // P0: Ensure indexes are rebuilt before querying (state may have changed since last tick)
  store._buildIndexes();
  let candidates = store.getCodexActiveQueueCandidates(
    CODEX_ACTIVE_QUEUE_CANDIDATE_STATUSES,
    maxTasks
  ).filter((task) =>
    !isHistoricalNonActionableTask(task) &&
    canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
  );

  let queueAutostart = null;
  const desiredActiveCandidates = Math.min(maxConcurrency, maxTasks);
  const availableQueueSlots = Math.max(0, desiredActiveCandidates - candidates.length);
  if (availableQueueSlots > 0) {
    const batchAutostart = await startQueuedGoals(store, config, { max_start: availableQueueSlots, require_auto_start: true }).catch((error) => ({
      started_count: 0,
      any_started: false,
      results: [],
      reason: `queue autostart failed: ${errorMessage(error)}`,
    }));
    queueAutostart = {
      ...batchAutostart,
      started: Boolean(batchAutostart.any_started || batchAutostart.started_count > 0),
    };
    if (queueAutostart.started) {
      candidates = store.getCodexActiveQueueCandidates(
        CODEX_ACTIVE_QUEUE_CANDIDATE_STATUSES,
        maxTasks
      ).filter((task) =>
        !isHistoricalNonActionableTask(task) &&
        canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
      );
    }
  }

  let results;
  if (non_blocking) {
    results = candidates.map((task) => {
      const launched = launchTaskInBackground(task.id, () => runSingleCodexTask(store, config, github, task, context, processGeneralTask));
      return {
        task_id: task.id,
        status: launched.started ? "starting" : (task.status || "running"),
        started: launched.started,
        skipped: !launched.started,
        progressed: launched.started,
        background: true,
        reason: launched.started ? "background execution started" : "background execution already active",
      };
    });
  } else {
    results = await mapConcurrent(candidates, maxConcurrency, (task) =>
      runSingleCodexTask(store, config, github, task, context, processGeneralTask)
    );
  }

  const completed = results.filter((item) => isCompletedStatus(item.status)).length;
  const failed = results.filter((item) => item.failed || item.status === TASK_STATUSES.FAILED).length;
  const skipped = results.filter((item) => item.skipped).length;
  const transitioned = results.filter((item) => item.transitioned).length;
  const progressed = results.filter((item) => item.progressed).length;
  // P0: Stale-state sweeper — auto-resolve tasks stuck in non-terminal states
  try {
    const now = Date.now();
    const sweepActions = sweepStaleTaskStates({ tasks: (store.state && store.state.tasks) || [], now });
    if (Array.isArray(sweepActions) && sweepActions.length > 0) {
      const sweepResult = await applySweepActions(store, sweepActions);
      if (sweepResult.applied && sweepResult.applied > 0) {
        Object.assign(results, { swept: sweepResult.applied, sweep_errors: sweepResult.errors });
      }
    }
  } catch (sweepErr) {
    Object.assign(results, { sweep_error: sweepErr.message });
  }


  return {
    ok: true,
    inspected: candidates.length,
    concurrency: maxConcurrency,
    queue_autostart: queueAutostart,
    review_recovery: reviewRecovery,
    queue_reconciliation: queueReconciliation,
    runtime_reconciliation: runtimeReconciliation,
    completed,
    failed,
    skipped,
    transitioned,
    progressed,
    tasks: results
  };
}

// ---------------------------------------------------------------------------
// Generic concurrent map helper
// ---------------------------------------------------------------------------
