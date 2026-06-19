import {
  scanPendingRestartMarkers,
  scheduleServiceRestart,
  validateWorkspaceRoot,
} from './safe-restart.mjs';

export async function handleScheduleServiceRestart(
  { task_id, expected_commit = null, expected_remote_head = null } = {},
  { config, store, requestedBy = 'codex', serviceName = 'gptwork-mcp.service' } = {},
) {
  const workspaceRoot = config?.defaultWorkspaceRoot;
  const validation = validateWorkspaceRoot(workspaceRoot);
  if (!validation.valid) return { ok: false, error: validation.reason };

  return scheduleServiceRestart({
    workspaceRoot,
    taskId: task_id,
    requestedBy,
    serviceName,
    expectedCommit: expected_commit,
    expectedRemoteHead: expected_remote_head,
    repoPath: config?.defaultRepoPath,
    store,
  });
}

export async function handleListPendingRestarts(_args = {}, { config } = {}) {
  const markers = await scanPendingRestartMarkers(config?.defaultWorkspaceRoot);
  return { count: markers.length, markers };
}
