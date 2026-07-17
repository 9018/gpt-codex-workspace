export function createTaskExecutionContext({ task, goal, workspace, config, resolvedRepo, executionCwd, runId = null }) {
  const goalId = goal?.id || task.id;
  const goalStateDir = `${config.defaultWorkspaceRoot}/.gptwork/goals/${goalId}`;
  return {
    task,
    goal,
    workspace,
    resolvedRepo,
    executionCwd,
    runId,
    goalStateDir,
    resultJsonPath: `${goalStateDir}/result.json`,
    resultMdPath: `${goalStateDir}/result.md`,
    executionRepoPath: executionCwd || resolvedRepo?.task_worktree_path || resolvedRepo?.canonical_repo_path || config.defaultRepoPath,
  };
}
