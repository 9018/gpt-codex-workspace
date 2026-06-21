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
  assert.ok(names.length < 70, `standard mode should be bounded, got ${names.length} tools`);
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
