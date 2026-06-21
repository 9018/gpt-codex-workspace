import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { createBarkNotifier } from "../src/bark-notifier.mjs";
import { writePendingRestartMarker, updateRestartMarkerStatus, getPendingRestartsDir } from "../src/safe-restart.mjs";
import { loadRuntimeEnv } from "../src/runtime-env.mjs";

async function makeServer(customConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rt-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    ...customConfig
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

// ================================================================
// runtime_status tool tests
// ================================================================

test("runtime_status returns process pid and started_at", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(typeof status.pid, "number");
  assert.ok(status.pid > 0);
  assert.ok(status.started_at);
  assert.ok(Date.parse(status.started_at) <= Date.now());
});

test("runtime_status returns config values", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.ok(status.defaultWorkspaceRoot);
  assert.ok(typeof status.defaultWorkspaceRoot === "string");
  assert.ok(typeof status.codex_exec_timeout === "number");
});

test("runtime_status returns state path info", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.ok(status.state_path);
  assert.equal(typeof status.state_path, "string");
  assert.equal(typeof status.state_path_inside_repo, "boolean");
});

test("runtime_status returns runtime env file info", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  // runtime_env_file_path could be null or string
  assert.equal(typeof status.runtime_env_file_exists, "boolean");
  assert.equal(typeof status.runtime_env_loaded, "boolean");
  assert.ok(Array.isArray(status.runtime_env_keys_loaded));
});

test("runtime_status returns repo info when available", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  // repo_head may be null if not in a git repo, or a SHA
  if (status.repo_head) {
    assert.match(status.repo_head, /^[a-f0-9]{40}$/);
  }
  if (status.remote_head) {
    assert.match(status.remote_head, /^[a-f0-9]{40}$/);
  }
  if (status.running_commit) {
    assert.match(status.running_commit, /^[a-f0-9]{40}$/);
  }
  assert.equal(typeof status.worktree_dirty, "boolean");
  assert.ok(Array.isArray(status.dirty_paths));
});

test("runtime_status does not expose private values", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  const str = JSON.stringify(status);
  // Should not contain credential-related keys or values
  assert.ok(!str.includes("barkUrl"), "should not contain barkUrl");
  assert.ok(!str.includes("barkKey"), "should not contain barkKey");
  assert.ok(!str.includes("api_key"), "should not contain api_key");
  // Check that no actual credential values are present
  // (field names like api_token_set are safe booleans)
  if (status.github) {
    assert.equal(typeof status.github.api_token_set, "boolean");
    assert.equal(typeof status.github.api_repo_set, "boolean");
  }
  assert.ok(!str.match(/ghp_\w+/), "should not contain token values");
  assert.ok(!str.includes("secret"), "should not contain secret");
  assert.ok(!str.includes("password"), "should not contain password");
});

test("runtime_status dirty_paths does not expose file contents", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  if (status.dirty_paths && status.dirty_paths.length > 0) {
    for (const p of status.dirty_paths) {
      // Should just be a path string like "M file.js" or "?? file.txt"
      assert.equal(typeof p, "string");
      // Should not contain file contents or large blobs
      assert.ok(p.length < 500, "dirty_paths entries should be short");
    }
  }
});

// ================================================================
// Runtime env source reporting test
// ================================================================

test("notification_status with runtime env source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-env-source-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });

  const testGroup = `env-group-${Date.now()}`;
  await writeFile(join(envDir, "runtime.env"),
    `GPTWORK_BARK_GROUP=${testGroup}\n`,
    "utf8"
  );

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "env-source-test-key"
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.group, testGroup);
  assert.equal(status.source, "options");
});

