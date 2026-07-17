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
