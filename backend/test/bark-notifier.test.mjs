import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBarkNotifier, classifyNotification, classifyCreatedNotification, formatNotification, formatCreatedNotification, formatManualTestNotification } from "../src/bark-notifier.mjs";
import { loadRuntimeEnv } from "../src/runtime-env.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

// ================================================================
// Test isolation: prevent leaked GPTWORK_BARK_* env vars from
// previous runs (e.g. GPTWORK_BARK_KEY) from affecting tests.
// Save originals and clear them. Tests that need specific env
// values set them explicitly and clean up in their own scope.
// ================================================================
const _BARK_VARS = ["GPTWORK_BARK_ENABLED","GPTWORK_BARK_URL","GPTWORK_BARK_KEY","GPTWORK_BARK_GROUP","GPTWORK_BARK_SOUND","GPTWORK_BARK_LEVEL","GPTWORK_BARK_ICON_URL","GPTWORK_BARK_ICON","GPTWORK_BARK_CLICK_URL","GPTWORK_BARK_ACTION_URL","GPTWORK_BARK_BADGE","GPTWORK_BARK_NOTIFY_TASKS","GPTWORK_BARK_NOTIFY_READONLY","GPTWORK_BARK_NOTIFY_INTERNAL","GPTWORK_BARK_NOTIFY_TESTS","GPTWORK_BARK_NOTIFY_CANCELLED","GPTWORK_BARK_NOTIFY_WAITING_REVIEW","GPTWORK_BARK_NOTIFY_FAILURES","GPTWORK_BARK_NOTIFY_TIMEOUTS","GPTWORK_BARK_NOTIFY_COMPLETED"];
const _savedBarkEnv = {};
for (const _k of _BARK_VARS) { if (_k in process.env) { _savedBarkEnv[_k] = process.env[_k]; delete process.env[_k]; } }
process.on("exit", () => { for (const [_k, _v] of Object.entries(_savedBarkEnv)) { process.env[_k] = _v; } });


// ================================================================
// Unit tests: createBarkNotifier
// ================================================================

test("createBarkNotifier is disabled when not configured", () => {
  const bark = createBarkNotifier();
  assert.equal(bark.isEnabled(), false);
});

test("createBarkNotifier is disabled when explicitly disabled even with key", () => {
  const bark = createBarkNotifier({ barkEnabled: false, barkKey: "test-key" });
  assert.equal(bark.isEnabled(), false);
});

test("createBarkNotifier is disabled when enabled=true but no key/url", () => {
  const bark = createBarkNotifier({ barkEnabled: true });
  assert.equal(bark.isEnabled(), false);
});

test("createBarkNotifier is enabled when key is set", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  assert.equal(bark.isEnabled(), true);
});

test("createBarkNotifier is enabled when url is set", () => {
  const bark = createBarkNotifier({ barkUrl: "https://push.example.com" });
  assert.equal(bark.isEnabled(), true);
});

test("send returns ok:false when disabled (explicit)", async () => {
  const bark = createBarkNotifier({ barkEnabled: false, barkKey: "test-key" });
  const result = await bark.send("title", "body");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bark disabled");
});

test("send returns ok:false when not configured", async () => {
  const bark = createBarkNotifier({ barkEnabled: true });
  const result = await bark.send("title", "body");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bark not configured");
});

test("send returns not configured for default createBarkNotifier({})", async () => {
  const bark = createBarkNotifier({});
  const result = await bark.send("title", "body");
  assert.equal(result.ok, false);
});

test("send constructs correct Bark API URL with key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /test-key/, "URL should contain API key");
    assert.match(url, /Test%20Title/, "URL should contain encoded title");
    assert.match(url, /Test%20Body/, "URL should contain encoded body");
    assert.match(url, /group=test-group/, "URL should contain group param");
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.send("Test Title", "Test Body", "test-group");
  assert.equal(result.ok, true);
  assert.equal(result.bark_id, "ok");
});

test("send constructs correct Bark API URL with full endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /custom-bark/, "URL should contain custom endpoint");
    assert.match(url, /Hello%20World/, "URL should contain encoded title");
    assert.match(url, /group=my-group/, "URL should contain group param");
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkUrl: "https://custom-bark.example.com/push" });
  const result = await bark.send("Hello World", "details", "my-group");
  assert.equal(result.ok, true);
  assert.equal(result.bark_id, "ok");
});

test("send includes sound and level params when provided", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /sound=alarm/, "URL should contain sound param");
    assert.match(url, /level=timeSensitive/, "URL should contain level param");
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "test-key", barkSound: "alarm", barkLevel: "timeSensitive" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, true);
});

test("send handles Bark API error response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({ code: 400, message: "invalid key" })
  }));
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid key/);
});

test("send handles network failure without exposing details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ETIMEDOUT something secret");
  });
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, false);
  assert.equal(result.error, "notification failed", "Should not leak network error details");
});

test("testSend returns ok when enabled with key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /Bark%20test/);
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.testSend();
  assert.equal(result.ok, true);
});

