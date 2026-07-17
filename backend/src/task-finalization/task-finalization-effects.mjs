import { assertValidUnifiedDecision } from "../domain/unified-decision-validator.mjs";
import { applyGoalStateProjection } from "./goal-state-projection.mjs";
import { applyTaskStateProjection } from "./task-state-projection.mjs";

export function buildProgressionDecision({ task = {}, goal = null, taskResult = {}, doneAt, config = {} } = {}) {
  const unifiedDecision = taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision;
  if (!unifiedDecision || typeof unifiedDecision !== "object") return null;
  const revision = task.decision_revision
    ?? taskResult.finalizer_decision?.revision
    ?? doneAt
    ?? unifiedDecision.revision
    ?? unifiedDecision.decision_revision;
  const evidenceRevision = task.evidence_revision
    ?? taskResult.evidence_revision
    ?? taskResult.verification?.revision
    ?? taskResult.contract_verification?.revision
    ?? doneAt
    ?? unifiedDecision.evidence_revision
    ?? revision;
  const progressionDecision = {
    ...unifiedDecision,
    task_id: task.id,
    goal_id: goal?.id || task.goal_id || null,
    revision,
    decision_revision: revision,
    evidence_revision: evidenceRevision,
    normalized_at: doneAt ?? revision,
    integration: {
      ...(taskResult.integration || {}),
      source_commit: taskResult.integration?.source_commit
        || taskResult.integration?.commit
        || taskResult.commit
        || null,
      target_branch: taskResult.integration?.target_branch
        || config.defaultBranch
        || "main",
    },
    worktree_effect: taskResult.finalizer_decision?.worktree_effect
      || unifiedDecision.worktree_effect
      || null,
  };
  assertValidUnifiedDecision(progressionDecision);
  return progressionDecision;
}

export async function runPostFinalizationEffects({
  store,
  task,
  taskResult = {},
  github,
  convergeStaleGoalStatusesFn,
  logFn = () => {},
} = {}) {
  const report = {};

  try {
    const syncResult = await github.syncTask(task);
    taskResult.github_sync = {
      ok: syncResult?.ok === true,
      issue: syncResult?.issue || null,
      updated: syncResult?.updated === true || syncResult?.created === true || false,
      comment_posted: syncResult?.comment_posted === true,
    };
  } catch (error) {
    taskResult.github_sync = { ok: false, error: error?.message || String(error) };
  }
  report.github_sync = taskResult.github_sync;

  try {
    const sweepChanges = await convergeStaleGoalStatusesFn(store);
    report.goal_sweep = { ok: true, count: Array.isArray(sweepChanges) ? sweepChanges.length : 0 };
    if (report.goal_sweep.count > 0) {
      logFn(`[gptwork-worker] goal sweep: converged ${report.goal_sweep.count} stale goal(s)\n`);
    }
  } catch (error) {
    report.goal_sweep = { ok: false, error: error?.message || String(error) };
  }

  return report;
}

export async function runCompletedTaskAutoStart({
  taskStatus,
  store,
  config,
  task,
  autoStartNextOnTaskCompletedFn,
} = {}) {
  if (taskStatus !== "completed") return null;
  try {
    return await autoStartNextOnTaskCompletedFn(store, config, task);
  } catch (err) {
    return { auto_started: false, error: err?.message || String(err), details: [] };
  }
}

export async function writeGoalFinalizationArtifacts({
  store,
  config,
  workspace,
  workspaceFiles = {},
  context,
  goal,
  task = {},
  taskStatus,
  taskResult = {},
  summary = "",
  doneAt,
  resultJsonPath,
  writeWorkspaceTextInternalFn,
  appendGoalMessageFn,
  writeFileFn,
  buildFallbackResultJsonFn,
} = {}) {
  if (!goal) return { wrote_result_md: false, wrote_goal_message: false, wrote_result_json: false, reason: "no_goal" };
  const statusLabels = {
    completed: "Completed",
    failed: "Failed",
    timed_out: "Timed out",
    waiting_for_review: "Waiting for review",
    waiting_for_integration: "Waiting for integration",
    waiting_for_repair: "Waiting for repair",
    blocked: "Blocked",
  };
  const statusLabel = statusLabels[taskStatus] || taskStatus;

  await writeWorkspaceTextInternalFn(store, config, goal.workspace_id, workspaceFiles.result_md,
    "# Result\n\n" + summary + "\n\n" + statusLabel + " at: " + doneAt + "\n", context);
  await appendGoalMessageFn(store, config, {
    goal_id: goal.id,
    role: "codex",
    content: "[worker] " + statusLabel + " task " + task.id + ".\n\n" + summary,
    memory_key: "codex_last_result",
    memory_value: summary.slice(0, 4000),
  }, context);

  const fallbackResultJsonPath = resultJsonPath || (workspace.root + "/.gptwork/goals/" + goal.id + "/result.json");
  let wroteResultJson = false;
  try {
    const fallbackResultJson = buildFallbackResultJsonFn({ taskStatus, taskResult, summary });
    await writeFileFn(fallbackResultJsonPath, JSON.stringify(fallbackResultJson, null, 2) + "\n", "utf8");
    wroteResultJson = true;
  } catch {}

  return {
    wrote_result_md: true,
    wrote_goal_message: true,
    wrote_result_json: wroteResultJson,
    result_json_path: fallbackResultJsonPath,
  };
}

