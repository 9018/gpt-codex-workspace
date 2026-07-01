/**
 * github-adapter.mjs — compatibility facade for GitHub sync helpers.
 *
 * In addition to the legacy convenience exports, this module provides
 * `createGithubControlAdapter()` which wraps the GitHub sync factory into
 * the **ExternalControlAdapter contract** defined in
 * `external-control-adapter.mjs`.
 *
 * @see external-control-adapter.mjs — Contract & Registry
 */

export { parseRepo, parseIssueNumber } from "./github-adapter-utils.mjs";
export { createGithubSync } from "./github-sync-factory.mjs";
export {
  checkDirectGitAvailable,
  checkSshAuthAvailable,
  checkGhCliAvailable,
  detectWorkspaceRepo,
  grabIssue,
  getStatusWithAsyncChecks,
  syncToGitHubResult,
} from "./github-connectivity.mjs";

import { createGithubSync } from "./github-sync-factory.mjs";

/**
 * Create a GitHub Issues external control adapter.
 *
 * Wraps the result of `createGithubSync()` into the `ExternalControlAdapter`
 * contract so it can be registered with `createAdapterRegistry()`.
 *
 * When GitHub is not configured (`sync.enabled === false`) the adapter is
 * still created but all operations return harmless no-op results.  Callers
 * should check `adapter.enabled` before relying on external data.
 *
 * @param {object} config  Same config object as `createGithubSync(config)`.
 * @param {string} [config.githubRepo]
 * @param {string} [config.githubToken]
 * @param {boolean} [config.githubEnabled]
 * @param {string} [config.defaultWorkspaceRoot]
 * @returns {object}  An ExternalControlAdapter-compliant object.
 *
 * @example
 * import { createGithubControlAdapter } from "./github-adapter.mjs";
 * import { createAdapterRegistry } from "./external-control-adapter.mjs";
 *
 * const registry = createAdapterRegistry();
 * const github = createGithubControlAdapter({ githubRepo, githubToken });
 * registry.register("github-issues", github);
 */
export function createGithubControlAdapter(config) {
  const sync = createGithubSync(config);

  return {
    name: "github-issues",
    enabled: sync.enabled,

    /** The underlying github sync instance (for backward compat access). */
    _sync: sync,

    /** Mirror local state to GitHub Issues (tasks + requests). */
    async mirrorState(state) {
      if (!sync.enabled) {
        return { ok: false, count: 0, details: { reason: "github not configured" } };
      }
      const tasks = (state.tasks || []).filter(
        (t) => t.status !== "completed" && t.status !== "cancelled"
      );
      const requests = (state.chatgpt_requests || []).filter((r) => r.status === "open");
      const [taskResults, requestResults] = await Promise.all([
        sync.syncAllTasks(tasks),
        sync.syncAllRequests(requests),
      ]);
      return {
        ok: true,
        count: (taskResults || []).length + (requestResults || []).length,
        details: { tasks_synced: (taskResults || []).length, requests_synced: (requestResults || []).length },
      };
    },

    /** Import new tasks from open GitHub Issues. */
    async importState(store, opts = {}) {
      if (!sync.enabled) return { imported: [], skipped: [{ reason: "github not configured" }], diagnostics: {} };
      const imported = await sync.importFromIssues(store, opts);
      return { imported, skipped: [], diagnostics: sync.getSyncDiagnostics() };
    },

    /** Read ChatGPT responses from GitHub Issue comments. */
    async readCommands(store) {
      if (!sync.enabled) return { commands: [], imported: [], details: { reason: "github not configured" } };
      const responses = await sync.importResponsesFromComments(store);
      return {
        commands: responses.map((r) => ({ type: "comment_response", request_id: r.request_id, response: r.response, user: r.user })),
        imported: responses,
        details: { comment_count: responses.length },
      };
    },

    status() { return sync.status(); },

    getDiagnostics() {
      return typeof sync.getSyncDiagnostics === "function" ? sync.getSyncDiagnostics() : {};
    },
  };
}