test("testSend returns ok:false with error when not configured", async () => {
  const bark = createBarkNotifier();
  const result = await bark.testSend();
  assert.equal(result.ok, false);
  assert.ok(result.error_short);
  assert.ok(result.attempted_at);
  assert.equal(result.response_code, null);
  assert.equal(result.endpoint_kind, "none");
  assert.equal(result.source, "disabled");
});

test("testSend returns ok:false when disabled", async () => {
  const bark = createBarkNotifier({ barkEnabled: false, barkKey: "test-key" });
  const result = await bark.testSend();
  assert.equal(result.ok, false);
  assert.match(result.error_short, /disabled/);
  assert.ok(result.attempted_at);
  assert.equal(result.source, "disabled");
  assert.equal(result.endpoint_kind, "key");
  assert.equal(result.response_code, null);
});

test("getStatus returns safe fields without exposing endpoint", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key", barkSound: "alarm" });
  const status = bark.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.url_set, false);
  assert.equal(status.key_set, true);
  assert.equal(status.group, "gptwork");
  assert.equal(status.sound_set, true);
  assert.equal(status.level_set, false);
  assert.equal(status.url, undefined);
  assert.equal(status.key, undefined);
});

test("getStatus reflects url_set when using full URL", async () => {
  const bark = createBarkNotifier({ barkUrl: "https://push.example.com" });
  const status = bark.getStatus();
  assert.equal(status.url_set, true);
  assert.equal(status.key_set, false);
  assert.equal(status.configured, true);
});

test("getStatus returns defaults for empty config", async () => {
  const bark = createBarkNotifier();
  const status = bark.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.configured, false);
  assert.equal(status.url_set, false);
  assert.equal(status.key_set, false);
  assert.equal(status.group, "gptwork");
});

// ================================================================
// Unit tests: loadRuntimeEnv
// ================================================================

test("loadRuntimeEnv: loads env from file and fills missing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-runtime-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "runtime.env");
  // Ensure vars are not already set (test isolation cleared bark vars above,
  // but check for any that might have been restored)
  for (const _v of ["GPTWORK_BARK_ENABLED","GPTWORK_BARK_KEY","GPTWORK_BARK_GROUP","GPTWORK_BARK_SOUND","GPTWORK_BARK_LEVEL","GPTWORK_BARK_URL"]) {
    delete process.env[_v];
  }
  await writeFile(envFile, [
    "GPTWORK_BARK_ENABLED=false",
    "GPTWORK_BARK_KEY=env-test-key",
    "GPTWORK_BARK_GROUP=test-group",
    "",
    "# this is a comment",
    "   ",
    "GPTWORK_BARK_SOUND=alarm"
  ].join("\n"), "utf8");

  const result = loadRuntimeEnv(root);
  assert.equal(result.loadedPath, envFile);
  assert.ok(result.keys.includes("GPTWORK_BARK_ENABLED"));
  assert.ok(result.keys.includes("GPTWORK_BARK_KEY"));
  assert.ok(result.keys.includes("GPTWORK_BARK_GROUP"));
  assert.ok(result.keys.includes("GPTWORK_BARK_SOUND"));
  assert.equal(result.keys.length, 4);

  // Clean up env vars set by this test and any remaining GPTWORK_BARK_* vars
  for (const _k of Object.keys(process.env)) {
    if (_k.startsWith("GPTWORK_BARK_")) delete process.env[_k];
  }
});

test("loadRuntimeEnv: process.env keeps highest priority", async () => {
  // Save env to restore after test
  const saved = process.env.GPTWORK_BARK_GROUP;
  delete process.env.GPTWORK_BARK_GROUP;

  const root = await mkdtemp(join(tmpdir(), "gptwork-runtime-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "runtime.env");
  await writeFile(envFile, "GPTWORK_BARK_GROUP=from-file\n", "utf8");

  process.env.__GPTWORK_TEST_PRIORITY = "from-process";
  const result = loadRuntimeEnv(root, envFile);
  // Should not override existing process.env values
  assert.ok(!result.keys.includes("__GPTWORK_TEST_PRIORITY"));

  // GPTWORK_BARK_GROUP is not in system env, so it should be loaded
  assert.ok(result.keys.includes("GPTWORK_BARK_GROUP"));
  assert.equal(process.env.GPTWORK_BARK_GROUP, "from-file");

  // process.env still has priority for the test key
  assert.equal(process.env.__GPTWORK_TEST_PRIORITY, "from-process");
  delete process.env.__GPTWORK_TEST_PRIORITY;

  // Cleanup: restore saved env
  if (saved !== undefined) process.env.GPTWORK_BARK_GROUP = saved;
  else delete process.env.GPTWORK_BARK_GROUP;
});

test("loadRuntimeEnv: returns empty when no file exists", () => {
  const result = loadRuntimeEnv("/nonexistent/path");
  assert.equal(result.loadedPath, null);
  assert.deepEqual(result.keys, []);
});

test("loadRuntimeEnv: supports override path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-runtime-"));
  const customEnv = join(root, "custom.env");
  await writeFile(customEnv, "GPTWORK_BARK_LEVEL=timeSensitive\n", "utf8");

  const result = loadRuntimeEnv(root, customEnv);
  assert.ok(result.keys.includes("GPTWORK_BARK_LEVEL"));
});