export async function mutateFinalTaskState({
  store,
  task,
  taskStatus,
  taskResult,
  doneAt,
  cr,
  config,
  goal,
  progressionDecision,
  reconcileProgressionCommandsInStateFn,
} = {}) {
  return store.mutate(async (state) => {
    state.tasks ||= [];
    state.goals ||= [];
    state.activities ||= [];
    const item = state.tasks.find((candidate) => candidate.id === task.id);
    if (!item) throw new Error(`task not found: ${task.id}`);
    applyTaskStateProjection(item, { taskStatus, taskResult, doneAt, cr, config });
    if (progressionDecision?.revision !== undefined && progressionDecision?.revision !== null) {
      item.decision_revision = progressionDecision.revision;
    }
    item.updated_at = new Date().toISOString();
    state.activities.push({ time: item.updated_at, type: "task.updated", task_id: task.id, status: item.status });

    let goalStatus = null;
    if (goal) {
      const goalItem = state.goals.find((candidate) => candidate.id === goal.id);
      if (goalItem) {
        goalStatus = applyGoalStateProjection(goalItem, { task: item, taskStatus, taskResult: item.result || taskResult, state, doneAt });
        state.activities.push({ time: doneAt, type: `goal.${goalStatus}`, goal_id: goalItem.id, title: goalItem.title });
      }
    }

    if (Array.isArray(state.goal_queue)) {
      const queueItem = state.goal_queue.find((candidate) => candidate.task_id === task.id || (goal && candidate.goal_id === goal.id && candidate.status === "running"));
      if (queueItem) {
        queueItem.status = taskStatus;
        queueItem.failure_class = taskResult.failure_class || taskResult.verification?.failure_class || null;
        queueItem.completed_task_id = task.id;
        queueItem.updated_at = doneAt;
        if (taskStatus !== "completed") {
          queueItem.blocked_reason = taskResult.reason || taskResult.repair_denied_reason || taskResult.summary || null;
        } else {
          queueItem.blocked_reason = null;
        }
      }
    }
    reconcileAcceptedQueuePropagation(state, { task, item, goal, goalStatus, taskStatus, taskResult, doneAt });
    const progressionReport = progressionDecision
      ? reconcileProgressionCommandsInStateFn({
          state,
          decisions: [progressionDecision],
          now: () => doneAt,
        })
      : null;
    return { task: item, progression_commands: progressionReport };
  });
}

export async function runFinalizationStateTransition({
  store,
  config = {},
  task,
  goal = null,
  taskStatus,
  taskResult = {},
  doneAt,
  cr,
  workspace,
  workspaceFiles,
  summary = "",
  context,
  repoLockPath,
  resultJsonPath,
  github,
  reconciliationResult = null,
  buildProgressionDecisionFn = buildProgressionDecision,
  mutateFinalTaskStateFn = mutateFinalTaskState,
  updateTaskFn,
  applyTaskStateProjectionFn = applyTaskStateProjection,
  reconcileProgressionCommandsInStateFn,
  runFinalizationPostStateEffectsFn = runFinalizationPostStateEffects,
  ...postStateEffectFns
} = {}) {
  const progressionDecision = buildProgressionDecisionFn({
    task,
    goal,
    taskResult,
    doneAt,
    config,
  });
  const result = typeof store.mutate === "function"
    ? await mutateFinalTaskStateFn({
        store,
        task,
        taskStatus,
        taskResult,
        doneAt,
        cr,
        config,
        goal,
        progressionDecision,
        reconcileProgressionCommandsInStateFn,
      })
    : await updateTaskFn(store, task.id, (item) => {
        applyTaskStateProjectionFn(item, { taskStatus, taskResult, doneAt, cr, config });
      });
  const progressionReport = result?.progression_commands || null;

  return await runFinalizationPostStateEffectsFn({
    store,
    config,
    task,
    finalTask: result.task,
    goal,
    taskStatus,
    taskResult,
    summary,
    doneAt,
    workspace,
    workspaceFiles,
    context,
    repoLockPath,
    resultJsonPath,
    progressionReport,
    github,
    reconciliationResult,
    ...postStateEffectFns,
  });
}

