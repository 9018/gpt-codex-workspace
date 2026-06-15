import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBarkNotifier } from "../src/bark-notifier.mjs";
import { loadRuntimeEnv } from "../src/runtime-env.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

// ================================================================
// Test isolation: prevent leaked GPTWORK_BARK_* env vars from
// previous runs (e.g. GPTWORK_BARK_KEY) from affecting tests.
// Save originals and clear them. Tests that need specific env
// values set them explicitly and clean up in their own scope.
// ================================================================
const _BARK_VARS = ["GPTWORK_BARK_ENABLED","GPTWORK_BARK_URL","GPTWORK_BARK_KEY","GPTWORK_BARK_GROUP","GPTWORK_BARK_SOUND","GPTWORK_BARK_LEVEL"];
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
    assert.match(url, /GPTWork%20Test/);
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
  assert.ok(result.error);
});

test("testSend returns ok:false when disabled", async () => {
  const bark = createBarkNotifier({ barkEnabled: false, barkKey: "test-key" });
  const result = await bark.testSend();
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
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
    summary: "Task completed for Bark test"
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
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done" });

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
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done" });

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
  assert.match(lastUrl, /GPTWork%20Test/);
});

test("test_bark_notification returns error when not configured", async () => {
  const server = await makeServer({});
  const result = await callTool(server, "test_bark_notification");
  assert.equal(result.ok, false);
  assert.ok(result.error);
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
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "first" });

  const initialFetches = fetchCount;

  // Try to complete again (should be idempotent, no second notification)
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "second" });

  // The second call should not trigger additional notifications
  assert.equal(fetchCount, initialFetches, "Should not send duplicate notifications for same status");
});

test("notification failure does not change task result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network failure");
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Notification failure test" });
  const completed = await callTool(server, "complete_task", { task_id: created.task.id, summary: "Task done despite notification failure" });

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
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done well" });

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

test("notification body includes task title, id, status, and summary", async (t) => {
  let lastUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    lastUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer({ barkKey: "integration-key" });

  const created = await callTool(server, "create_task", { title: "Summary In Body" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "First line of results" });

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
    barkKey: "env-loader-test-key"
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.group, testGroup);
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
    barkKey: "fill-test-abc"
  });

  const status = await callTool(server, "notification_status");
  assert.equal(status.sound_set, true);
  assert.equal(status.level_set, true);
});