// ================================================================
// Integration tests: updateTask triggers Bark notification
// ================================================================

async function makeServer(customConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-bark-"));
  // Only default barkEnabled=false when no bark-related config is provided
  const hasBarkConfig = "barkEnabled" in customConfig || "barkKey" in customConfig || "barkUrl" in customConfig;
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full",
    ...(hasBarkConfig ? {} : { barkEnabled: false }),
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

test("notification_status tool returns safe fields", async () => {
  const server = await makeServer({ barkKey: "integration-key" });
  const status = await callTool(server, "notification_status");
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.key_set, true);
  assert.equal(status.url_set, false);
  assert.equal(status.group, "gptwork");
  assert.ok("sound_set" in status);
  assert.ok("level_set" in status);
});

test("notification_status tool shows disabled when not configured", async () => {
  const server = await makeServer({});
  const status = await callTool(server, "notification_status");
  assert.equal(status.enabled, false);
  assert.equal(status.configured, false);
});

test("complete_task triggers bark notification for completed task", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", {
    title: "Bark test task",
    description: "Test Bark notification on completion"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Task completed for Bark test",
    admin_override: true
  });

  assert.ok(fetchCount >= 1, "Bark API should have been called");
  assert.equal(completed.task.status, "completed");
});

test("complete_task does not notify bark without key", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ /* no bark config - barkEnabled is false by default */ });

  const created = await callTool(server, "create_task", { title: "No key test" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done",
    admin_override: true
  });

  assert.equal(fetchCount, 0, "No Bark API call when not configured");
});

test("complete_task does not notify bark when explicitly disabled", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "key", barkEnabled: false });

  const created = await callTool(server, "create_task", { title: "Disabled test" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done",
    admin_override: true
  });

  assert.equal(fetchCount, 0, "No Bark API call when disabled");
});

test("test_bark_notification tool is available and works", async (t) => {
  let fetchCount = 0;
  let lastUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    lastUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const result = await callTool(server, "test_bark_notification");
  assert.equal(result.ok, true);
  assert.equal(fetchCount, 1);
  assert.match(lastUrl, /Bark%20test/);
});

test("test_bark_notification returns error when not configured", async () => {
  const server = await makeServer({});
  const result = await callTool(server, "test_bark_notification");
  assert.equal(result.ok, false);
  assert.ok(result.error_short);
  assert.ok(result.attempted_at);
  assert.equal(result.response_code, null);
  assert.equal(result.endpoint_kind, "none");
  assert.equal(result.source, "disabled");
});

test("task does not get duplicate notifications for same status", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Dedup test" });

  // Complete the task (first notification)
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "first",
    admin_override: true
  });

  const initialFetches = fetchCount;

  // Try to complete again (should be idempotent, no second notification)
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "second",
    admin_override: true
  });

  // The second call should not trigger additional notifications
  assert.equal(fetchCount, initialFetches, "Should not send duplicate notifications for same status");
});

test("notification failure does not change task result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network failure");
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Notification failure test" });
  const completed = await callTool(server, "complete_task", { task_id: created.task.id, summary: "Task done despite notification failure",
    admin_override: true
  });

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.summary, "Task done despite notification failure");
});

test("terminal notification for completed status", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Terminal test completed" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done well",
    admin_override: true
  });

  assert.ok(fetchCount >= 1, "Should notify on completed");
});

test("terminal notification for failed status", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Terminal test failed" });
  await callTool(server, "update_task_status", { task_id: created.task.id, status: "failed" });

  assert.ok(fetchCount >= 1, "Should notify on failed");
});

test("terminal notification for timed_out status", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Terminal test timeout" });
  await callTool(server, "update_task_status", { task_id: created.task.id, status: "timed_out" });

  assert.ok(fetchCount >= 1, "Should notify on timed_out");
});

test("terminal notification for waiting_for_review via update_task_status", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Waiting review test" });
  await callTool(server, "update_task_status", { task_id: created.task.id, status: "waiting_for_review" });

  assert.ok(fetchCount >= 1, "Should notify on waiting_for_review via update_task_status");
});

test("duplicate waiting_for_review update does not resend notification", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Dedup waiting review" });

  // First update to waiting_for_review triggers notification
  await callTool(server, "update_task_status", { task_id: created.task.id, status: "waiting_for_review" });
  const firstFetchCount = fetchCount;

  // Second update with same status should not re-notify
  await callTool(server, "update_task_status", { task_id: created.task.id, status: "waiting_for_review" });

  assert.equal(fetchCount, firstFetchCount, "Should not resend notification for same waiting_for_review status");
});

test("Phase C completed sends completed notification via update_task", async (t) => {
  // This simulates the Phase C startup verification path: calling updateTask
  // with a completed status change. Phase C calls notifyTerminalTaskIfNeeded
  // on the task object after modifying it, which is now the same path as
  // update_task_status -> updateTask --> notifyTerminalTaskIfNeeded.
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Phase C notification test" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "Phase C sim",
    admin_override: true
  });

  assert.ok(fetchCount >= 1, "Phase C equivalent path should notify on completed");
});

