export function createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary }) {
  async function repoLockStatusHandler() {
    const lockList = await listRepoLocks(config.defaultWorkspaceRoot);
    const lockSummary = await getRepoLockSummary(config.defaultWorkspaceRoot);
    return {
      active_repo_locks: lockSummary.active_repo_locks,
      stale_repo_locks: lockSummary.stale_repo_locks,
      locks: lockList,
    };
  }

  return {
    list_repo_locks: tool(
      'List repo execution locks with safe diagnostics. Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)',
      schema({}),
      repoLockStatusHandler,
    ),
    repo_lock_status: tool(
      'List repo execution locks with safe diagnostics (alias for list_repo_locks). Returns active and stale locks with task ids and repo identifiers. Helps detect concurrent Codex execution conflicts. No secrets exposed. (查看仓库执行锁状态)',
      schema({}),
      repoLockStatusHandler,
    ),
  };
}
