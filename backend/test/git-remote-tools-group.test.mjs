import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGitRemoteToolsGroup } from "../src/tool-groups/git-remote-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const fakeConfig = {
  defaultWorkspaceRoot: "/tmp/test-workspace",
  defaultRepo: "owner/repo",
  defaultBranch: "main",
  defaultRepoPath: null,
  defaultRemote: "origin",
};

const fakeRegistry = {
  workspaceRoot: "/tmp/test-workspace",
  get: () => null,
  getDefaultRepo: () => null,
  findByName: () => null,
  findByPath: () => null,
  list: () => [],
  count: () => 0,
};

const expectedToolNames = [
  "git_remote_changed_files",
  "git_remote_compare_local",
  "git_remote_diff",
  "git_remote_fetch",
  "git_remote_list_files",
  "git_remote_read_file",
  "git_remote_resolve_repo",
  "git_remote_show_commit",
  "git_remote_status",
];

test("git remote tool group exposes all nine tool names", () => {
  const tools = createGitRemoteToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: fakeRegistry,
    ...fakeConfig,
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("git remote tool group has correct input schemas", () => {
  const tools = createGitRemoteToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: fakeRegistry,
    ...fakeConfig,
  });

  // git_remote_resolve_repo: repo (string), repo_path (string), no required fields
  assert.deepEqual(tools.git_remote_resolve_repo.inputSchema.required, []);
  assert.equal(tools.git_remote_resolve_repo.inputSchema.properties.repo, "string");
  assert.equal(tools.git_remote_resolve_repo.inputSchema.properties.repo_path, "string");

  // git_remote_fetch: repo, repo_path, remote, branch
  assert.deepEqual(tools.git_remote_fetch.inputSchema.required, []);
  assert.equal(tools.git_remote_fetch.inputSchema.properties.repo, "string");
  assert.equal(tools.git_remote_fetch.inputSchema.properties.remote, "string");
  assert.equal(tools.git_remote_fetch.inputSchema.properties.branch, "string");

  // git_remote_status: repo, repo_path, remote, branch, fetch
  assert.deepEqual(tools.git_remote_status.inputSchema.required, []);
  assert.equal(tools.git_remote_status.inputSchema.properties.fetch, "boolean");

  // git_remote_list_files: repo, repo_path, ref, path, limit
  assert.deepEqual(tools.git_remote_list_files.inputSchema.required, []);
  assert.equal(tools.git_remote_list_files.inputSchema.properties.ref, "string");
  assert.equal(tools.git_remote_list_files.inputSchema.properties.limit, "integer");

  // git_remote_read_file: repo, repo_path, ref, path (required), max_bytes
  assert.deepEqual(tools.git_remote_read_file.inputSchema.required, ["path"]);
  assert.equal(tools.git_remote_read_file.inputSchema.properties.max_bytes, "integer");

  // git_remote_changed_files: repo, repo_path, base, head, path, limit
  assert.deepEqual(tools.git_remote_changed_files.inputSchema.required, []);
  assert.equal(tools.git_remote_changed_files.inputSchema.properties.base, "string");
  assert.equal(tools.git_remote_changed_files.inputSchema.properties.head, "string");

  // git_remote_diff: repo, repo_path, base, head, path, max_bytes
  assert.deepEqual(tools.git_remote_diff.inputSchema.required, []);
  assert.equal(tools.git_remote_diff.inputSchema.properties.max_bytes, "integer");

  // git_remote_show_commit: repo, repo_path, ref, max_files
  assert.deepEqual(tools.git_remote_show_commit.inputSchema.required, []);
  assert.equal(tools.git_remote_show_commit.inputSchema.properties.max_files, "integer");

  // git_remote_compare_local: repo, repo_path, remote, branch, fetch, limit
  assert.deepEqual(tools.git_remote_compare_local.inputSchema.required, []);
  assert.equal(tools.git_remote_compare_local.inputSchema.properties.fetch, "boolean");
  assert.equal(tools.git_remote_compare_local.inputSchema.properties.limit, "integer");
});

test("git remote tool group has descriptions for all tools", () => {
  const tools = createGitRemoteToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: fakeRegistry,
    ...fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].description, "string", `${name} should have a description`);
    assert.ok(tools[name].description.length > 20, `${name} description should be meaningful`);
  }
});

test("git remote tool group handlers are callable functions", () => {
  const tools = createGitRemoteToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    registry: fakeRegistry,
    ...fakeConfig,
  });

  for (const name of expectedToolNames) {
    assert.equal(typeof tools[name].handler, "function", `${name}.handler should be a function`);
  }
});