test("notification body includes task title, id, status, and summary", async (t) => {
  let lastUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    lastUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Summary In Body" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "First line of results",
    admin_override: true
  });

  // The URL-encoded body should contain the task title
  assert.ok(lastUrl.includes("Summary%20In%20Body"), "URL should contain task title");
});

// ================================================================
// Test: runtime env file loading from server
// ================================================================

test("server loads runtime env from workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-server-env-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  // Use a unique key not already in process.env
  const testGroup = `runtime-group-${Date.now()}`;
  await writeFile(join(envDir, "runtime.env"), `GPTWORK_BARK_GROUP=${testGroup}\n`, "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full",
    barkKey: "env-loader-test-key"
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.group, testGroup);
  // Clean up any env vars that may have been set
  for (const _k of Object.keys(process.env)) {
    if (_k.startsWith("GPTWORK_BARK_")) delete process.env[_k];
  }
});

test("runtime env fills missing bark config from file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-env-fill-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  await writeFile(join(envDir, "runtime.env"), [
    "GPTWORK_BARK_SOUND=default",
    "GPTWORK_BARK_LEVEL=timeSensitive"
  ].join("\n"), "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full",
    barkKey: "fill-test-abc"
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.sound_set, true);
  assert.equal(status.level_set, true);
  // Clean up any env vars that may have been set
  for (const _k of Object.keys(process.env)) {
    if (_k.startsWith("GPTWORK_BARK_")) delete process.env[_k];
  }
});

// ================================================================
// Enhanced status and diagnostics tests
// ================================================================

test("getStatus includes source and last-attempt diagnostics", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key", barkSound: "alarm" });
  const status = bark.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.source, "options");
  assert.equal(status.url_set, false);
  assert.equal(status.key_set, true);
  assert.equal(status.group, "gptwork");
  assert.equal(status.sound_set, true);
  assert.equal(status.level_set, false);
  assert.equal(status.last_attempt_at, null);
  assert.equal(status.last_success_at, null);
  assert.equal(status.last_failure_at, null);
  assert.equal(status.last_response_code, null);
  assert.equal(status.last_response_message, null);
  assert.equal(status.last_error_short, null);
  assert.equal(status.last_task_id, null);
  assert.equal(status.last_task_status, null);
});

test("getStatus returns source=options when opts provided", async () => {
  const bark = createBarkNotifier({ barkKey: "key-from-options" });
  assert.equal(bark.getStatus().source, "options");
});

test("getStatus returns source=process.env when using system env", async () => {
  process.env.__GPTWORK_TEST_BARK_KEY = "env-key-test";
  process.env.__GPTWORK_TEST_BARK_ENABLED = "true";
  process.env.GPTWORK_BARK_ENABLED = "true";
  process.env.GPTWORK_BARK_KEY = "system-env-key";
  const bark = createBarkNotifier();
  const status = bark.getStatus();
  assert.equal(status.source, "process.env");
  assert.equal(status.key_set, true);
  delete process.env.__GPTWORK_TEST_BARK_KEY;
  delete process.env.__GPTWORK_TEST_BARK_ENABLED;
  delete process.env.GPTWORK_BARK_ENABLED;
  delete process.env.GPTWORK_BARK_KEY;
});

test("getStatus returns source=disabled when not configured", async () => {
  const bark = createBarkNotifier();
  const status = bark.getStatus();
  assert.equal(status.source, "disabled");
});

test("getStatus returns source=mixed when opts and env both used", async () => {
  process.env.GPTWORK_BARK_ENABLED = "true";
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const status = bark.getStatus();
  assert.equal(status.source, "mixed");
  delete process.env.GPTWORK_BARK_ENABLED;
});

test("getDiag returns safe diagnostic shape", async () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const diag = bark.getDiag();
  assert.equal(diag.channel, "bark");
  assert.equal(diag.attempted_at, null);
  assert.equal(diag.ok, false);
  assert.equal(diag.response_code, null);
  assert.equal(diag.response_message, null);
  assert.equal(diag.error_short, null);
  assert.equal(diag.source, "options");
  assert.equal(diag.group, "gptwork");
  assert.equal(diag.endpoint_kind, "key");
  assert.equal(diag.url, undefined);
  assert.equal(diag.key, undefined);
});

test("send populates last-attempt diagnostics", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true, json: async () => ({ code: 200, message: "sent" })
  }));
  const bark = createBarkNotifier({ barkKey: "diag-test-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, true);

  const status = bark.getStatus();
  assert.ok(status.last_attempt_at);
  assert.ok(status.last_success_at);
  assert.equal(status.last_failure_at, null);
  assert.equal(status.last_error_short, null);
  assert.equal(status.last_response_code, 200);
  assert.equal(status.last_response_message, "sent");

  const diag = bark.getDiag();
  assert.equal(diag.channel, "bark");
  assert.ok(diag.attempted_at);
  assert.equal(diag.ok, true);
  assert.equal(diag.response_code, 200);
  assert.equal(diag.response_message, "sent");
  assert.equal(diag.error_short, null);
  assert.equal(diag.endpoint_kind, "key");
  assert.equal(diag.source, "options");
  assert.equal(diag.group, "gptwork");
});

