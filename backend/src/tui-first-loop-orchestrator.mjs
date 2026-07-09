import { ensureGoalWorkspace } from './goal-worktree-service.mjs';
import { runStage } from './stage-loop-service.mjs';
import { collectEvidenceBundle } from './evidence-bundle-service.mjs';
import { previewMergeGate, applyMergeGate } from './merge-gate-service.mjs';

export async function startTuiFirstGoalLoop({ goal, task = null, config }) {
  const workspace = await ensureGoalWorkspace({ goal, config });
  const execute = await runStage({ goal, task, stage: 'execute', workspace, config });
  return { goal_id: goal.id, state: 'execute_running', workspace, execute };
}

export async function rescanAndAccept({ goal, task = null, workspace, config }) {
  const evidence = await collectEvidenceBundle({ goalId: goal.id, workspace });
  if (!evidence.result_md_present || !evidence.result_json_present) {
    return { goal_id: goal.id, state: 'execute_evidence_waiting', evidence };
  }
  const accept = await runStage({ goal, task, stage: 'accept', workspace, config });
  return { goal_id: goal.id, state: 'accept_running', evidence, accept };
}

export async function mergeAndAdvance({ goal, task = null, workspace, config }) {
  const mergeDecision = await previewMergeGate({ goalId: goal.id, workspace, config });
  if (mergeDecision.decision !== 'merge') return { goal_id: goal.id, state: 'merge_blocked', mergeDecision };

  const mergeResult = await applyMergeGate({ goalId: goal.id, workspace, config });
  const advance = await runStage({ goal, task, stage: 'advance', workspace, config });
  return { goal_id: goal.id, state: 'advance_running', mergeResult, advance };
}