export async function runFinalizationPostStateEffects({
  store,
  config = {},
  task = {},
  finalTask = null,
  goal = null,
  taskStatus,
  taskResult = {},
  summary = "",
  doneAt,
  workspace,
  workspaceFiles,
  context,
  repoLockPath,
  resultJsonPath,
  progressionReport = null,
  github,
  reconciliationResult = null,
  updateWorkstreamContextFromCompletedTaskFn,
  releaseFinalizationRepoLockFn,
  loadRestartMarkerFn,
  releaseRepoLockFn,
  updateGoalStatusFn,
  writeWorkspaceTextInternalFn,
  appendGoalMessageFn,
  writeFileFn,
  buildFallbackResultJsonFn,
  autoStartNextOnTaskCompletedFn,
  propagateRepairChildCompletionFn,
  handleRepairCompletionFn,
  runPostFinalizationEffectsFn = runPostFinalizationEffects,
  goalStatusFromReconciliationFn = () => null,
  projectGoalStatusForFinalizedTaskFn,
  logFn = () => {},
} = {}) {
  const effectiveTask = finalTask || task;
  if (taskStatus === "completed" && (task.workstream_id || goal?.workstream_id)) {
    const outcomeUpdate = await updateWorkstreamContextFromCompletedTaskFn({
      store,
      workspaceRoot: config.defaultWorkspaceRoot,
      task: effectiveTask || { ...task, status: taskStatus },
      goal,
      result: taskResult,
    }).catch((error) => ({ applied: false, reason: error.message }));
    taskResult.workstream_context_update = outcomeUpdate;
  }

  await releaseFinalizationRepoLockFn({
    config,
    task,
    repoLockPath,
    loadRestartMarkerFn,
    releaseRepoLockFn,
  });

  if (goal) {
    const canonicalGoalStatus = goalStatusFromReconciliationFn(reconciliationResult);
    const goalStatus = canonicalGoalStatus || projectGoalStatusForFinalizedTaskFn({
      goal,
      task: effectiveTask || task,
      taskStatus,
      taskResult,
      state: store.state || {},
    });
    if (typeof store.mutate !== "function") {
      await updateGoalStatusFn(store, goal.id, goalStatus, doneAt);
    }
    await writeGoalFinalizationArtifacts({
      store,
      config,
      workspace,
      workspaceFiles,
      context,
      goal,
      task,
      taskStatus,
      taskResult,
      summary,
      doneAt,
      resultJsonPath,
      writeWorkspaceTextInternalFn,
      appendGoalMessageFn,
      writeFileFn,
      buildFallbackResultJsonFn,
    });
  }

  const autoStartResult = await runCompletedTaskAutoStart({
    taskStatus,
    store,
    config,
    task: effectiveTask,
    autoStartNextOnTaskCompletedFn,
  });

  await propagateRepairChildCompletionFn({
    task,
    taskStatus,
    taskResult,
    finalTask: effectiveTask,
    store,
    config,
    handleRepairCompletionFn,
    logFn,
  });

  await runPostFinalizationEffectsFn({
    store,
    task: effectiveTask,
    taskResult,
    github,
    logFn,
  });

  return {
    task_id: effectiveTask.id,
    status: taskStatus,
    kind: taskResult.kind,
    auto_start: autoStartResult,
    progression_commands: progressionReport,
  };
}

function reconcileAcceptedQueuePropagation(state, { task, item, goal, goalStatus, taskStatus, taskResult, doneAt } = {}) {
  if (!Array.isArray(state.goal_queue)) return;
  if (!goal || !shouldPropagateAcceptedQueueCompletion({ taskStatus, taskResult })) return;

  const goalId = goal.id;
  if (goalStatus !== "completed") {
    const goalItem = Array.isArray(state.goals) ? state.goals.find((candidate) => candidate.id === goalId) : null;
    if (!goalItem || goalItem.status !== "completed") return;
  }

  const current = state.goal_queue.find((candidate) => candidate.task_id === task.id || candidate.goal_id === goalId);
  if (current && current.status !== "completed") {
    current.status = "completed";
    current.completed_task_id = task.id;
    current.failure_class = null;
    current.blocked_reason = null;
    current.updated_at = doneAt;
  }

  for (const candidate of state.goal_queue) {
    if (candidate.depends_on_goal_id !== goalId) continue;
    if (candidate.status !== "blocked") continue;
    if (!isGoalDependencyReasonFor(goalId, candidate.blocked_reason)) continue;
    candidate.status = candidate.auto_start === false ? "waiting" : "ready";
    candidate.blocked_reason = null;
    candidate.updated_at = doneAt;
    state.activities ||= [];
    state.activities.push({
      time: doneAt,
      type: "queue.dependency_reconciled",
      queue_id: candidate.queue_id,
      goal_id: candidate.goal_id,
      depends_on_goal_id: goalId,
      completed_task_id: item.id,
    });
  }
}

