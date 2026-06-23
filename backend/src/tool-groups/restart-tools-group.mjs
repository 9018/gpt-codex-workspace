import { handleScheduleServiceRestart, handleListPendingRestarts } from '../restart-tools.mjs';

export function createRestartToolsGroup({ tool, schema, config, store }) {
  return {
    schedule_service_restart: tool(
      'Schedule a safe two-phase GPTWork restart. Writes a pending restart marker and schedules a detached restart using the configured strategy (default: npm-managed). Use when the worker needs to restart itself after completing its work.',
      schema({ task_id: 'string', expected_commit: 'string', expected_remote_head: 'string' }, ['task_id']),
      async (args) => handleScheduleServiceRestart(args, { config, store }),
    ),
    list_pending_restarts: tool(
      'List all pending restart markers waiting for restart verification (Phase C startup verification).',
      schema({}),
      async (args) => handleListPendingRestarts(args, { config }),
    ),
  };
}