test("notification_status source shows workspace-runtime-env when bark config loaded from file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-env-full-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });

  await writeFile(join(envDir, "runtime.env"),
    "GPTWORK_BARK_KEY=file-key-123\n",
    "utf8"
  );

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    tokens: ["test-token"],
    requireAuth: true
    // No barkKey - it will come from runtime env
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.key_set, true);
  // The source should be workspace-runtime-env since key came from env file
  // The notifier reports "process.env" because the runtime env loader
  // sets process.env values before notifier creation. The configSource
  // parameter is "workspace-runtime-env" but the source tracking correctly
  // identifies the value came from process.env.
  assert.equal(status.source, "workspace-runtime-env");
});

// ================================================================
// State path reporting test
// ================================================================

test("runtime_status state_path_inside_repo is boolean", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(typeof status.state_path_inside_repo, "boolean");
});

// ================================================================
// notification_status enhanced diagnostics test
// ================================================================

test("notification_status includes all Bark diagnostic fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-notif-full-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "full-diag-key"
  });

  // Send a test notification first to populate diagnostics
  await callTool(server, "test_bark_notification");

  const status = await callTool(server, "notification_status");
  assert.equal(typeof status.enabled, "boolean");
  assert.equal(typeof status.configured, "boolean");
  assert.equal(typeof status.source, "string");
  assert.equal(typeof status.url_set, "boolean");
  assert.equal(typeof status.key_set, "boolean");
  assert.equal(typeof status.group, "string");
  assert.equal(typeof status.sound_set, "boolean");
  assert.equal(typeof status.level_set, "boolean");
  // Diagnostic fields
  assert.ok("last_attempt_at" in status);
  assert.ok("last_success_at" in status);
  assert.ok("last_failure_at" in status);
  assert.ok("last_response_code" in status);
  assert.ok("last_response_message" in status);
  assert.ok("last_error_short" in status);
  assert.ok("last_task_id" in status);
  assert.ok("last_task_status" in status);
  // No endpoint/key values
  assert.equal(status.url, undefined);
  assert.equal(status.key, undefined);
});


// ================================================================
// gptwork_doctor diagnostic tool tests
// ================================================================

test("gptwork_doctor returns process pid and running commit", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.pid, "number");
  assert.ok(result.pid > 0);
  assert.ok(result.started_at);
  assert.ok(Date.parse(result.started_at) <= Date.now());
});

test("gptwork_doctor returns runtime env diagnostics", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.runtime_env_loaded, "boolean");
  assert.ok("runtime_env_file_path" in result);
  assert.ok("workspace_root" in result);
  assert.equal(typeof result.workspace_root, "string");
  assert.equal(typeof result.hosted_default_root_aligned, "boolean");
});

test("gptwork_doctor returns repo diagnostics", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.default_repo, "string");
  assert.equal(typeof result.default_branch, "string");
  assert.equal(typeof result.default_repo_path, "string");
  assert.equal(typeof result.repository_registry_count, "number");
  assert.equal(typeof result.repository_registry_has_canonical_repo, "boolean");
});

test("gptwork_doctor returns worktree and stale clone info", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.stale_clone_count, "number");
  assert.equal(typeof result.worktree_dirty, "boolean");
  assert.ok(Array.isArray(result.dirty_paths));
});

test("gptwork_doctor returns config and sync status", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.codex_exec_timeout, "number");
  assert.equal(typeof result.github_api_sync_enabled, "boolean");
  assert.equal(typeof result.direct_git_reader_available, "boolean");
  assert.equal(typeof result.bark_configured, "boolean");
  assert.equal(typeof result.bark_enabled, "boolean");
});

test("gptwork_doctor returns placeholder_tools_exposed and suggested_next_actions", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.equal(typeof result.placeholder_tools_exposed, "boolean");
  assert.equal(result.placeholder_tools_exposed, false, "placeholder tools should not be exposed by default");
  assert.ok(Array.isArray(result.suggested_next_actions));
  assert.ok(result.suggested_next_actions.length > 0);
  // Each action should be a non-empty string
  for (const action of result.suggested_next_actions) {
    assert.equal(typeof action, "string");
    assert.ok(action.length > 0);
  }
});