test("send records failure diagnostics", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    throw new Error("network error");
  });
  const bark = createBarkNotifier({ barkKey: "fail-diag-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, false);

  const status = bark.getStatus();
  assert.ok(status.last_attempt_at);
  assert.ok(status.last_failure_at);
  assert.equal(status.last_success_at, null);
  assert.equal(status.last_error_short, "notification failed");
  assert.equal(status.last_response_code, null);
  assert.equal(status.last_response_message, null);
});

test("getDiag does not expose endpoint or key values", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true, json: async () => ({ code: 200, message: "ok" })
  }));
  const bark = createBarkNotifier({ barkKey: "secret-key-12345", barkUrl: "https://secret-endpoint.example.com/push" });
  await bark.send("Test", "Test");
  const diag = bark.getDiag();
  const diagStr = JSON.stringify(diag);
  assert.ok(!diagStr.includes("secret-key-12345"), "diag should not contain key value");
  assert.ok(!diagStr.includes("secret-endpoint"), "diag should not contain url value");
  assert.ok(!diagStr.includes("barkUrl"), "diag should not contain url field name");
  assert.ok(!diagStr.includes("barkKey"), "diag should not contain key field name");

  const status = bark.getStatus();
  const statusStr = JSON.stringify(status);
  assert.ok(!statusStr.includes("secret-key-12345"), "status should not contain key value");
  assert.ok(!statusStr.includes("secret-endpoint"), "status should not contain url value");
});

test("testSend returns endpoint_kind=key when using key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true, json: async () => ({ code: 200, message: "ok" })
  }));
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.testSend();
  assert.equal(result.ok, true);
  assert.equal(result.endpoint_kind, "key");
  assert.ok(result.attempted_at);
  assert.equal(result.response_code, 200);
  assert.equal(result.response_message, "ok");
  assert.equal(result.source, "options");
  assert.equal(result.group, "gptwork");
  assert.equal(result.error_short, null);
});

test("testSend returns endpoint_kind=url when using url", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true, json: async () => ({ code: 200, message: "ok" })
  }));
  const bark = createBarkNotifier({ barkUrl: "https://push.test.com" });
  const result = await bark.testSend();
  assert.equal(result.ok, true);
  assert.equal(result.endpoint_kind, "url");
});

// ================================================================
// Tests: icon URL support
// ================================================================

test("buildUrl includes icon param when configured via notifier", async (t) => {
  let capturedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({
    barkKey: "icon-test-key",
    barkIconUrl: "https://example.com/icon.png"
  });
  await bark.send("Test", "Body");
  assert.match(capturedUrl, /icon=https%3A%2F%2Fexample\.com%2Ficon\.png/,
    "URL should contain URL-encoded icon param");
});

test("buildUrl includes click URL param when configured", async (t) => {
  let capturedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({
    barkKey: "click-test-key",
    barkClickUrl: "https://example.com/action"
  });
  await bark.send("Test", "Body");
  assert.match(capturedUrl, /url=https%3A%2F%2Fexample\.com%2Faction/,
    "URL should contain URL-encoded click URL param");
});

test("buildUrl includes badge param when configured", async (t) => {
  let capturedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({
    barkKey: "badge-test-key",
    barkBadge: 5
  });
  await bark.send("Test", "Body");
  assert.match(capturedUrl, /badge=5/, "URL should contain badge param");
});

test("buildUrl omits icon/clickUrl/badge params when not configured", async (t) => {
  let capturedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "no-extra-key" });
  await bark.send("Test", "Body");
  assert.ok(!capturedUrl.includes("icon="), "URL should not contain icon param");
  assert.ok(!capturedUrl.includes("url="), "URL should not contain url param");
  assert.ok(!capturedUrl.includes("badge="), "URL should not contain badge param");
});

test("getStatus includes icon_set and url_action_set booleans", async () => {
  const bark = createBarkNotifier({
    barkKey: "status-test-key",
    barkIconUrl: "https://example.com/icon.png",
    barkClickUrl: "https://example.com/click"
  });
  const status = bark.getStatus();
  assert.equal(status.icon_set, true);
  assert.equal(status.url_action_set, true);
});

test("getStatus shows icon_set=false when no icon configured", async () => {
  const bark = createBarkNotifier({ barkKey: "no-icon-key" });
  const status = bark.getStatus();
  assert.equal(status.icon_set, false);
  assert.equal(status.url_action_set, false);
});

test("getDiag includes icon_set and url_action_set", async () => {
  const bark = createBarkNotifier({
    barkKey: "diag-icon-key",
    barkIconUrl: "https://example.com/icon.png"
  });
  const diag = bark.getDiag();
  assert.equal(diag.icon_set, true);
  assert.equal(diag.url_action_set, false);
});

// ================================================================
// Tests: classifyNotification - notification policy
// ================================================================

