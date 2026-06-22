import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  process.env.GPTWORK_TOOL_MODE = "full";
  const root = await mkdtemp(join(tmpdir(), "gptwork-ws-"));
  const statePath = join(root, "state.json");
  return createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true
  });
}

/**
 * Snapshot of public MCP tool names exposed by tools/list.
 *
 * This list MUST be updated whenever a public tool is added, removed, or renamed.
 * It guards against accidental API surface changes.
 *
 * Placeholder/beta tools (browser_screenshot, browser_set_input_files,
 * browser_click_and_download, browser_evaluate) are excluded by default.
 * They become available only when GPTWORK_EXPOSE_PLACEHOLDER_TOOLS=true or
 * GPTWORK_EXPERIMENTAL_BROWSER_TOOLS=true is set.
 */
const EXPECTED_PUBLIC_TOOL_NAMES = [
  "answer_chatgpt_request",
  "append_agent_event",
  "append_goal_message",
  "append_task_log",
  "assign_task_to_codex",
  "attach_task_artifact",
  "browser_click",
  "browser_close_session",
  "browser_current_state",
  "browser_extract_links",
  "browser_fill",
  "browser_get_html",
  "browser_get_text",
  "browser_goto",
  "browser_list_sessions",
  "browser_new_session",
  "browser_press",
  "browser_scroll",
  "browser_wait_for_selector",
 "cancel_agent_run",
  "cancel_goal_queue_item",
 "complete_agent_run",
  "complete_task",
  "context_prepare",
  "context_status",
  "copy_path",
  "create_agent_run",
  "create_chatgpt_request",
  "create_codex_session_inventory_task",
  "create_encoded_goal",
  "create_goal",
  "create_task",
  "create_workspace",
  "create_zip_archive",
  "delete_path",
  "delete_workspace",
  "detect_stale_clones",
  "download_bundle_base64",
 "download_file_base64",
  "enqueue_goal",
 "extract_zip_archive",
  "get_agent_run",
  "get_chatgpt_request",
  "get_current_user",
 "get_goal_context",
  "get_goal_queue",
 "get_project",
  "get_repository_status",
  "get_task",
  "get_workspace_info",
  "git_remote_changed_files",
  "git_remote_compare_local",
  "git_remote_diff",
  "git_remote_fetch",
  "git_remote_list_files",
  "git_remote_read_file",
  "git_remote_resolve_repo",
  "git_remote_show_commit",
  "git_remote_status",
  "github_status",
  "gptwork_doctor",
  "gptwork_self_test",
  "handoff_to_agent",
  "health_check",
  "list_agent_runs",
  "list_chatgpt_requests",
  "list_codex_sessions_metadata",
 "list_dir",
 "list_goal_queue",
 "list_goals",
 "list_pending_restarts",
  "list_projects",
  "list_recent_activity",
  "list_repo_locks",
  "list_repositories",
  "list_tasks",
  "list_workspaces",
  "mkdir",
  "move_path",
  "notification_status",
  "open_project_context",
  "preview_codex_context",
  "project_context_status",
  "read_events",
  "read_handoff",
  "read_text_file",
  "register_repository",
  "repo_lock_status",
  "request_human_review",
  "resolve_canonical_repository",
  "run_agent_pipeline",
  "run_assigned_codex_tasks",
  "runtime_status",
  "schedule_service_restart",
 "search_files",
 "set_active_workspace",
 "sha256_file",
 "shell_exec",
 "show_changes",
  "start_next_queued_goal",
 "stat_path",
  "sync_from_github",
  "sync_github_comments",
  "sync_to_github",
  "test_bark_notification",
 "test_workspace_connection",
 "update_goal_queue_item",
 "update_task_status",
 "update_workspace",
  "upload_base64_file",
  "upload_bundle_base64",
  "upload_from_url",
  "worker_status",
  "write_text_file",
];

test("tools/list returns expected public tool names (no placeholder tools)", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((t) => t.name).sort();
  assert.equal(names.length, EXPECTED_PUBLIC_TOOL_NAMES.length,
    `Expected ${EXPECTED_PUBLIC_TOOL_NAMES.length} public tools but got ${names.length}`);
  assert.deepEqual(names, EXPECTED_PUBLIC_TOOL_NAMES,
    "Public tool name snapshot mismatch. If you intentionally added/removed/renamed a tool, " +
    "update EXPECTED_PUBLIC_TOOL_NAMES in this file.");
});

test("tools/list excludes placeholder tools by default", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((t) => t.name);
  for (const placeholder of ["browser_screenshot", "browser_set_input_files", "browser_click_and_download", "browser_evaluate"]) {
    assert.equal(names.includes(placeholder), false,
      `Placeholder tool "${placeholder}" should NOT be in default tools/list`);
  }
});

test("tools/list includes placeholder tools when GPTWORK_EXPOSE_PLACEHOLDER_TOOLS is set", async () => {
  const oldVal = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
  process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = "true";
  try {
    const server = await makeServer();
    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    }, { authorization: "Bearer test-token" });

    const names = response.result.tools.map((t) => t.name);
    for (const placeholder of ["browser_screenshot", "browser_set_input_files", "browser_click_and_download", "browser_evaluate"]) {
      assert.equal(names.includes(placeholder), true,
        `Placeholder tool "${placeholder}" SHOULD be in tools/list when env flag is set`);
    }
    // Also verify total count is 118 (114 public + 4 placeholder)
    assert.equal(names.length, 118,
      `Expected 118 tools with placeholder flag set, got ${names.length}`);
  } finally {
    delete process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
    if (oldVal !== undefined) process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = oldVal;
  }
});
