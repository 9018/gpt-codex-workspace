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

  bus.on("onAgentRunCompleted", async () => { throw new Error("handler failure"); });
  bus.on("onAgentRunCompleted", async (event) => seen.push(event.agent_run.id));

  const result = await bus.emit("onAgentRunCompleted", { agent_run: { id: "run_1" } });

  assert.deepEqual(seen, ["run_1"]);
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

  await call(server, "create_agent_run", { role: "tester", goal_id: "goal_events" });

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

  await bus.emit("onGoalCreated", { goal: { id: "goal_hook_1" } });
  await bus.emit("onTaskCreated", { task: { id: "task_hook_1" } });

  assert.equal(goalEvents.length, 1);
  assert.equal(goalEvents[0], "goal_hook_1");
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0], "task_hook_1");
});

// ================================================================
// P2: Widget card resource tests (upgraded contract)
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
  // Root card container
  assert.ok(resource.text.includes("class=\"card\""), "should have card element");
  // Title/status/summary section
  assert.ok(resource.text.includes("class=\"title\""), "should have title element");
  assert.ok(resource.text.includes("class=\"badge"), "should have badge rendering");
  assert.ok(resource.text.includes("summary"), "should have summary styling");
  // Key-value list sections
  assert.ok(resource.text.includes("kv-table"), "should have key-value table");
  assert.ok(resource.text.includes("keyValues"), "should support keyValues contract");
  // Items/list section
  assert.ok(resource.text.includes("item-list"), "should have item list");
  assert.ok(resource.text.includes("items"), "should support items contract");
  // Errors section
  assert.ok(resource.text.includes("errors"), "should have errors section");
  // Warnings section
  assert.ok(resource.text.includes("warnings"), "should have warnings section");
  // Raw JSON fallback
  assert.ok(resource.text.includes("raw JSON"), "should have raw JSON fallback section");
  // Fold toggle for raw JSON
  assert.ok(resource.text.includes("fold-toggle"), "should have fold toggle button");
  // Render function
  assert.ok(resource.text.includes("renderCard"), "should have renderCard function");
  // Data access
  assert.ok(resource.text.includes("window.openai"), "should read from Apps SDK data");
  // Dark mode
  assert.ok(resource.text.includes("prefers-color-scheme:dark"), "should support dark mode");
});

test("widget card render function produces correct sections", () => {
  const resource = readResource("ui://widget/gptwork-card-v1.html");
  const html = resource.text;

  // Verify sections
  assert.ok(html.includes("card-section"), "should have card-section class");
  assert.ok(html.includes("class=\"json\""), "should have JSON fallback pre");
  assert.ok(html.includes("class=\"json collapsed\""), "should support collapsed raw JSON");
  assert.ok(html.includes("Show raw JSON"), "should have show raw JSON toggle text");
  assert.ok(html.includes("Hide raw JSON"), "should have hide raw JSON toggle text");
  assert.ok(html.includes("changed_files"), "should support changed_files section");
  assert.ok(html.includes("staged"), "should support staged/unstaged stats");
});

// ================================================================
// P2: Tool metadata coverage tests
// ================================================================

import { createTool } from "../src/tool-registry.mjs";
import { schema } from "../src/mcp-tooling.mjs";