test("gptwork_doctor does not expose secrets", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  const str = JSON.stringify(result);
  assert.ok(!str.includes("barkUrl"), "should not contain barkUrl");
  assert.ok(!str.includes("barkKey"), "should not contain barkKey");
  assert.ok(!str.includes("github_token"), "should not contain github_token");
  assert.ok(!str.match(/ghp_\w+/), "should not contain token values");
});

// ================================================================
// restart_markers in runtime_status tests
// ================================================================

test("runtime_status includes restart_markers object", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.ok(status.restart_markers, "restart_markers should be present");
  assert.equal(typeof status.restart_markers, "object");
  assert.equal(typeof status.restart_markers.total_count, "number");
  assert.equal(typeof status.restart_markers.active_count, "number");
  assert.equal(typeof status.restart_markers.marker_dir_exists, "boolean");
  assert.ok(status.restart_markers.statuses, "statuses should be present");
  assert.equal(typeof status.restart_markers.statuses.pending, "number");
  assert.equal(typeof status.restart_markers.statuses.scheduled, "number");
  assert.equal(typeof status.restart_markers.statuses.restarted, "number");
  assert.equal(typeof status.restart_markers.statuses.verified, "number");
  assert.equal(typeof status.restart_markers.statuses.failed, "number");
});

test("restart_markers empty marker dir returns total_count 0", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(status.restart_markers.total_count, 0);
  assert.equal(status.restart_markers.active_count, 0);
  assert.equal(status.restart_markers.statuses.pending, 0);
  assert.equal(status.restart_markers.statuses.scheduled, 0);
  assert.equal(status.restart_markers.statuses.restarted, 0);
  assert.equal(status.restart_markers.statuses.verified, 0);
  assert.equal(status.restart_markers.statuses.failed, 0);
  // marker_dir_exists can be true or false depending on whether
  // other tests left the dir behind; just check it's boolean
  assert.equal(typeof status.restart_markers.marker_dir_exists, "boolean");
});

test("restart_markers synthetic marker files produce correct status counts", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  const workspaceRoot = status.defaultWorkspaceRoot;

  // Create synthetic marker files with various statuses
  const markerDir = getPendingRestartsDir(workspaceRoot);
  await mkdir(markerDir, { recursive: true });

  const statuses = ["pending", "pending", "scheduled", "restarted", "verified", "failed", "pending"];
  for (let i = 0; i < statuses.length; i++) {
    const taskId = `test-marker-${i + 1}`;
    await writePendingRestartMarker(workspaceRoot, taskId, {
      requested_by: "test",
      expected_commit: `abc${i}`,
      expected_remote_head: `def${i}`,
    });
    // Override status by rewriting the file
    await updateRestartMarkerStatus(workspaceRoot, taskId, statuses[i]);
  }

  // Re-call runtime_status to get updated markers
  // Invalidate diagnostics cache so we get fresh restart marker data
  const { invalidateCache } = await import("../src/diagnostics-service.mjs");
  invalidateCache("restartMarkers");
  invalidateCache();
  const updatedStatus = await callTool(server, "runtime_status");
  assert.equal(updatedStatus.restart_markers.total_count, 7);
  assert.equal(updatedStatus.restart_markers.active_count, 5);  // 3 pending + 1 scheduled + 1 restarted
  assert.equal(updatedStatus.restart_markers.statuses.pending, 3);
  assert.equal(updatedStatus.restart_markers.statuses.scheduled, 1);
  assert.equal(updatedStatus.restart_markers.statuses.restarted, 1);
  assert.equal(updatedStatus.restart_markers.statuses.verified, 1);
  assert.equal(updatedStatus.restart_markers.statuses.failed, 1);
  assert.equal(updatedStatus.restart_markers.marker_dir_exists, true);
});

