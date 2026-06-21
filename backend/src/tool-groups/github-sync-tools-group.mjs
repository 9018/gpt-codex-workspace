/**
 * Scoped MCP tool group: GitHub issue sync tools.
 * Handlers sync tasks and ChatGPT requests to/from GitHub Issues,
 * preserving auth context behavior, GitHub adapter behavior, and response shapes exactly.
 */
export function createGithubSyncToolsGroup({ tool, schema, store, github }) {
  return {
    sync_to_github: tool("Sync all open tasks and ChatGPT requests to GitHub Issues.", schema({}), async () => {
      const state = await store.load();
      const tasks = state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
      const requests = (state.chatgpt_requests || []).filter((r) => r.status === 'open');
      const taskResults = await github.syncAllTasks(tasks);
      const requestResults = await github.syncAllRequests(requests);
      return { options: { github_repo: process.env.GPTWORK_GITHUB_REPO || '(not set)', github_enabled: github.enabled }, synced_tasks: taskResults.length, synced_requests: requestResults.length, taskResults, requestResults };
    }),
    sync_from_github: tool("Import open GitHub Issues as tasks, and import GitHub Issue comments as ChatGPT responses. This is the no-reverse-proxy flow: ChatGPT creates GitHub Issues, Codex imports and works on them, results sync back. Also detects ChatGPT responses in issue comments.", schema({}), async () => {
      const imported = await github.importFromIssues(store);
      const responses = await github.importResponsesFromComments(store);
      const syncDiag = typeof github.getSyncDiagnostics === "function" ? github.getSyncDiagnostics() : {};
      return {
        imported_tasks: imported.length,
        tasks: imported.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        imported_responses: responses.length,
        responses: responses.map((r) => ({ request_id: r.request_id, responded_by: r.user })),
        last_sync_at: syncDiag.last_sync_at || null,
        last_sync_ok: syncDiag.last_sync_ok,
        last_sync_error: syncDiag.last_sync_error || null,
        last_imported_tasks: syncDiag.last_imported_tasks ?? 0,
        last_imported_responses: syncDiag.last_imported_responses ?? 0,
        last_scanned_issue_count: syncDiag.last_scanned_issue_count ?? 0,
        last_raw_api_issue_count: syncDiag.last_raw_api_issue_count ?? 0,
        skipped_reasons: syncDiag.skipped_reasons || [],
      };
    }),
  };
}
