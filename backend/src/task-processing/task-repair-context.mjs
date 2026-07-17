const REPAIR_METADATA_KEYS = [
  "root_task_id",
  "parent_task_id",
  "repair_attempt",
  "max_attempts",
  "repair_of_goal_id",
  "repair_of_task_id",
  "repair_of_worktree",
  "repair_of_branch",
];

export function applyRepairMetadata(args = {}, repairGoal = {}) {
  for (const key of REPAIR_METADATA_KEYS) {
    if (repairGoal[key] !== undefined) args[key] = repairGoal[key];
  }
  return args;
}

export function taskWithRepairContext(task, resolvedRepo) {
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