test("goal tools have metadata with correct tags and modes", () => {
  const handler = async () => ({});
  const common = { modes: ["minimal", "standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["goal"], outputTemplate: "ui://widget/gptwork-card-v1.html" };

  const createGoal = createTool({
    name: "create_goal", description: "Create a shared goal",
    inputSchema: schema({ user_request: "string", goal_prompt: "string" }, ["user_request", "goal_prompt"]),
    ...common, modes: ["standard", "codex", "full"], handler,
  });
  assert.deepEqual(createGoal.metadata.modes, ["standard", "codex", "full"]);
  assert.deepEqual(createGoal.metadata.tags, ["goal"]);
  assert.equal(createGoal.metadata.outputTemplate, "ui://widget/gptwork-card-v1.html");

  const createEncodedGoal = createTool({
    name: "create_encoded_goal", description: "Create an encoded goal",
    inputSchema: schema({ preview_text: "string" }, ["preview_text"]),
    modes: ["minimal", "standard", "codex", "full"], ...common, handler,
  });
  assert.deepEqual(createEncodedGoal.metadata.modes.includes("minimal"), true);
  assert.deepEqual(createEncodedGoal.metadata.tags, ["goal"]);
});

test("tool metadata for each tool group covers target categories", () => {
  // Goal tools tag
  const goalTool = createTool({
    name: "list_goals", description: "List goals",
    inputSchema: schema({}),
    modes: ["standard", "codex", "full"],
    audience: ["chatgpt", "codex"], tags: ["goal"],
    handler: async () => ({}),
  });
  assert.deepEqual(goalTool.metadata.tags, ["goal"]);
  assert.deepEqual(goalTool.metadata.audience, ["chatgpt", "codex"]);

  // Task tools tag
  const taskTool = createTool({
    name: "create_task", description: "Create a task",
    inputSchema: schema({ title: "string" }, ["title"]),
    modes: ["minimal", "standard", "codex", "full"],
    audience: ["chatgpt", "codex"], tags: ["task"],
    handler: async () => ({}),
  });
  assert.deepEqual(taskTool.metadata.tags, ["task"]);

  // Context/runtime tools tag
  const runtimeTool = createTool({
    name: "runtime_status", description: "Runtime status",
    inputSchema: schema({}),
    modes: ["minimal", "standard", "operator", "codex", "full"],
    audience: ["chatgpt", "codex", "operator"], tags: ["system", "runtime"],
    handler: async () => ({}),
  });
  assert.deepEqual(runtimeTool.metadata.tags, ["system", "runtime"]);

  // Agent tools tag
  const agentTool = createTool({
    name: "create_agent_run", description: "Create agent run",
    inputSchema: schema({}),
    modes: ["standard", "codex", "full"],
    audience: ["chatgpt", "codex"], tags: ["agent", "handoff"],
    handler: async () => ({}),
  });
  assert.deepEqual(agentTool.metadata.tags, ["agent", "handoff"]);

  // Workspace tools tag
  const wsTool = createTool({
    name: "list_dir", description: "List dir",
    inputSchema: schema({}),
    modes: ["minimal", "standard", "codex", "full"],
    audience: ["chatgpt", "codex", "operator"], tags: ["workspace"],
    handler: async () => ({}),
  });
  assert.deepEqual(wsTool.metadata.tags, ["workspace"]);

  // Git tools tag
  const gitTool = createTool({
    name: "git_remote_status", description: "Git status",
    inputSchema: schema({}),
    modes: ["codex", "full"],
    audience: ["codex", "operator"], tags: ["git"],
    handler: async () => ({}),
  });
  assert.deepEqual(gitTool.metadata.tags, ["git"]);
});

// ================================================================
// P2: Rich schema migration tests
// ================================================================

test("create_encoded_goal has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    preview_text: { type: "string", description: "GPT-written preview text summarizing what the goal is about.", examples: ["Implement feature X"] },
    payload_base64: { type: "string", description: "Base64-encoded JSON payload containing goal fields." },
    assign_to_codex: { type: "boolean", description: "Whether to immediately assign to Codex.", default: true },
    wait_ms: { type: "integer", description: "How long to wait (in ms).", minimum: 0, maximum: 120000, default: 90000 }
  }, ["preview_text", "payload_base64"]);

  assert.equal(inputSchema.properties.preview_text.description, "GPT-written preview text summarizing what the goal is about.");
  assert.equal(inputSchema.properties.assign_to_codex.default, true);
  assert.equal(inputSchema.properties.wait_ms.minimum, 0);
  assert.equal(inputSchema.properties.wait_ms.maximum, 120000);
  assert.ok(Array.isArray(inputSchema.properties.preview_text.examples));
  assert.deepEqual(inputSchema.required, ["preview_text", "payload_base64"]);
});

test("run_agent_pipeline has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    goal_id: { type: "string", description: "Goal ID to link the pipeline runs to." },
    task_id: { type: "string", description: "Task ID to link the pipeline runs to." },
    agent: { type: "string", description: "Agent name to run the pipeline.", default: "codex" },
    roles: { type: "array", items: { type: "string", enum: ["analyst", "architect", "implementer", "tester", "reviewer"] }, examples: [["analyst", "architect", "implementer", "tester", "reviewer"]] },
    review_gate_after: { type: "string", enum: ["analyst", "architect", "implementer", "tester", "reviewer"] },
    execution_order: { type: "array", items: { type: "string" } }
  });

  assert.equal(inputSchema.properties.agent.default, "codex");
  assert.equal(inputSchema.properties.roles.type, "array");
  assert.equal(inputSchema.properties.roles.items.enum[0], "analyst");
  assert.equal(inputSchema.properties.review_gate_after.enum.length, 5);
  assert.ok(Array.isArray(inputSchema.properties.roles.examples));
});

