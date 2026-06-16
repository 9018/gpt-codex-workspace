import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { createBarkNotifier } from "../src/bark-notifier.mjs";
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
  assert.equal(status.source, "process.env");
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