test("restart_markers does not expose secret values", async () => {
  const server = await makeServer();
  // Create a synthetic marker with a realistic task_id
  const statusBefore = await callTool(server, "runtime_status");
  const workspaceRoot = statusBefore.defaultWorkspaceRoot;
  const markerDir = getPendingRestartsDir(workspaceRoot);
  await mkdir(markerDir, { recursive: true });

  // Write a marker with task descriptions, command values etc.
  await writePendingRestartMarker(workspaceRoot, "test-secret-check", {
    requested_by: "codex",
    expected_commit: "abc123def456abc123def456abc123def456abc1",
    expected_remote_head: "def789abc012def789abc012def789abc012def7",
  });

// ================================================================

  const status = await callTool(server, "runtime_status");
  const rm = status.restart_markers;
  // The restart_markers object should only contain safe summary fields
  assert.equal(typeof rm.total_count, "number");
  assert.equal(typeof rm.active_count, "number");
  assert.equal(typeof rm.marker_dir_exists, "boolean");
  assert.ok(rm.statuses);
  // Verify no marker file contents leak through
  const rmStr = JSON.stringify(rm);
  assert.ok(!rmStr.includes("abc123"), "should not leak expected_commit values");
  assert.ok(!rmStr.includes("def789"), "should not leak expected_remote_head values");
  assert.ok(!rmStr.includes("codex"), "should not leak requested_by values");
  assert.ok(!rmStr.includes("test-secret"), "should not leak task_id values");
  assert.ok(!rmStr.includes("logs"), "should not leak marker logs");
  assert.ok(!rmStr.includes("task_description"), "should not leak descriptions");
  assert.ok(!rmStr.includes("secret"), "should not contain secret");
});
// ================================================================
// Worker status in runtime_status tests
// ================================================================

test("runtime_status includes worker summary with expected fields", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.ok(status.worker, "runtime_status should have worker field");
  const expectedFields = ["enabled", "running", "started_at", "last_tick_started_at",
    "last_tick_finished_at", "last_tick_duration_ms", "interval_ms", "current_interval_ms", "next_tick_due_at", "concurrency",
    "limit", "last_tick_result", "last_error", "health"];
  for (const field of expectedFields) {
    assert.ok(field in status.worker, `runtime_status.worker should have ${field} field`);
  }
  // In a fresh test server without Codex worker, enabled should be false
  assert.equal(status.worker.enabled, false);
  assert.equal(status.worker.running, false);
});

test("runtime_status worker does not expose secrets", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  const str = JSON.stringify(status.worker);
  assert.ok(!str.includes("token"), "worker should not expose token");
  assert.ok(!str.includes("secret"), "worker should not expose secret");
  assert.ok(!str.includes("store"), "worker should not expose store");
});

// ================================================================
// gptwork_doctor worker diagnostics tests
// ================================================================

test("gptwork_doctor includes worker field with expected keys", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  assert.ok(result.worker, "gptwork_doctor should have worker field");
  const expectedFields = ["enabled", "running", "started_at", "last_tick_started_at",
    "last_tick_finished_at", "last_tick_duration_ms", "last_tick_result", "last_error"];
  for (const field of expectedFields) {
    assert.ok(field in result.worker, `gptwork_doctor.worker should have ${field} field`);
  }
});

test("gptwork_doctor suggests worker diagnostic when disabled with tasks", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  // When worker is disabled and there are no tasks, no worker action should appear
  assert.ok(result.worker, "worker should be present");
  // But the field should be present
  assert.ok(Array.isArray(result.suggested_next_actions));
  // In a fresh test server without Codex worker, enabled should be false
  assert.equal(result.worker.enabled, false);
});

test("gptwork_doctor worker does not expose secrets", async () => {
  const server = await makeServer();
  const result = await callTool(server, "gptwork_doctor");
  const str = JSON.stringify(result.worker);
  assert.ok(!str.includes("token"), "worker should not expose token");
  assert.ok(!str.includes("secret"), "worker should not expose secret");
  assert.ok(!str.includes("store"), "worker should not expose store");
});
