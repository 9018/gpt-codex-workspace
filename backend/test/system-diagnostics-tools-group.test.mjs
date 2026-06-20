import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSystemDiagnosticsToolsGroup } from "../src/tool-groups/system-diagnostics-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const expectedToolNames = [
  "get_current_user",
  "health_check",
  "list_recent_activity",
  "test_bark_notification",
  "worker_status",
];

test("system diagnostics tool group exposes all five tool names", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("system diagnostics tool group health_check has no required schema params", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  assert.deepEqual(tools.health_check.inputSchema.required, []);
  assert.deepEqual(tools.health_check.inputSchema.properties, {});
});

test("system diagnostics tool group get_current_user has no required schema params", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  assert.deepEqual(tools.get_current_user.inputSchema.required, []);
  assert.deepEqual(tools.get_current_user.inputSchema.properties, {});
});

test("system diagnostics tool group list_recent_activity has optional limit param", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  assert.deepEqual(tools.list_recent_activity.inputSchema.required, []);
  assert.equal(tools.list_recent_activity.inputSchema.properties.limit, "integer");
});

test("system diagnostics tool group test_bark_notification has no required schema params", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  assert.deepEqual(tools.test_bark_notification.inputSchema.required, []);
  assert.deepEqual(tools.test_bark_notification.inputSchema.properties, {});
});

test("system diagnostics tool group worker_status has no required schema params", () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  assert.deepEqual(tools.worker_status.inputSchema.required, []);
  assert.deepEqual(tools.worker_status.inputSchema.properties, {});
});

test("health_check returns ok, service, and ISO time", async () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  const result = await tools.health_check.handler({});
  assert.equal(result.ok, true);
  assert.equal(result.service, "gptwork-mcp");
  assert.equal(typeof result.time, "string");
  // Should be ISO format with a T
  assert.ok(result.time.includes("T"), "time should be ISO format");
});

test("get_current_user returns user context from context param", async () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  const context = {
    user_id: "u1",
    user_name: "test-user",
    team_id: "team-a",
    project_ids: ["p1", "p2"],
    workspace_ids: ["w1"],
    scopes: ["read", "write"],
  };

  const result = await tools.get_current_user.handler({}, context);
  assert.deepEqual(result.user, { id: "u1", name: "test-user" });
  assert.equal(result.team_id, "team-a");
  assert.deepEqual(result.project_ids, ["p1", "p2"]);
  assert.deepEqual(result.workspace_ids, ["w1"]);
  assert.deepEqual(result.scopes, ["read", "write"]);
});

test("list_recent_activity returns activities from store", async () => {
  const mockActivities = [
    { type: "task_created", task_id: "t1" },
    { type: "task_completed", task_id: "t2" },
    { type: "goal_updated", goal_id: "g1" },
  ];

  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {
      load: async () => ({ activities: mockActivities }),
    },
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  // With no limit arg, defaults to 50
  const result = await tools.list_recent_activity.handler({});
  assert.ok(Array.isArray(result.activities));
  // Should be reversed: most recent first
  assert.equal(result.activities.length, 3);
  assert.equal(result.activities[0].type, "goal_updated");

  // With explicit limit
  const limited = await tools.list_recent_activity.handler({ limit: 2 });
  assert.equal(limited.activities.length, 2);
  assert.equal(limited.activities[0].type, "goal_updated");
  assert.equal(limited.activities[1].type, "task_completed");
});

test("test_bark_notification returns safe diagnostics when bark is null", async () => {
  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: null,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  const result = await tools.test_bark_notification.handler({});
  assert.equal(result.ok, false);
  assert.equal(result.source, "unknown");
  assert.equal(result.group, "gptwork");
  assert.equal(result.endpoint_kind, "none");
  assert.equal(result.error_short, "bark not initialized");
});

test("test_bark_notification delegates to bark.testSend when bark is present", async () => {
  let testSendCalled = false;
  const mockBark = {
    testSend: async () => {
      testSendCalled = true;
      return { ok: true, attempted_at: new Date().toISOString(), response_code: 200, response_message: "success", source: "options", group: "gptwork", endpoint_kind: "key" };
    },
  };

  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    bark: mockBark,
    workerState: {},
    collectWorkerQueueCounts: async () => ({}),
  });

  const result = await tools.test_bark_notification.handler({});
  assert.equal(testSendCalled, true);
  assert.equal(result.ok, true);
  assert.equal(result.response_code, 200);
  assert.equal(result.endpoint_kind, "key");
});

test("worker_status returns worker state and queue counts", async () => {
  const mockWorkerState = {
    enabled: true,
    running: false,
    started_at: "2026-01-01T00:00:00.000Z",
    last_tick_started_at: null,
    last_tick_finished_at: null,
    last_error: null,
    interval_ms: 5000,
  };

  const mockQueueCounts = {
    assigned: 2,
    queued: 1,
    running: 0,
    waiting_for_lock: 0,
    waiting_for_review: 0,
    completed: 10,
    failed: 0,
  };

  const tools = createSystemDiagnosticsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { load: async () => ({ tasks: [] }) },
    bark: null,
    workerState: mockWorkerState,
    collectWorkerQueueCounts: async (store) => {
      await store.load();
      return mockQueueCounts;
    },
  });

  const result = await tools.worker_status.handler({});
  assert.equal(result.enabled, true);
  assert.equal(result.interval_ms, 5000);
  assert.deepEqual(result.queue, mockQueueCounts);
  assert.deepEqual(result.queues, mockQueueCounts);
});
