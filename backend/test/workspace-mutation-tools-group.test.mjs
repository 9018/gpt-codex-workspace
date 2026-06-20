import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceMutationToolsGroup } from "../src/tool-groups/workspace-mutation-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const fakeStore = {
  load: async () => ({}),
};

const fakeConfig = {
  defaultWorkspaceRoot: "/tmp/test-workspace",
};

const expectedToolNames = [
  "copy_path",
  "create_zip_archive",
  "delete_path",
  "mkdir",
  "move_path",
  "upload_base64_file",
  "upload_bundle_base64",
  "write_text_file",
];

test("workspace mutation tool group exposes all eight tool names", () => {
  const tools = createWorkspaceMutationToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("workspace mutation tool group has correct input schemas", () => {
  const tools = createWorkspaceMutationToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  // write_text_file: path (required), content (required), overwrite (optional), workspace_id (optional)
  assert.deepEqual(tools.write_text_file.inputSchema.required, ["path", "content"]);
  assert.equal(tools.write_text_file.inputSchema.properties.path, "string");
  assert.equal(tools.write_text_file.inputSchema.properties.content, "string");
  assert.equal(tools.write_text_file.inputSchema.properties.overwrite, "boolean");
  assert.equal(tools.write_text_file.inputSchema.properties.workspace_id, "string");

  // upload_base64_file: path (required), content_base64 (required), overwrite (optional), workspace_id (optional)
  assert.deepEqual(tools.upload_base64_file.inputSchema.required, ["path", "content_base64"]);
  assert.equal(tools.upload_base64_file.inputSchema.properties.content_base64, "string");

  // upload_bundle_base64: path (required), zip_base64 (required), overwrite, extract, target_dir, sha256_expected, workspace_id (optional)
  assert.deepEqual(tools.upload_bundle_base64.inputSchema.required, ["path", "zip_base64"]);
  assert.equal(tools.upload_bundle_base64.inputSchema.properties.extract, "boolean");
  assert.equal(tools.upload_bundle_base64.inputSchema.properties.target_dir, "string");
  assert.equal(tools.upload_bundle_base64.inputSchema.properties.sha256_expected, "string");

  // mkdir: path (required), workspace_id (optional)
  assert.deepEqual(tools.mkdir.inputSchema.required, ["path"]);
  assert.equal(tools.mkdir.inputSchema.properties.path, "string");

  // delete_path: path (required), recursive (optional), workspace_id (optional)
  assert.deepEqual(tools.delete_path.inputSchema.required, ["path"]);
  assert.equal(tools.delete_path.inputSchema.properties.recursive, "boolean");

  // move_path: src (required), dst (required), overwrite (optional), workspace_id (optional)
  assert.deepEqual(tools.move_path.inputSchema.required, ["src", "dst"]);
  assert.equal(tools.move_path.inputSchema.properties.src, "string");
  assert.equal(tools.move_path.inputSchema.properties.dst, "string");

  // copy_path: src (required), dst (required), overwrite (optional), workspace_id (optional)
  assert.deepEqual(tools.copy_path.inputSchema.required, ["src", "dst"]);

  // create_zip_archive: source_dir (required), zip_path (required), workspace_id (optional)
  assert.deepEqual(tools.create_zip_archive.inputSchema.required, ["source_dir", "zip_path"]);
  assert.equal(tools.create_zip_archive.inputSchema.properties.source_dir, "string");
  assert.equal(tools.create_zip_archive.inputSchema.properties.zip_path, "string");
});

test("workspace mutation tool group has descriptions for all tools", () => {
  const tools = createWorkspaceMutationToolsGroup({
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

test("workspace mutation tool group handlers are callable functions", () => {
  const tools = createWorkspaceMutationToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].handler, "function", `${name}.handler should be a function`);
  }
});

test("mkdir tool description matches the original", () => {
  const tools = createWorkspaceMutationToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: fakeStore,
    config: fakeConfig,
  });

  assert.equal(tools.mkdir.description, "Create a directory.");
  assert.equal(tools.delete_path.description, "Permanently delete a file or directory. Files are deleted immediately, without recycle/trash. Use with caution.");
  assert.equal(tools.write_text_file.description, "Write a UTF-8 text file.");
  assert.equal(tools.create_zip_archive.description, "Create a ZIP archive from a directory.");
});
