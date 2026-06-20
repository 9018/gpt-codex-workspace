/**
 * System diagnostics MCP tool registration group.
 *
 * Extracted from gptwork-server.mjs as part of P4 tool group extraction.
 * Lightweight system/user/activity/worker/notification diagnostics.
 *
 * Dependencies:
 *   tool   - MCP tool factory from tool-registry.mjs
 *   schema - schema factory from mcp-tooling.mjs
 *   store  - StateStore instance
 *   bark   - Bark notifier instance
 *   workerState - worker state tracking object
 *   collectWorkerQueueCounts - function to collect queue counts
 */
import { workerStatusSnapshot } from "../codex-worker-state.mjs";

export function createSystemDiagnosticsToolsGroup({ tool, schema, store, bark, workerState, collectWorkerQueueCounts }) {
  return {
    health_check: tool("Check whether the GPTWork MCP server is running.", schema({}), async () => ({ ok: true, service: "gptwork-mcp", time: new Date().toISOString() })),
    get_current_user: tool("Return the current token-bound user context.", schema({}), async (_args, context) => ({
      user: { id: context.user_id, name: context.user_name },
      team_id: context.team_id,
      project_ids: context.project_ids,
      workspace_ids: context.workspace_ids,
      scopes: context.scopes
    })),
    list_recent_activity: tool("List recent project activity.", schema({ limit: "integer" }), async ({ limit = 50 }) => {
      const state = await store.load();
      return { activities: state.activities.slice(-limit).reverse() };
    }),
    test_bark_notification: tool("Send a test Bark notification and return safe diagnostic result without exposing endpoint/key values.", schema({}), async () => bark ? bark.testSend() : ({ ok: false, attempted_at: null, response_code: null, response_message: null, source: "unknown", group: "gptwork", endpoint_kind: "none", error_short: "bark not initialized" })),
    worker_status: tool("Return Codex worker status: enabled, running, last tick timing, queue counts (assigned, queued, running, waiting_for_lock, waiting_for_review, completed, failed).", schema({}), async () => {
      const queue = await collectWorkerQueueCounts(store);
      return { ...workerStatusSnapshot(workerState), queue, queues: queue };
    }),
  };
}
