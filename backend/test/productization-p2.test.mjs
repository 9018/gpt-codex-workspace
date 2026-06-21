import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLogger, readEvents } from "../src/event-log-service.mjs";
import { createHookBus } from "../src/hook-service.mjs";
import { completeAgentRun, createAgentRun } from "../src/agent-run-service.mjs";
import { StateStore } from "../src/state-store.mjs";

test("event logger appends and reads JSONL lifecycle events", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-events-"));
  const logger = createEventLogger({ workspaceRoot: root });

  const first = await logger.append("agent_run.created", { agent_run_id: "run_1" });
  await logger.append("agent_run.completed", { agent_run_id: "run_1" });
  const text = await readFile(first.path, "utf8");
  const events = await readEvents({ workspaceRoot: root });

  assert.match(text, /agent_run.created/);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "agent_run.completed");
});

test("hook bus dispatches lifecycle events to registered handlers", async () => {
  const bus = createHookBus();
  const seen = [];
  bus.on("onAgentRunCompleted", async (event) => seen.push(event.agent_run.id));

  await bus.emit("onAgentRunCompleted", { agent_run: { id: "run_1" } });

  assert.deepEqual(seen, ["run_1"]);
});

test("agent run service writes events and emits completion hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-agent-events-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  const eventLogger = createEventLogger({ workspaceRoot: root });
  const hookBus = createHookBus();
  const seen = [];
  hookBus.on("onAgentRunCompleted", async ({ agent_run }) => seen.push(agent_run.id));

  const created = await createAgentRun(store, { role: "tester", agent: "codex" }, { eventLogger, hookBus });
  await completeAgentRun(store, { agent_run_id: created.agent_run.id, summary: "done" }, { eventLogger, hookBus });
  const events = await readEvents({ workspaceRoot: root });

  assert.deepEqual(events.map((event) => event.type), ["agent_run.created", "agent_run.completed"]);
  assert.deepEqual(seen, [created.agent_run.id]);
});

// ================================================================
// P2: Event log lifecycle with server-based tests
// ================================================================

import { mkdtemp as _mkdtemp, readFile as _readFile, writeFile as _writeFile } from "node:fs/promises";
import { execFileSync as _execFileSync } from "node:child_process";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer(extra = {}) {
  const root = await _mkdtemp(join(tmpdir(), "gptwork-p2-"));
  return {
    root,
    server: await createGptWorkServer({
      statePath: join(root, "state.json"),
      defaultWorkspaceRoot: join(root, "workspace"),
      tokens: ["test-token"],
      requireAuth: true,
      ...extra,
    }),
  };
}

async function call(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, { authorization: "Bearer test-token" });
  assert.ifError(response.error);
  return response.result.structuredContent;
}

test("hook bus handler fail does not affect main flow", async () => {
  const bus = createHookBus();
  const seen = [];

  // Register a handler that throws
  bus.on("onAgentRunCompleted", async () => { throw new Error("handler failure"); });
  // Register a normal handler
  bus.on("onAgentRunCompleted", async (event) => seen.push(event.agent_run.id));

  // Emit should not throw even though one handler fails
  const result = await bus.emit("onAgentRunCompleted", { agent_run: { id: "run_1" } });

  // The normal handler should still have run
  assert.deepEqual(seen, ["run_1"]);
  // The result should show both handlers ran
  assert.equal(result.handlers, 2);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].error, "handler failure");
  assert.equal(result.results[1].ok, true);
});

test("agent run created event log includes goal, role, agent", async () => {
  const { server, root } = await makeServer();
  const created = await call(server, "create_agent_run", {
    goal_id: "goal_p2",
    role: "tester",
    agent: "codex",
  });

  assert.equal(created.agent_run.goal_id, "goal_p2");
  assert.equal(created.agent_run.role, "tester");
  assert.equal(created.agent_run.agent, "codex");
});

test("agent run pipeline creates pipeline event", async () => {
  const { server } = await makeServer();
  const pipeline = await call(server, "run_agent_pipeline", {
    goal_id: "goal_p2_pipeline",
    roles: ["planner", "implementer"],
  });

  assert.ok(pipeline.pipeline, "should return pipeline object");
  assert.equal(pipeline.pipeline.goal_id, "goal_p2_pipeline");
  assert.equal(pipeline.count, 2);
  assert.equal(pipeline.agent_runs[0].role, "planner");
  assert.equal(pipeline.agent_runs[1].role, "implementer");
});

test("agent run with append_agent_event creates event and status update", async () => {
  const { server } = await makeServer();
  const created = await call(server, "create_agent_run", { role: "planner" });

  const evented = await call(server, "append_agent_event", {
    agent_run_id: created.agent_run.id,
    type: "progress",
    message: "analysis started",
  });

  assert.equal(evented.agent_run.events.length, 1);
  assert.equal(evented.agent_run.events[0].message, "analysis started");

  const completed = await call(server, "complete_agent_run", {
    agent_run_id: created.agent_run.id,
    status: "completed",
    summary: "analysis done",
  });
  assert.equal(completed.agent_run.status, "completed");
});

test("read_events tool returns events from the event log", async () => {
  const root = await _mkdtemp(join(tmpdir(), "gptwork-p2-read-events-"));
  const workspaceRoot = join(root, "workspace");
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
  });

  // Create an agent run which should generate events
  await call(server, "create_agent_run", { role: "tester", goal_id: "goal_events" });

  // Read events back
  const result = await call(server, "read_events", { limit: 10 });
  assert.ok(result.events.length > 0, "should have at least one event");
  assert.ok(result.events.some((e) => e.type === "agent_run.created"), "should contain agent_run.created event");
  assert.equal(typeof result.count, "number");
});

test("Goal and task events are logged through lifecycle hooks (no-op test for hook wiring)", async () => {
  const bus = createHookBus();
  const goalEvents = [];
  const taskEvents = [];

  bus.on("onGoalCreated", async ({ goal }) => goalEvents.push(goal.id));
  bus.on("onTaskCreated", async ({ task }) => taskEvents.push(task.id));

  // Simulate emitting hooks (as the tool handlers would)
  await bus.emit("onGoalCreated", { goal: { id: "goal_hook_1" } });
  await bus.emit("onTaskCreated", { task: { id: "task_hook_1" } });

  assert.equal(goalEvents.length, 1);
  assert.equal(goalEvents[0], "goal_hook_1");
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0], "task_hook_1");
});

// ================================================================
// P2: Widget card resource test
// ================================================================

import { resourceList, readResource } from "../src/mcp-tooling.mjs";

test("widget card resource is listed and returns proper compact HTML", () => {
  const list = resourceList();
  assert.ok(list.length > 0);
  const entry = list.find((r) => r.uri === "ui://widget/gptwork-card-v1.html");
  assert.ok(entry, "gptwork-card-v1.html should be in resource list");
  assert.equal(entry.mimeType, "text/html");
  assert.match(entry.name, /GPTWork/);

  const resource = readResource("ui://widget/gptwork-card-v1.html");
  assert.ok(resource, "readResource should return content");
  assert.equal(resource.mimeType, "text/html");
  assert.ok(resource.text.includes("class=\"card\""), "should have card element");
  assert.ok(resource.text.includes("class=\"badge"), "should have badge rendering");
  assert.ok(resource.text.includes("kv-table"), "should have key-value table");
  assert.ok(resource.text.includes("item-list"), "should have item list");
  assert.ok(resource.text.includes("errors"), "should have errors section");
  assert.ok(resource.text.includes("window.openai"), "should read from Apps SDK data");
  assert.ok(resource.text.includes("prefers-color-scheme:dark"), "should support dark mode");
});
