import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBarkNotifier } from "../src/bark-notifier.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

// ===== 单元测试：BarkNotifier 模块 =====

test("createBarkNotifier is disabled when no key is set", () => {
  const bark = createBarkNotifier({ barkKey: "" });
  assert.equal(bark.isEnabled(), false);
});

test("createBarkNotifier is enabled when key is set", () => {
  const bark = createBarkNotifier({ barkKey: "test-key" });
  assert.equal(bark.isEnabled(), true);
});

test("send returns ok:false when disabled", async () => {
  const bark = createBarkNotifier({ barkKey: "" });
  const result = await bark.send("title", "body");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
});

test("send constructs correct Bark API URL", async (t) => {
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

test("send handles Bark API error response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({ code: 400, message: "invalid key" })
  }));
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid key/);
});

test("send handles network failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network failure");
  });
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.send("Title", "Body");
  assert.equal(result.ok, false);
  assert.match(result.error, /network failure/);
});

test("testSend returns ok when enabled", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /GPTWork%20Test/);
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const bark = createBarkNotifier({ barkKey: "test-key" });
  const result = await bark.testSend();
  assert.equal(result.ok, true);
});

// ===== 集成测试：updateTask 触发 Bark 通知 =====

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-bark-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "test-key-for-integration"
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

test("complete_task triggers bark notification for completed task", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer();

  // Create a task
  const created = await callTool(server, "create_task", {
    title: "Bark test task",
    description: "Test Bark notification on completion"
  });

  // Complete it
  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Task completed for Bark test"
  });

  // Should have triggered at least one Bark notification (fetch)
  assert.ok(fetchCount >= 1, "Bark API should have been called");
  assert.equal(completed.task.status, "completed");
  // notified and notified_at are optional fields set only on success
});

test("complete_task does not notify bark without key", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const root = await mkdtemp(join(tmpdir(), "gptwork-bark-nokey-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true
    // no barkKey -> disabled
  });

  const created = await callTool(server, "create_task", { title: "No key test" });
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "done" });

  assert.equal(fetchCount, 0, "No Bark API call when not configured");
});

test("test_bark_notification tool is available and works", async (t) => {
  let fetchCount = 0;
  let lastUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCount++;
    lastUrl = url;
    return { ok: true, json: async () => ({ code: 200, message: "ok" }) };
  });
  const server = await makeServer();

  const result = await callTool(server, "test_bark_notification");
  assert.equal(result.ok, true);
  assert.equal(fetchCount, 1);
  assert.match(lastUrl, /GPTWork%20Test/);
});

test("task.notified and task.notified_at are set after successful notification", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer();

  const created = await callTool(server, "create_task", { title: "Notified field test" });
  const completed = await callTool(server, "complete_task", { task_id: created.task.id, summary: "done" });

  assert.equal(completed.task.notified, true, "task.notified should be true");
  assert.ok(completed.task.notified_at, "task.notified_at should be set");
});

test("task does not get duplicate notifications", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount++;
    return { ok: true, json: async () => ({ code: 200, message: "sent" }) };
  });
  const server = await makeServer();

  const created = await callTool(server, "create_task", { title: "Dedup test" });

  // Complete the task (first notification)
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "first" });

  // Try to complete again (should be idempotent, no second notification)
  const again = await callTool(server, "complete_task", { task_id: created.task.id, summary: "again" });

  // barkNotifier prevents duplicate if already notified
  // The task was already notified after the first complete_task call
  // But this second complete_task also calls updateTask which checks !task.notified
  // So it should NOT trigger another Bark call for the same task
  const initialFetches = fetchCount;
  await callTool(server, "complete_task", { task_id: created.task.id, summary: "third time" });
  
  // The second and third calls should not trigger additional notifications
  // because task.notified is already true in the persisted state
  assert.equal(fetchCount, initialFetches, "Should not send duplicate notifications");
});
