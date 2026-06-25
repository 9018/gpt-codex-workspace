/**
 * Scoped MCP tool group: GitHub issue sync tools + task intake handoff tools.
 * Handlers sync tasks and ChatGPT requests to/from GitHub Issues,
 * and import task handoffs from GitHub Issues, ChatGPT requests, and local inbox files.
 */
export function createGithubSyncToolsGroup({ tool, schema, store, github, config }) {
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
    import_task_handoffs: tool(
      "Scan task intake sources (GitHub Issues, ChatGPT requests, local inbox) and report or import executable Codex tasks. Safe: dry_run=true by default, only reports what would be imported. Set apply=true and dry_run=false to actually create tasks.",
      schema({
        source: { type: "string", description: "Source to scan: github|request|inbox|all", default: "all", enum: ["github", "request", "inbox", "all"] },
        dry_run: { type: "boolean", description: "If true, only report what would be imported without creating tasks", default: true },
        apply: { type: "boolean", description: "If true and dry_run is false, actually create tasks", default: false }
      }, ["source"]),
      async ({ source = "all", dry_run = true, apply = false } = {}) => {
        if (apply && dry_run) return { error: "Cannot apply=true when dry_run=true. Set dry_run=false first." };
        const shouldApply = !dry_run && apply;
        const state = await store.load();
        const results = { github: [], request: [], inbox: [], skipped: [] };
        const workspaceRoot = (config && config.defaultWorkspaceRoot) || process.env.GPTWORK_WORKSPACE_ROOT || ".";
        // Scan GitHub issues for task-intake markers
        if (source === "github" || source === "all") {
          const ghImported = await github.importFromIssues(store, { dryRun: !shouldApply });
          for (const t of ghImported) results.github.push({ task_id: t.id, title: t.title, issue: t.github_issue_number });
        }
        // Scan ChatGPT requests for task_intake markers
        if (source === "request" || source === "all") {
          const requests = (state.chatgpt_requests || []).filter((r) => r.status === "open");
          for (const req of requests) {
            const existingTask = (state.tasks || []).find((t) => t.source_request_id === req.id);
            if (existingTask) {
              results.skipped.push({ request_id: req.id, reason: "already_converted", task_id: existingTask.id });
              continue;
            }
            // Use module-level helper to check task-intake markers (escalation.category or body text)
            const { _satisfiesRequestTaskIntakeCondition } = await import("../github-sync-factory.mjs");
            if (!_satisfiesRequestTaskIntakeCondition(req)) {
              results.skipped.push({ request_id: req.id, reason: "no_task_intake_marker" });
              continue;
            }
            if (shouldApply) {
              const result = await github.convertChatGptRequestToTask(store, req.id, { dryRun: false });
              if (result.converted) results.request.push({ request_id: req.id, task_id: result.task_id, title: result.title });
              else results.skipped.push({ request_id: req.id, reason: result.reason });
            } else {
              results.request.push({ request_id: req.id, title: req.title, convertible: true, dry_run: true });
            }
          }
        }
        // Scan local inbox
        if (source === "inbox" || source === "all") {
          const inboxResult = await github.importInboxHandoffs(store, { dryRun: !shouldApply });
          for (const item of inboxResult.imported) results.inbox.push(item);
          for (const item of inboxResult.skipped) results.skipped.push({ ...item, source: "inbox" });
          for (const item of inboxResult.failed) results.skipped.push({ ...item, source: "inbox", reason: "failed: " + item.reason });
        }
        const totalCount = results.github.length + results.request.length + results.inbox.length;
        return {
          dry_run: !shouldApply,
          source,
          total_imported: shouldApply ? totalCount : 0,
          would_import_count: shouldApply ? 0 : totalCount,
          total_skipped: results.skipped.length,
          github_tasks: results.github,
          request_conversions: results.request,
          inbox_handoffs: results.inbox,
          skipped: results.skipped,
        };
      },
    ),
  };
}
