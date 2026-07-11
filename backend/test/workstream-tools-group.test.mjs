import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { createWorkstreamToolsGroup } from "../src/tool-groups/workstream-tools-group.mjs";

function fakeTool(descriptor) {
  return {
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    handler: descriptor.handler,
    metadata: {
      audience: descriptor.audience,
      modes: descriptor.modes,
      tags: descriptor.tags,
    },
  };
}

function fakeSchema(properties = {}, required = []) {
  return { type: "object", properties, required };
}

async function makeServer(t) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-workstream-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full",
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args },
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

test("workstream tool group exposes the seven planned tools and schemas", () => {
  const tools = createWorkstreamToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
  });

  assert.deepEqual(Object.keys(tools), [
    "create_workstream",
    "get_workstream",
    "list_workstreams",
    "update_workstream",
    "link_workstream_context",
    "list_workstream_links",
    "resolve_workstream_by_context",
  ]);
  assert.deepEqual(tools.create_workstream.inputSchema.required, ["title"]);
  assert.deepEqual(tools.get_workstream.inputSchema.required, ["workstream_id"]);
  assert.deepEqual(tools.update_workstream.inputSchema.required, ["workstream_id", "patch"]);
  assert.deepEqual(tools.link_workstream_context.inputSchema.required, ["workstream_id", "kind", "external_id"]);
  assert.deepEqual(tools.resolve_workstream_by_context.inputSchema.required, ["kind", "external_id"]);
  assert.deepEqual(tools.create_workstream.metadata.modes, ["standard", "codex", "full"]);
  assert.deepEqual(tools.create_workstream.metadata.tags, ["workstream"]);
});

test("public workstream tools create, update, link, list, and resolve contexts", async (t) => {
  const server = await makeServer(t);
  const created = await callTool(server, "create_workstream", {
    title: "G1 Workstream",
    project_id: "default",
    workspace_id: "hosted-default",
    root_goal_id: "goal_root",
    workflow_id: "wf_root",
  });

  assert.match(created.workstream.id, /^ws_/);
  assert.equal(created.workstream.title, "G1 Workstream");

  const fetched = await callTool(server, "get_workstream", { workstream_id: created.workstream.id });
  assert.equal(fetched.workstream.id, created.workstream.id);

  const updated = await callTool(server, "update_workstream", {
    workstream_id: created.workstream.id,
    patch: { status: "active", summary: "Running" },
  });
  assert.equal(updated.workstream.status, "active");

  const listed = await callTool(server, "list_workstreams", { status: "active" });
  assert.deepEqual(listed.workstreams.map((item) => item.id), [created.workstream.id]);

  await callTool(server, "link_workstream_context", {
    workstream_id: created.workstream.id,
    kind: "chatgpt_conversation",
    external_id: "chat_1",
    relation: "originates",
  });
  await callTool(server, "link_workstream_context", {
    workstream_id: created.workstream.id,
    kind: "chatgpt_conversation",
    external_id: "chat_2",
    relation: "continues",
  });
  await callTool(server, "link_workstream_context", {
    workstream_id: created.workstream.id,
    kind: "codex_thread",
    external_id: "thread_1",
  });

  const links = await callTool(server, "list_workstream_links", { workstream_id: created.workstream.id });
  assert.equal(links.links.length, 3);

  const resolved = await callTool(server, "resolve_workstream_by_context", {
    kind: "chatgpt_conversation",
    external_id: "chat_2",
  });
  assert.deepEqual(resolved.workstreams.map((item) => item.id), [created.workstream.id]);
  assert.equal(resolved.links[0].external_id, "chat_2");
});
