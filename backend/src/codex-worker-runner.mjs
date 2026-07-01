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
import { createRepairGoalFromFindings, shouldAttemptRepair, handleRepairCompletion } from "./repair-loop.mjs";
import { createGoal } from "./goal-task-goals.mjs";
import { sanitizeTaskBranchName } from "./task-worktree-manager.mjs";
import { sweepStaleTaskStates, applySweepActions } from "./stale-state-sweeper.mjs";
import { ACTIVE_EXECUTION_STATUSES, TASK_STATUSES, isCompletedStatus } from "./task-status-taxonomy.mjs";

const CODEX_ACTIVE_QUEUE_CANDIDATE_STATUSES = [
  ...ACTIVE_EXECUTION_STATUSES,
].filter((status) => status !== TASK_STATUSES.RUNNING);

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
    await transitionTaskForWorker(store, task, "waiting_for_review", `[worker] ${reason}`);
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

function shouldRecoverAcceptedVerifiedReviewTask(task = {}) {
  if (task.status !== TASK_STATUSES.WAITING_FOR_REVIEW) return false;
  const result = task.result || {};
  if (result.kind === "codex_failed" || result.kind === "codex_timeout" || result.kind === "no_first_output_timeout") return false;
  if (acceptedByReviewer(result) !== true) return false;
  if (result.verification?.passed !== true) return false;
  if (unresolvedBlockingFindings(result).length > 0) return false;
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files.filter(Boolean) : [];
  if (changedFiles.length > 0 && !result.commit) return false;
  return true;
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

// ---------------------------------------------------------------------------
// Integration retry handler — P0 fix for waiting_for_integration stuck tasks
// ---------------------------------------------------------------------------
// Called by runSingleCodexTask when a task is in "waiting_for_integration"
// status.  Retries the integration queue and either completes, creates a
// repair task, or escalates to review.  Non-terminal lock states preserve
// the waiting_for_integration status for a future retry.
async function retryIntegrationForTask(store, config, task) {
  const repoResolution = task.result?.repo_resolution || task.result?.worktree_lifecycle || null;
  if (!repoResolution) {
    return markTaskWaitingForReview(store, task, "integration retry: no repo resolution in task result");
  }

  const gitPath = repoResolution.task_worktree_path || repoResolution.canonical_repo_path;
  if (!gitPath) {
    return markTaskWaitingForReview(store, task, "integration retry: no git path available");
  }

  const branchName = (repoResolution.worktree_lifecycle?.branch_name)
    || (task.result?.worktree_lifecycle?.branch_name)
    || null;

  try {
    const integrationResult = await runIntegrationQueue({
      repoId: repoResolution.repo_id || task.repo_id || "default",
      targetBranch: config.defaultBranch || "main",
      worktreePath: gitPath,
      canonicalRepoPath: repoResolution.canonical_repo_path || gitPath,
      taskBranch: branchName || sanitizeTaskBranchName(task.id),
      integrationMode: config.integrationMode || "push_branch",
      checkCommands: config.integrationCheckCommands,
      locksBasePath: config.defaultWorkspaceRoot,
      taskId: task.id,
    });

    if (integrationResult.ok) {
      // Integration completion semantics:
      // - merged === true or status === 'merged': actually merged to target branch (terminal)
      // - status === 'skipped': integration explicitly skipped (terminal)
      // - branch_pushed / pr_opened: NOT merged — not terminal
      if (integrationResult.merged === true || integrationResult.status === 'merged' || integrationResult.status === 'skipped') {
        await transitionTaskForWorker(
          store, task, "completed",
          "[worker] integration retry succeeded",
          { result: { integration: { ...integrationResult }, integration_retried: true } }
        );
      } else {
        // branch_pushed, pr_opened — not a terminal integration state
        await transitionTaskForWorker(
          store, task, "waiting_for_review",
          "[worker] integration retry: " + (integrationResult.status || "pushed") + " (not merged)",
          { result: { integration: { ...integrationResult }, integration_retried: true } }
        );
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
      return { task_id: task.id, status: "completed", progressed: true, transitioned: true };
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
        mode: intRepairGoal.mode || "builder",
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
    if (task.status === "waiting_for_integration") {
      const result = await retryIntegrationForTask(store, config, task);
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

    if (task.mode === "builder" || task.mode === "deploy" || task.mode === "admin") {
      if (typeof processGeneralTask !== "function") {
        return markTaskWaitingForReview(store, task, "no general task processor is configured for this worker");
      }
      const result = await processGeneralTask(store, config, task, context, github);
      return normalizeWorkerResult(task, result, { transitioned });
    }

    return markTaskWaitingForReview(store, task, `unsupported worker mode '${task.mode || "unknown"}'`);
  } catch (error) {
    return markTaskFailed(store, task, error);
  }
}

export async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4 } = {}, context = defaultTokenContext("system"), { processGeneralTask } = {}) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  const state = await store.load();
  await normalizeLegacyModes(store, state);
  const reviewRecovery = await recoverAcceptedVerifiedReviewTasks(store, maxTasks);

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
        canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id)
      );
    }
  }

  const results = await mapConcurrent(candidates, maxConcurrency, (task) =>
    runSingleCodexTask(store, config, github, task, context, processGeneralTask)
  );

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
