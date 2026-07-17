import { assertValidUnifiedDecision } from "../domain/unified-decision-validator.mjs";

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
