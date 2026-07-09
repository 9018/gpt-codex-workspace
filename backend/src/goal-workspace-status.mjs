import { assertGoalId, goalWorktreePath, rescanGoalWorkspace } from './goal-worktree-service.mjs';

export async function readGoalWorkspace({ goalId, config }) {
  const id = assertGoalId(goalId);
  const worktreePath = goalWorktreePath({ config, goalId: id });
  const wsPath = `${worktreePath}/.gptwork/goals/${id}/workspace.json`;
  const { readFile } = await import('node:fs/promises');
  try {
    return JSON.parse(await readFile(wsPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function refreshGoalWorkspaceStatus({ goalId, config }) {
  const workspace = await readGoalWorkspace({ goalId, config });
  if (!workspace) return { goal_id: goalId, workspace_status: 'missing', worktree_path: goalWorktreePath({ config, goalId }) };

  const scan = await rescanGoalWorkspace({ goalId, config });
  return {
    ...workspace,
    candidate_head: scan.candidate_head,
    worktree_clean: scan.worktree_clean,
    dirty_status: scan.dirty_status,
    rescanned_at: scan.rescanned_at
  };
}