test("classifyNotification allows default builder completed task", () => {
  const result = classifyNotification({ mode: "builder", status: "completed" });
  assert.equal(result.should_notify, true);
});

test("classifyNotification suppresses readonly tasks by default", () => {
  const result = classifyNotification({ mode: "readonly", status: "completed" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /readonly/);
});

test("classifyNotification suppresses internal tasks by default", () => {
  const result = classifyNotification({ mode: "internal", status: "completed" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /internal/);
});

test("classifyNotification suppresses test mode tasks by default", () => {
  const result = classifyNotification({ mode: "test", status: "completed" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /test/);
});

test("classifyNotification suppresses cancelled by default", () => {
  const result = classifyNotification({ mode: "builder", status: "cancelled" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /cancelled/);
});

test("classifyNotification suppresses session inventory tasks by default", () => {
  const result = classifyNotification({ mode: "builder", status: "completed", title: "Codex session inventory test" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /session inventory/);
});

test("classifyNotification applies notifyCompleted=false policy", () => {
  const result = classifyNotification(
    { mode: "builder", status: "completed" },
    { notifyCompleted: false }
  );
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /completed/);
});

test("classifyNotification allows completed when policy override allows", () => {
  const result = classifyNotification(
    { mode: "readonly", status: "completed" },
    { notifyReadonly: true }
  );
  assert.equal(result.should_notify, true);
});

test("classifyNotification allows failed by default", () => {
  const result = classifyNotification({ mode: "builder", status: "failed" });
  assert.equal(result.should_notify, true);
});

test("classifyNotification allows timed_out by default", () => {
  const result = classifyNotification({ mode: "builder", status: "timed_out" });
  assert.equal(result.should_notify, true);
});

test("classifyNotification allows waiting_for_review by default", () => {
  const result = classifyNotification({ mode: "builder", status: "waiting_for_review" });
  assert.equal(result.should_notify, true);
});

test("classifyNotification suppresses non-terminal statuses", () => {
  const result = classifyNotification({ mode: "builder", status: "assigned" });
  assert.equal(result.should_notify, false);
});

test("classifyNotification respects global disable flag", () => {
  const result = classifyNotification(
    { mode: "builder", status: "completed" },
    { notifyTasks: false }
  );
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /globally disabled/);
});

// ================================================================
// Tests: formatNotification - rich message formatting
// ================================================================

test("formatNotification uses emoji for completed", () => {
  const { title } = formatNotification({ title: "My Task" }, "completed");
  assert.match(title, /\u2705/);
  assert.match(title, /completed/);
  assert.match(title, /My Task/);
});

test("formatNotification uses emoji for failed", () => {
  const { title } = formatNotification({ title: "Failed Task" }, "failed");
  assert.match(title, /\u274C/);
  assert.match(title, /failed/);
});

test("formatNotification uses emoji for timed_out", () => {
  const { title } = formatNotification({ title: "Timed Out" }, "timed_out");
  assert.match(title, /\u23F1/);
});

test("formatNotification uses emoji for waiting_review", () => {
  const { title } = formatNotification({ title: "Review me" }, "waiting_review");
  assert.match(title, /\uD83D\uDC40/);
});

test("formatNotification includes task status and title in body", () => {
  const { body } = formatNotification(
    { title: "Build feature X" },
    "completed"
  );
  assert.match(body, /Task: Build feature X/);
  assert.match(body, /Status: completed/);
});

test("formatNotification includes mode and workspace when present", () => {
  const { body } = formatNotification(
    { title: "Test", mode: "builder", workspace_id: "hosted-default" },
    "completed"
  );
  assert.match(body, /Mode: builder/);
  assert.match(body, /Workspace: hosted-default/);
});

test("formatNotification includes tests when present", () => {
  const { body } = formatNotification(
    { title: "Test", result: { tests: "38/38 pass" } },
    "completed"
  );
  assert.match(body, /Tests: 38\/38 pass/);
});

test("formatNotification includes commit and remote head when present", () => {
  const { body } = formatNotification(
    {
      title: "Test",
      result: { commit: "a2eeb8916b1ffe88475569029d4359e02b077ca9", remote_head: "a2eeb8916b1ffe88475569029d4359e02b077ca9" }
    },
    "completed"
  );
  assert.match(body, /Commit: a2eeb89/);
  assert.match(body, /Remote: a2eeb89/);
});

test("formatNotification includes duration when present in ms", () => {
  const { body } = formatNotification(
    { title: "Test", duration: 372000 },
    "completed"
  );
  assert.match(body, /Duration: 6m12s/);
});

test("formatNotification includes summary lines", () => {
  const { body } = formatNotification(
    { title: "Test", result: { summary: "First line\nSecond line\nThird line" } },
    "completed"
  );
  assert.match(body, /Summary: First line/);
  assert.match(body, /Second line/);
  assert.ok(!body.includes("Third line"), "Should only include first 2 lines");
});

test("formatNotification includes changed files when present", () => {
  const { body } = formatNotification(
    { title: "Test", result: { changed_files: "file1.js, file2.js" } },
    "completed"
  );
  assert.match(body, /Files: file1.js, file2.js/);
});

test("formatNotification truncates long content", () => {
  const longSummary = "A".repeat(500);
  const longFiles = "file".repeat(300);
  const { body } = formatNotification(
    {
      title: "Long test",
      duration: 99999999,
      result: {
        summary: longSummary,
        changed_files: longFiles,
        kind: "codex_executed",
        tests: "100/100 pass"
      }
    },
    "completed"
  );
  // Should not exceed 4000 chars
  assert.ok(body.length <= 4000, `Body length ${body.length} should be <= 4000`);
  // Should end with ellipsis if truncated
  if (body.length >= 3997) {
    assert.match(body, /\.\.\.$/);
  }
});

test("formatNotification includes result kind when present", () => {
  const { body } = formatNotification(
    { title: "Test", result: { kind: "codex_executed" } },
    "completed"
  );
  assert.match(body, /Kind: codex_executed/);
});

// ================================================================
// Tests: formatManualTestNotification
// ================================================================

test("formatManualTestNotification uses test tube emoji", () => {
  const { title } = formatManualTestNotification();
  assert.match(title, /\uD83E\uDDEA/);
  assert.match(title, /Bark test/);
});

test("formatManualTestNotification includes diagnostic body", () => {
  const { body } = formatManualTestNotification();
  assert.match(body, /manual Bark notification test/);
  assert.match(body, /Timestamp:/);
});

// ================================================================
// Tests: testSend uses rich format
// ================================================================

test("testSend uses rich format when key configured", async (t) => {
  let capturedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "test-rich-key" });
  await bark.testSend();
  assert.match(capturedUrl, /%F0%9F%A7%AA/);  // 🧪 emoji encoded
  assert.match(capturedUrl, /GPTWork%20Bark%20test/);
});

// ================================================================
// Tests: env var isolation for notification policy variables
// ================================================================

test("classifyNotification reads GPTWORK_BARK_NOTIFY_READONLY env var", () => {
  process.env.GPTWORK_BARK_NOTIFY_READONLY = "true";
  const result = classifyNotification({ mode: "readonly", status: "completed" });
  assert.equal(result.should_notify, true);
  delete process.env.GPTWORK_BARK_NOTIFY_READONLY;
});

test("classifyNotification reads GPTWORK_BARK_NOTIFY_CANCELLED env var", () => {
  process.env.GPTWORK_BARK_NOTIFY_CANCELLED = "true";
  const result = classifyNotification({ mode: "builder", status: "cancelled" });
  assert.equal(result.should_notify, true);
  delete process.env.GPTWORK_BARK_NOTIFY_CANCELLED;
});

// ================================================================
// Tests: classifyCreatedNotification
// ================================================================

test("classifyCreatedNotification allows Codex-assigned builder task", () => {
  const result = classifyCreatedNotification({ title: "My task", assignee: "codex", mode: "builder", status: "assigned" });
  assert.equal(result.should_notify, true);
  assert.match(result.reason, /allowed/);
});

test("classifyCreatedNotification blocks draft task", () => {
  const result = classifyCreatedNotification({ title: "Draft", assignee: "", mode: "builder", status: "draft" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /draft/);
});

test("classifyCreatedNotification blocks non-codex assignee", () => {
  const result = classifyCreatedNotification({ title: "Human task", assignee: "user", mode: "builder", status: "assigned" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /not assigned to Codex/);
});

test("classifyCreatedNotification blocks readonly task by default", () => {
  const result = classifyCreatedNotification({ title: "Inventory", assignee: "codex", mode: "readonly", status: "assigned" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /readonly/);
});

test("classifyCreatedNotification blocks internal task by default", () => {
  const result = classifyCreatedNotification({ title: "Internal", assignee: "codex", mode: "internal", status: "assigned" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /internal/);
});

test("classifyCreatedNotification blocks test mode task by default", () => {
  const result = classifyCreatedNotification({ title: "Test", assignee: "codex", mode: "test", status: "assigned" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /test/);
});

test("classifyCreatedNotification blocks session inventory by default", () => {
  const result = classifyCreatedNotification({ title: "Codex Session Inventory", assignee: "codex", mode: "readonly", status: "assigned" });
  assert.equal(result.should_notify, false);
});

test("classifyCreatedNotification respects policy override for readonly", () => {
  const result = classifyCreatedNotification({ title: "Readonly task", assignee: "codex", mode: "readonly", status: "assigned" }, { notifyReadonly: true });
  assert.equal(result.should_notify, true);
});

test("classifyCreatedNotification respects notifyCreated policy", () => {
  const result = classifyCreatedNotification({ title: "Task", assignee: "codex", mode: "builder", status: "assigned" }, { notifyCreated: false });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /created notifications disabled/);
});

test("classifyCreatedNotification respects global notifyTasks", () => {
  const result = classifyCreatedNotification({ title: "Task", assignee: "codex", mode: "builder", status: "assigned" }, { notifyTasks: false });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /globally disabled/);
});

test("classifyCreatedNotification allows session inventory with notifyInternal and notifyReadonly", () => {
  const result = classifyCreatedNotification({ title: "Codex Session Inventory", assignee: "codex", mode: "readonly", status: "assigned" }, { notifyInternal: true, notifyReadonly: true });
  assert.equal(result.should_notify, true);
});

test("classifyCreatedNotification respects GPTWORK_BARK_NOTIFY_CREATED env var", () => {
  process.env.GPTWORK_BARK_NOTIFY_CREATED = "false";
  const result = classifyCreatedNotification({ title: "Task", assignee: "codex", mode: "builder", status: "assigned" });
  assert.equal(result.should_notify, false);
  delete process.env.GPTWORK_BARK_NOTIFY_CREATED;
});

// ================================================================
// Tests: formatCreatedNotification
// ================================================================

test("formatCreatedNotification uses red square emoji", () => {
  const { title } = formatCreatedNotification({ title: "Test", assignee: "codex", status: "assigned" });
  assert.match(title, /\uD83C\uDD95/);
  assert.match(title, /GPTWork task created/);
  assert.match(title, /Test/);
});

test("formatCreatedNotification includes task id, status, mode, workspace, goal, created", () => {
  const { body } = formatCreatedNotification({
    id: "task_123",
    title: "My Task",
    status: "assigned",
    mode: "builder",
    workspace_id: "ws-1",
    goal_id: "goal_456",
    created_at: "2026-06-17T00:00:00Z",
    assignee: "codex"
  });
  assert.match(body, /task_123/);
  assert.match(body, /assigned/);
  assert.match(body, /builder/);
  assert.match(body, /ws-1/);
  assert.match(body, /goal_456/);
  assert.match(body, /2026-06-17/);
});

test("formatCreatedNotification omits goal_id when absent", () => {
  const { body } = formatCreatedNotification({
    id: "task_123",
    title: "Task",
    status: "assigned",
    created_at: "2026-06-17T00:00:00Z"
  });
  assert.ok(!body.includes("Goal:"));
});

test("formatCreatedNotification truncates long content", () => {
  const { body } = formatCreatedNotification({
    id: "task_123",
    title: "A".repeat(200),
    status: "assigned",
    mode: "builder",
    workspace_id: "ws-1",
    goal_id: "goal_456",
    created_at: "2026-06-17T00:00:00Z"
  });
  assert.ok(body.length <= 4000);
});

// ================================================================
// Tests: created notification dedup (notifyTerminalTaskIfNeeded pattern)
// ================================================================

test("classifyNotification suppresses waiting_for_lock (repo-lock block)", () => {
  const result = classifyNotification({ title: "Locked task", mode: "builder", status: "waiting_for_lock" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /not in notification targets/);
});

test("classifyNotification suppresses draft status", () => {
  const result = classifyNotification({ title: "Draft task", mode: "builder", status: "draft" });
  assert.equal(result.should_notify, false);
  assert.match(result.reason, /not in notification targets/);
});

// ================================================================
// Tests: notification_status diagnostics
// ================================================================

test("barkNotifier getStatus includes last_task_event field", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const status = bark.getStatus();
  assert.ok("last_task_event" in status);
  assert.equal(status.last_task_event, null);
});

test("barkNotifier getStatus includes last_task_id and last_task_status fields", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const status = bark.getStatus();
  assert.ok("last_task_id" in status);
  assert.ok("last_task_status" in status);
  assert.ok("last_attempt_at" in status);
  assert.ok("last_success_at" in status);
  assert.ok("last_failure_at" in status);
});

test("barkNotifier getDiag includes last_task_event field", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const diag = bark.getDiag();
  assert.ok("last_task_event" in diag);
  assert.equal(diag.last_task_event, null);
});

test("_setTaskMetadata updates diag fields", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  bark._setTaskMetadata("task_1", "assigned", "created");
  const status = bark.getStatus();
  assert.equal(status.last_task_id, "task_1");
  assert.equal(status.last_task_status, "assigned");
  assert.equal(status.last_task_event, "created");
});

test("_setTaskMetadata allows partial updates", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  bark._setTaskMetadata(undefined, "completed");
  const status = bark.getStatus();
  assert.equal(status.last_task_status, "completed");
  assert.equal(status.last_task_id, null);
});

// ================================================================
// Tests: policy switch can disable created without disabling terminal
// ================================================================

test("classifyNotification terminal events work when created is disabled", () => {
  // Simulate: created notifications disabled, but terminal notifications still work
  const createdResult = classifyCreatedNotification(
    { title: "My Task", assignee: "codex", mode: "builder", status: "assigned" },
    { notifyCreated: false }
  );
  assert.equal(createdResult.should_notify, false);
  
  const completedResult = classifyNotification(
    { title: "My Task", mode: "builder", status: "completed" }
  );
  assert.equal(completedResult.should_notify, true);
  
  const failedResult = classifyNotification(
    { title: "My Task", mode: "builder", status: "failed" }
  );
  assert.equal(failedResult.should_notify, true);
  
  const timeoutResult = classifyNotification(
    { title: "My Task", mode: "builder", status: "timed_out" }
  );
  assert.equal(timeoutResult.should_notify, true);
});
