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
