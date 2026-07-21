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
  "apply_plan_ir",
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
  "cleanup_goals",
  "cleanup_tmp",
  "clear_repo_lock",
  "classify_execution_intent",
  "codex_tui_collect",
  "codex_tui_preview_task_delta",
  "codex_tui_progress",
  "codex_tui_read",
  "codex_tui_send",
  "codex_tui_send_task_delta",
  "codex_tui_start_goal",
  "codex_tui_status",
  "codex_tui_stop",
  "codex_tui_subagents",
 "complete_agent_run",
  "compile_plan_ir",
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
  "create_workstream",
  "create_workstream_fanout",
  "create_workstream_join",
  "create_zip_archive",
  "delete_path",
  "delete_workspace",
  "detect_stale_clones",
  "download_bundle_base64",
 "download_file_base64",
  "enqueue_goal",
  "evaluate_workstream_join",
 "extract_zip_archive",
  "get_agent_run",
  "get_chatgpt_request",
  "get_current_user",
 "get_goal_context",
  "get_goal_execution_context",
  "get_goal_queue",
  "get_project",
  "get_repository_status",
  "get_task",
  "get_task_acceptance_bundle",
  "get_task_review_packet",
  "get_workspace_info",
  "get_workstream",
  "get_workstream_capacity",
  "get_workstream_execution_graph",
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
  "goal_merge_apply",
  "goal_merge_preview",
  "goal_storage_status",
  "gptwork_doctor",
  "gptwork_self_test",
  "handoff_to_agent",
  "health_check",
  "import_task_handoffs",
  "link_workstream_context",
  "list_actionable_reviews",
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
  "list_workstream_links",
  "list_workstreams",
  "manual_release_workstream_join",
  "mkdir",
  "move_path",
  "notification_status",
  "open_project_context",
  "prepare_agent_handoff",
  "preview_codex_context",
  "project_context_status",
  "read_events",
  "read_handoff",
  "read_text_file",
  "register_agent_artifact",
  "register_repository",
  "repo_lock_status",
  "request_human_review",
  "resolve_canonical_repository",
  "resolve_workstream_by_context",
  "retention_cleanup",
  "retention_status",
  "run_agent_pipeline",
  "run_ephemeral_tool_batch",
  "run_assigned_codex_tasks",
  "run_command",
  "runtime_status",
  "schedule_service_restart",
 "search_files",
 "set_active_workspace",
 "sha256_file",
 "shell_exec",
 "show_changes",
  "start_next_queued_goal",
  "start_workstream_ready_tasks",
 "stat_path",
  "sync_from_github",
  "sync_github_comments",
  "sync_to_github",
  "test_bark_notification",
 "test_workspace_connection",
  "tool_search",
  "tool_describe",
  "tmp_status",
  "update_goal_queue_item",
 "update_task_status",
 "update_workspace",
  "update_workstream",
  "validate_plan_ir",
  "upload_base64_file",
  "upload_bundle_base64",
  "upload_from_url",
  "worker_status",
  "workflow_advance",
  "workflow_apply_proposal",
  "workflow_record_result",
  "workflow_status",
  "write_text_file",
].sort();

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


test("tools/list includes recovery tools when GPTWORK_RECOVERY_PLANE_ENABLED is set", async () => {
  const oldVal = process.env.GPTWORK_RECOVERY_PLANE_ENABLED;
  process.env.GPTWORK_RECOVERY_PLANE_ENABLED = "true";
  try {
    const server = await makeServer();
    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    }, { authorization: "Bearer test-token" });

    const names = response.result.tools.map((t) => t.name);
    const recoveryTools = [
      "recovery_plane_status",
      "recovery_diagnose",
      "recovery_queue_reconcile",
      "recovery_lock_reconcile",
      "recovery_worker_recover",
      "recovery_api_failure_control",
      "recovery_storage_maintenance",
      "recovery_runtime_env_fix_plan",
      "recovery_safe_restart",
      "recovery_state_patch",
      "recovery_file_read",
      "recovery_file_write",
      "recovery_apply_patch",
      "recovery_command_runner",
      "recovery_tool_exposure_self_test",
    ];
    for (const tool of recoveryTools) {
      assert.equal(names.includes(tool), true,
        "Recovery tool  + tool +  SHOULD be visible when GPTWORK_RECOVERY_PLANE_ENABLED=true");
    }
  } finally {
    delete process.env.GPTWORK_RECOVERY_PLANE_ENABLED;
    if (oldVal !== undefined) process.env.GPTWORK_RECOVERY_PLANE_ENABLED = oldVal;
  }
});

test("tools/list excludes recovery tools by default", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((t) => t.name);
  for (const recovery of ["recovery_plane_status", "recovery_diagnose", "recovery_queue_reconcile", "recovery_lock_reconcile", "recovery_worker_recover", "recovery_api_failure_control", "recovery_command_runner"]) {
    assert.equal(names.includes(recovery), false,
      "Recovery tool  + recovery +  should NOT be in default tools/list");
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
    assert.equal(names.length, EXPECTED_PUBLIC_TOOL_NAMES.length + 4,
      `Expected ${EXPECTED_PUBLIC_TOOL_NAMES.length + 4} tools with placeholder flag set, got ${names.length}`);
  } finally {
    delete process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
    if (oldVal !== undefined) process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = oldVal;
  }
});