function unresolvedBlockingFindings(findings = []) {
  return Array.isArray(findings)
    ? findings.filter((finding) => (finding?.severity === "blocker" || finding?.severity === "major") && finding?.resolved !== true)
    : [];
}

function acceptedByAcceptanceAgent(taskResult = {}) {
  const decision = taskResult.reviewer_decision || {};
  if (decision.passed === true) return true;
  if (decision.status === "accepted" || decision.decision === "accepted") return true;
  if (decision.decision?.passed === true) return true;
  if (decision.decision?.status === "accepted" || decision.decision?.decision === "accepted") return true;
  return false;
}

function closureAllowsQueuePropagation(taskResult = {}) {
  const unifiedDecision = taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision || {};
  if (unifiedDecision.queue_effect?.unblock_dependents === true) return true;
  if (unifiedDecision.safe_to_auto_advance === true) return true;
  if (unifiedDecision.integration_effect?.satisfied === true) return true;

  const status = taskResult.closure_decision?.status;
  return status === "auto_completed_clean" || status === "auto_completed_with_followups";
}

function integrationVerifiedForQueuePropagation(taskResult = {}) {
  const integration = taskResult.integration || {};
  const autoCompletion = taskResult.auto_integration_completion || {};
  const report = autoCompletion.verification_report || {};
  if (autoCompletion.attempted === true && (report.dirty === true || autoCompletion.canonical_clean_after === false)) return false;

  const unifiedDecision = taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision || {};
  if (unifiedDecision.integration_effect?.satisfied === true) return true;

  const merged = integration.merged === true
    || integration.satisfied === true
    || ["merged", "ff_only_merged", "skipped", "already_integrated", "not_required"].includes(String(integration.status || ""));
  const autoCompleted = autoCompletion.completed === true
    && report.passed !== false
    && report.dirty !== true
    && autoCompletion.canonical_clean_after !== false;

  if (integration.satisfied === true || ["already_integrated", "not_required", "skipped"].includes(String(integration.status || ""))) return true;
  return merged && autoCompleted;
}

function shouldPropagateAcceptedQueueCompletion({ taskStatus, taskResult = {} } = {}) {
  if (taskStatus !== "completed") return false;

  const ud = taskResult.unified_decision || {};
  if (taskResult.requires_review === true) return false;
  if (!acceptedByAcceptanceAgent(taskResult)) return false;
  if (taskResult.contract_verification?.blocking_passed === false) return false;
  if (taskResult.contract_verification?.completion_eligible === false) return false;
  if (taskResult.contract_verification?.requires_review === true) return false;
  if (!integrationVerifiedForQueuePropagation(taskResult)) return false;
  if (ud.queue_effect?.unblock_dependents === true) return true;

  if (ud.queue_effect?.hold_queue === true) return false;
  if (ud.status === "failed" || ud.status === "timed_out" || ud.status === "blocked") return false;

  if (taskResult.requires_review === true) return false;
  if (!acceptedByAcceptanceAgent(taskResult)) return false;

  const unifiedDecision = taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision || {};
  if (unifiedDecision.queue_effect?.unblock_dependents === true) return true;
  if (unifiedDecision.safe_to_auto_advance === true) return true;

  if (!closureAllowsQueuePropagation(taskResult)) return false;
  if (!integrationVerifiedForQueuePropagation(taskResult)) return false;
  if (taskResult.contract_verification?.blocking_passed === false) return false;
  if (taskResult.contract_verification?.completion_eligible === false) return false;
  if (taskResult.contract_verification?.requires_review === true) return false;
  return unresolvedBlockingFindings(taskResult.acceptance_findings).length === 0;
}

function isGoalDependencyReasonFor(goalId, reason = "") {
  const text = String(reason || "");
  return text.includes(`depends_on_goal ${goalId}`) || text.includes(`depends_on_goal_id ${goalId}`);
}
