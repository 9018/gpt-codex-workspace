import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTool } from "../src/tool-registry.mjs";
import { schema } from "../src/mcp-tooling.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-productization-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    ...extra,
  });
}

test("createTool accepts object descriptors with metadata while preserving handler", async () => {
  const handler = async () => ({ ok: true });
  const tool = createTool({
    name: "example_tool",
    description: "Example",
    inputSchema: schema({ mode: { type: "string", enum: ["compact", "full"], default: "compact" } }),
    handler,
    audience: ["chatgpt"],
    modes: ["standard", "full"],
    outputCard: "exampleCard",
    examples: [{ mode: "compact" }],
    tags: ["example"],
  });

  assert.equal(tool.description, "Example");
  assert.equal(tool.handler, handler);
  assert.deepEqual(tool.metadata.audience, ["chatgpt"]);
  assert.deepEqual(tool.metadata.modes, ["standard", "full"]);
  assert.equal(tool.metadata.outputCard, "exampleCard");
  assert.deepEqual(await tool.handler(), { ok: true });
});

test("schema supports rich property descriptors", () => {
  const inputSchema = schema({
    role: { type: "string", enum: ["planner", "tester"], description: "Agent role", default: "planner" },
    artifacts: { type: "array", items: { type: "string" }, examples: [["plan.md"]] },
    target: { oneOf: [{ type: "string" }, { type: "null" }] },
  }, ["role"]);

  assert.equal(inputSchema.properties.role.type, "string");
  assert.deepEqual(inputSchema.properties.role.enum, ["planner", "tester"]);
  assert.equal(inputSchema.properties.role.description, "Agent role");
  assert.equal(inputSchema.properties.role.default, "planner");
  assert.equal(inputSchema.properties.artifacts.items.type, "string");
  assert.equal(inputSchema.properties.target.oneOf[1].type, "null");
  assert.deepEqual(inputSchema.required, ["role"]);
});

test("default standard tool mode exposes bounded ChatGPT-first tools", async () => {
  delete process.env.GPTWORK_TOOL_MODE;
  const server = await makeServer();
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((tool) => tool.name);

  assert.ok(names.includes("open_project_context"));
  assert.ok(names.includes("create_encoded_goal"));
  assert.ok(names.includes("get_task"));
  assert.ok(names.includes("runtime_status"));
  assert.equal(names.includes("schedule_service_restart"), false);
  assert.equal(names.includes("shell_exec"), false);
  assert.ok(names.length > 60, `standard mode should include the full curated ChatGPT surface, got ${names.length} tools`);
  assert.ok(names.length < 120, `standard mode should remain bounded, got ${names.length} tools`);

  // P0 cleanup tools (cleanup-tools-group)
  assert.ok(names.includes("cleanup_goals"), "standard mode includes cleanup_goals (P0.1)");
  assert.ok(names.includes("goal_storage_status"), "standard mode includes goal_storage_status (P0.1)");
  assert.ok(names.includes("cleanup_tmp"), "standard mode includes cleanup_tmp (P0.1)");
  assert.ok(names.includes("tmp_status"), "standard mode includes tmp_status (P0.1)");
  assert.ok(names.includes("clear_repo_lock"), "standard mode includes clear_repo_lock (P0.2)");
  // list_repo_locks uses the legacy tool API so it only appears in operator/full, not standard

  // P0 workflow tools (workflow-tools-group)
  assert.ok(names.includes("workflow_status"), "standard mode includes workflow_status (P0.2)");
  assert.ok(names.includes("workflow_advance"), "standard mode includes workflow_advance (P0.2)");
  assert.ok(names.includes("workflow_record_result"), "standard mode includes workflow_record_result (P0.2)");
  assert.ok(names.includes("workflow_apply_proposal"), "standard mode includes workflow_apply_proposal (P0.2)");
});

test("minimal tool mode exposes only its explicit safe subset", async () => {
  const server = await makeServer({ toolMode: "minimal" });
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((tool) => tool.name).sort();

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
  const server = await makeServer({ toolMode: "operator" });
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    authorization: "Bearer test-token",
  });
  const names = response.result.tools.map((tool) => tool.name);

  assert.equal(names.includes("create_agent_run"), false);
  assert.equal(names.includes("handoff_to_agent"), false);
  assert.equal(names.includes("run_agent_pipeline"), false);
  assert.equal(names.includes("show_changes"), false);
});

test("tools/call rejects hidden tools in minimal and standard modes", async () => {
  for (const toolMode of ["minimal", "standard"]) {
    const server = await makeServer({ toolMode });
    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "echo hidden" } },
    }, { authorization: "Bearer test-token" });

    assert.equal(response.error?.code, -32601, `${toolMode} should reject hidden direct calls`);
    assert.match(response.error?.message || "", /Unknown tool: shell_exec/);
  }
});

test("tools/call keeps shell_exec available in codex and full modes", async () => {
  for (const toolMode of ["codex", "full"]) {
    const server = await makeServer({ toolMode });
    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "printf visible" } },
    }, { authorization: "Bearer test-token" });

    assert.ifError(response.error);
    assert.equal(response.result.structuredContent.returncode, 0);
    assert.match(response.result.structuredContent.stdout, /visible/);
  }
});

test("full tool mode keeps the complete compatibility tool surface", async () => {
  process.env.GPTWORK_TOOL_MODE = "full";
  try {
    const server = await makeServer();
    const response = await server.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      authorization: "Bearer test-token",
    });
    const names = response.result.tools.map((tool) => tool.name);

    assert.ok(names.includes("shell_exec"));
    assert.ok(names.includes("schedule_service_restart"));
    assert.ok(names.includes("git_remote_diff"));
  } finally {
    delete process.env.GPTWORK_TOOL_MODE;
  }
});

test("resources/list exposes the GPTWork Apps SDK widget resource", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({ jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }, {
    authorization: "Bearer test-token",
  });

  assert.equal(response.result.resources[0].uri, "ui://widget/gptwork-card-v1.html");
  assert.equal(response.result.resources[0].mimeType, "text/html");
});