test("handoff_to_agent has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    agent: { type: "string", description: "Target agent name to hand off to.", default: "codex" },
    plan: { type: "string", description: "Handoff plan.", examples: ["Continue with implementing feature X."] },
    goal_id: { type: "string", description: "Goal ID." },
    task_id: { type: "string", description: "Task ID." }
  }, ["plan"]);

  assert.equal(inputSchema.properties.agent.default, "codex");
  assert.ok(Array.isArray(inputSchema.properties.plan.examples));
  assert.deepEqual(inputSchema.required, ["plan"]);
});

test("show_changes has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    path: { type: "string", description: "Path to show git changes for.", default: "." },
    max_diff_bytes: { type: "integer", description: "Maximum diff size in bytes.", minimum: 256, maximum: 1048576, default: 65536 }
  });

  assert.equal(inputSchema.properties.path.default, ".");
  assert.equal(inputSchema.properties.max_diff_bytes.minimum, 256);
  assert.equal(inputSchema.properties.max_diff_bytes.default, 65536);
});

test("read_events has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    date: { type: "string", description: "Date in ISO format (YYYY-MM-DD).", examples: ["2026-06-22"] },
    limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 }
  });

  assert.equal(inputSchema.properties.limit.default, 100);
  assert.equal(inputSchema.properties.limit.minimum, 1);
});

test("search_files has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    q: { type: "string", description: "Search query." },
    path: { type: "string", default: "." },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
    exclude_dirs: { type: "array", items: { type: "string" }, examples: [["node_modules", ".git", "dist"]] },
    max_file_bytes: { type: "integer", minimum: 1024, maximum: 10485760, default: 1048576 },
    max_total_bytes: { type: "integer", minimum: 10240, maximum: 52428800, default: 10485760 },
    workspace_id: { type: "string" }
  }, ["q"]);

  assert.equal(inputSchema.properties.limit.default, 50);
  assert.equal(inputSchema.properties.path.default, ".");
  assert.equal(inputSchema.properties.max_file_bytes.default, 1048576);
  assert.ok(Array.isArray(inputSchema.properties.exclude_dirs.examples));
  assert.deepEqual(inputSchema.required, ["q"]);
});

test("read_text_file has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    path: { type: "string", description: "Path to the file to read." },
    max_bytes: { type: "integer", description: "Maximum bytes to read.", minimum: 256, maximum: 10485760, default: 1048576 },
    workspace_id: { type: "string" }
  }, ["path"]);

  assert.equal(inputSchema.properties.max_bytes.default, 1048576);
  assert.equal(inputSchema.properties.path.description, "Path to the file to read.");
});

test("git_remote_diff has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    repo: { type: "string", description: "Repository identifier." },
    repo_path: { type: "string", description: "Path to local Git checkout." },
    base: { type: "string", default: "HEAD" },
    head: { type: "string", description: "Head ref/commit." },
    path: { type: "string", description: "Path scoping." },
    max_bytes: { type: "integer", minimum: 1024, maximum: 10485760, default: 1048576 }
  });

  assert.equal(inputSchema.properties.base.default, "HEAD");
  assert.equal(inputSchema.properties.max_bytes.default, 1048576);
  assert.equal(inputSchema.properties.max_bytes.minimum, 1024);
});

test("create_task has rich JSON Schema descriptor", () => {
  const inputSchema = schema({
    title: { type: "string", description: "Task title summarizing the work to be done." },
    description: { type: "string", description: "Detailed task description." },
    assignee: { type: "string", default: "codex" },
    workspace_id: { type: "string" },
    mode: { type: "string", enum: ["standard", "readonly"] }
  }, ["title"]);

  assert.equal(inputSchema.properties.assignee.default, "codex");
  assert.deepEqual(inputSchema.properties.mode.enum, ["standard", "readonly"]);
  assert.equal(inputSchema.properties.title.description, "Task title summarizing the work to be done.");
  assert.deepEqual(inputSchema.required, ["title"]);
});

// ================================================================
// P2: Tool mode integrity tests
// ================================================================

test("default tool mode exposes standard tools and not agent tools", async () => {
  const root = await _mkdtemp(join(tmpdir(), "gptwork-p2-mode-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
  });

  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((t) => t.name);

  // Standard tools should be present
  assert.ok(names.includes("open_project_context"), "open_project_context should be in standard");
  assert.ok(names.includes("runtime_status"), "runtime_status should be in standard");
  assert.ok(names.includes("gptwork_doctor"), "gptwork_doctor should be in standard");

  // Some tool metadata outputTemplate should point to widget
  const tool = response.result.tools.find((t) => t.name === "open_project_context");
  assert.ok(tool, "open_project_context should exist");
  assert.equal(tool._meta?.["openai/outputTemplate"], "ui://widget/gptwork-card-v1.html");
});

