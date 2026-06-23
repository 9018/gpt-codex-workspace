import {
  scanPendingRestartMarkers,
  scheduleServiceRestart,
  validateWorkspaceRoot,
} from './safe-restart.mjs';
import { getRestartStrategy } from './restart-strategy.mjs';

export async function handleScheduleServiceRestart(
  { task_id, expected_commit = null, expected_remote_head = null } = {},
  { config, store, requestedBy = 'codex', serviceName } = {},
) {
  const workspaceRoot = config?.defaultWorkspaceRoot;
  const validation = validateWorkspaceRoot(workspaceRoot);
  if (!validation.valid) return { ok: false, error: validation.reason };

  // Determine restart strategy from config
  const restartStrategy = config ? getRestartStrategy(config) : null;
  const restartMode = restartStrategy ? restartStrategy.mode : 'npm';

  return scheduleServiceRestart({
    workspaceRoot,
    taskId: task_id,
    requestedBy,
    serviceName: serviceName || `gptwork-mcp (${restartMode}-managed)`,
    expectedCommit: expected_commit,
    expectedRemoteHead: expected_remote_head,
    repoPath: config?.defaultRepoPath,
    store,
    restartConfig: restartStrategy,
  });
}

export async function handleListPendingRestarts(_args = {}, { config } = {}) {
  const markers = await scanPendingRestartMarkers(config?.defaultWorkspaceRoot);
  return { count: markers.length, markers };
}
