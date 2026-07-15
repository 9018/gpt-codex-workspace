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
import { workerStatusExtendedSnapshot } from "../codex-worker-state.mjs";
import { resolveEffectiveWorkerState } from "../worker-runtime-status.mjs";

export function createSystemDiagnosticsToolsGroup({ tool, schema, store, bark, workerState, collectWorkerQueueCounts, config = {} }) {
  return {
    health_check: tool({
      name: "health_check",
      description: "Check whether the GPTWork MCP server is running.",
      inputSchema: schema({}),
      modes: ["minimal", "standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "health"],
      handler: async () => ({ ok: true, service: "gptwork-mcp", time: new Date().toISOString() }),
    }),
    get_current_user: tool({
      name: "get_current_user",
      description: "Return the current token-bound user context.",
      inputSchema: schema({}),
      modes: ["standard", "full"],
      audience: ["chatgpt"],
      tags: ["system", "user"],
      handler: async (_args, context) => ({
        user: { id: context.user_id, name: context.user_name },
        team_id: context.team_id,
        project_ids: context.project_ids,
        workspace_ids: context.workspace_ids,
        scopes: context.scopes
      }),
    }),
    list_recent_activity: tool({
      name: "list_recent_activity",
      description: "List recent project activity.",
      inputSchema: schema({ limit: "integer" }),
      modes: ["standard", "full"],
      audience: ["chatgpt"],
      tags: ["system", "activity"],
      handler: async ({ limit = 50 }) => {
        const state = await store.load();
        return { activities: state.activities.slice(-limit).reverse() };
      },
    }),
    test_bark_notification: tool({
      name: "test_bark_notification",
      description: "Send a test Bark notification and return safe diagnostic result without exposing endpoint/key values.",
      inputSchema: schema({}),
      modes: ["operator", "full"],
      audience: ["operator"],
      tags: ["system", "notification"],
      handler: async () => bark ? bark.testSend() : ({ ok: false, attempted_at: null, response_code: null, response_message: null, source: "unknown", group: "gptwork", endpoint_kind: "none", error_short: "bark not initialized" }),
    }),
    worker_status: tool({
      name: "worker_status",
      description: "Return Codex worker status: enabled, running, last tick timing, queue counts (assigned, queued, running, waiting_for_lock, waiting_for_review, completed, failed).",
      inputSchema: schema({}),
      modes: ["minimal", "standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "worker"],
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async () => {
        const queue = await collectWorkerQueueCounts(store);
        return { ...workerStatusExtendedSnapshot(resolveEffectiveWorkerState(workerState, config.defaultWorkspaceRoot)), queue, queues: queue };
      },
    }),
  };
}