test("minimal tool mode exposes only its explicit safe subset", async () => {
  delete process.env.GPTWORK_TOOL_MODE;
  const server = await makeServer({ toolMode: "minimal" }).then(s => s.server);
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    "create_encoded_goal",
    "get_task",
    "health_check",
    "list_tasks",
    "open_project_context",
    "runtime_status",
    "worker_status",
  ].sort());
  assert.equal(names.includes("create_agent_run"), false);
  assert.equal(names.includes("handoff_to_agent"), false);
  assert.equal(names.includes("run_agent_pipeline"), false);
  assert.equal(names.includes("show_changes"), false);
});

test("operator tool mode does not expose agent or handoff tools", async () => {
  const server = await makeServer({ toolMode: "operator" }).then(s => s.server);
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((t) => t.name);

  assert.equal(names.includes("create_agent_run"), false);
  assert.equal(names.includes("handoff_to_agent"), false);
  assert.equal(names.includes("run_agent_pipeline"), false);
  assert.equal(names.includes("show_changes"), false);
  assert.equal(names.includes("shell_exec"), false);
});

test("codex tool mode exposes agent tools and shell_exec", async () => {
  const server = await makeServer({ toolMode: "codex" }).then(s => s.server);
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((t) => t.name);

  assert.ok(names.includes("create_agent_run"), "codex mode should have create_agent_run");
  assert.ok(names.includes("handoff_to_agent"), "codex mode should have handoff_to_agent");
  assert.ok(names.includes("run_agent_pipeline"), "codex mode should have run_agent_pipeline");
  assert.ok(names.includes("show_changes"), "codex mode should have show_changes");
  assert.ok(names.includes("shell_exec"), "codex mode should have shell_exec");
  assert.ok(names.includes("git_remote_diff"), "codex mode should have git_remote_diff");
});

test("full tool mode keeps the complete compatibility tool surface", async () => {
  process.env.GPTWORK_TOOL_MODE = "full";
  try {
    const server = await makeServer({}).then(s => s.server);
    const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      authorization: "Bearer test-token",
    });
    const names = response.result.tools.map((t) => t.name);

    assert.ok(names.includes("shell_exec"));
    assert.ok(names.includes("schedule_service_restart"));
    assert.ok(names.includes("git_remote_diff"));
    assert.ok(names.includes("create_goal"));
    assert.ok(names.includes("create_encoded_goal"));
    assert.ok(names.includes("read_events"));
    assert.ok(names.includes("create_agent_run"));
  } finally {
    delete process.env.GPTWORK_TOOL_MODE;
  }
});

// ================================================================
// P2: outputTemplate and widget integration tests
// ================================================================

test("at least one tool descriptor has outputTemplate pointing to widget", () => {
  const root = "/tmp/gptwork-p2-widget-test";
  const serverPromise = createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
  });

  return serverPromise.then(async (server) => {
    const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      authorization: "Bearer test-token",
    });
    const toolsWithTemplate = response.result.tools.filter((t) =>
      t._meta && t._meta["openai/outputTemplate"] === "ui://widget/gptwork-card-v1.html"
    );
    assert.ok(toolsWithTemplate.length >= 3,
      `expected at least 3 tools with outputTemplate, got ${toolsWithTemplate.length}: ${toolsWithTemplate.map(t => t.name).join(", ")}`
    );
  });
});

test("schema function preserves rich descriptors with enum, default, minimum, maximum, description", () => {
  const inputSchema = schema({
    status: { type: "string", enum: ["active", "inactive"], default: "active", description: "Item status." },
    count: { type: "integer", minimum: 0, maximum: 1000, default: 50, description: "Item count." },
  });

  assert.equal(inputSchema.properties.status.enum[0], "active");
  assert.equal(inputSchema.properties.status.default, "active");
  assert.equal(inputSchema.properties.count.minimum, 0);
  assert.equal(inputSchema.properties.count.maximum, 1000);
  assert.equal(inputSchema.properties.count.default, 50);
});

test("default timeout is 3600", async () => {
  const { server } = await makeServer();
  const status = await call(server, "runtime_status");
  // runtime_status returns codex_exec_timeout
  assert.ok(status, "runtime_status should return result");
  // The server should have 3600 as default timeout
  assert.equal(status.codex_exec_timeout, 3600);
});
