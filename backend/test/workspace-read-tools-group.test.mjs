import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceReadToolsGroup } from "../src/tool-groups/workspace-read-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const fakeStore = { load: async () => ({ workspaces: [] }) };
const fakeConfig = { defaultWorkspaceRoot: "/tmp/test-workspace" };

const expectedToolNames = [
  "list_dir",
  "stat_path",
  "read_text_file",
  "download_file_base64",
  "download_bundle_base64",
  "search_files",
  "sha256_file",
].sort();

test("workspace read tool group exposes all seven tool names", () => {
  const tools = createWorkspaceReadToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("workspace read tool group has correct input schemas", () => {
  const tools = createWorkspaceReadToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  // list_dir: path (string), recursive (boolean), limit (integer), workspace_id (string)
  assert.deepEqual(tools.list_dir.inputSchema.required, []);
  assert.equal(tools.list_dir.inputSchema.properties.path, "string");
  assert.equal(tools.list_dir.inputSchema.properties.recursive, "boolean");
  assert.equal(tools.list_dir.inputSchema.properties.limit, "integer");
  assert.equal(tools.list_dir.inputSchema.properties.workspace_id, "string");

  // stat_path: path (string, required), workspace_id (string)
  assert.deepEqual(tools.stat_path.inputSchema.required, ["path"]);
  assert.equal(tools.stat_path.inputSchema.properties.path, "string");
  assert.equal(tools.stat_path.inputSchema.properties.workspace_id, "string");

  // read_text_file: path (string, required), max_bytes (integer), workspace_id (string)
  assert.deepEqual(tools.read_text_file.inputSchema.required, ["path"]);
  assert.equal(tools.read_text_file.inputSchema.properties.path, "string");
  assert.equal(tools.read_text_file.inputSchema.properties.max_bytes, "integer");
  assert.equal(tools.read_text_file.inputSchema.properties.workspace_id, "string");

  // download_file_base64: path (string, required), max_bytes (integer), workspace_id (string)
  assert.deepEqual(tools.download_file_base64.inputSchema.required, ["path"]);
  assert.equal(tools.download_file_base64.inputSchema.properties.path, "string");
  assert.equal(tools.download_file_base64.inputSchema.properties.max_bytes, "integer");
  assert.equal(tools.download_file_base64.inputSchema.properties.workspace_id, "string");

  // download_bundle_base64: source_dir (string), paths (array), workspace_id (string)
  assert.deepEqual(tools.download_bundle_base64.inputSchema.required, []);
  assert.equal(tools.download_bundle_base64.inputSchema.properties.source_dir, "string");
  assert.equal(tools.download_bundle_base64.inputSchema.properties.paths, "array");
  assert.equal(tools.download_bundle_base64.inputSchema.properties.workspace_id, "string");

  // search_files: q (string, required), path (string), limit (integer), workspace_id (string)
  assert.deepEqual(tools.search_files.inputSchema.required, ["q"]);
  assert.equal(tools.search_files.inputSchema.properties.q, "string");
  assert.equal(tools.search_files.inputSchema.properties.path, "string");
  assert.equal(tools.search_files.inputSchema.properties.limit, "integer");
  assert.equal(tools.search_files.inputSchema.properties.workspace_id, "string");

  // sha256_file: path (string, required), workspace_id (string)
  assert.deepEqual(tools.sha256_file.inputSchema.required, ["path"]);
  assert.equal(tools.sha256_file.inputSchema.properties.path, "string");
  assert.equal(tools.sha256_file.inputSchema.properties.workspace_id, "string");
});

test("workspace read tool group has descriptions for all tools", () => {
  const tools = createWorkspaceReadToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].description, "string", `${name} should have a description`);
    assert.ok(tools[name].description.length > 10, `${name} description should be meaningful`);
  }
});

test("workspace read tool group handlers are callable functions", () => {
  const tools = createWorkspaceReadToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].handler, "function", `${name}.handler should be a function`);
  }
});
