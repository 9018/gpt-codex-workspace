import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceOperationsToolsGroup } from "../src/tool-groups/workspace-operations-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const fakeStore = { load: async () => ({ workspaces: [] }) };
const fakeConfig = { defaultWorkspaceRoot: "/tmp/test-workspace" };

const expectedToolNames = [
  "extract_zip_archive",
  "shell_exec",
  "upload_from_url",
];

test("workspace operations tool group exposes all three tool names", () => {
  const tools = createWorkspaceOperationsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("workspace operations tool group has correct input schemas", () => {
  const tools = createWorkspaceOperationsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  // upload_from_url: url (required), path (required), overwrite (optional), workspace_id (optional)
  assert.deepEqual(tools.upload_from_url.inputSchema.required, ["url", "path"]);
  assert.equal(tools.upload_from_url.inputSchema.properties.url, "string");
  assert.equal(tools.upload_from_url.inputSchema.properties.path, "string");
  assert.equal(tools.upload_from_url.inputSchema.properties.overwrite, "boolean");
  assert.equal(tools.upload_from_url.inputSchema.properties.workspace_id, "string");

  // extract_zip_archive: zip_path (required), target_dir (optional), workspace_id (optional)
  assert.deepEqual(tools.extract_zip_archive.inputSchema.required, ["zip_path"]);
  assert.equal(tools.extract_zip_archive.inputSchema.properties.zip_path, "string");
  assert.equal(tools.extract_zip_archive.inputSchema.properties.target_dir, "string");
  assert.equal(tools.extract_zip_archive.inputSchema.properties.workspace_id, "string");

  // shell_exec: command (required), cwd (optional), timeout (integer), max_output_bytes (integer), workspace_id (optional)
  assert.deepEqual(tools.shell_exec.inputSchema.required, ["command"]);
  assert.equal(tools.shell_exec.inputSchema.properties.command, "string");
  assert.equal(tools.shell_exec.inputSchema.properties.cwd, "string");
  assert.equal(tools.shell_exec.inputSchema.properties.timeout, "integer");
  assert.equal(tools.shell_exec.inputSchema.properties.max_output_bytes, "integer");
  assert.equal(tools.shell_exec.inputSchema.properties.workspace_id, "string");
});

test("workspace operations tool group has descriptions for all tools", () => {
  const tools = createWorkspaceOperationsToolsGroup({
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

test("workspace operations tool group handlers are callable functions", () => {
  const tools = createWorkspaceOperationsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].handler, "function", `${name}.handler should be a function`);
  }
});

test("workspace operations tool descriptions match original inline values", () => {
  const tools = createWorkspaceOperationsToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  assert.equal(tools.upload_from_url.description, "Download a URL and save it to the workspace.");
  assert.equal(tools.extract_zip_archive.description, "Extract a ZIP archive into a workspace directory.");
  assert.equal(tools.shell_exec.description, "在工作区执行终端命令，用于检查服务状态和运行配置脚本。");
});
