import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  handleResolveRepo,
  handleFetch,
  handleStatus,
  handleListFiles,
  handleReadFile,
  handleChangedFiles,
  handleDiff,
  handleShowCommit,
  handleCompareLocal,
} from "../src/git-remote-tools.mjs";

const noopContext = {
  registry: null,
  defaultWorkspaceRoot: null,
  defaultRepo: "",
  defaultBranch: "main",
  defaultRepoPath: null,
  defaultRemote: "origin",
};

test("module exports all expected handler functions", () => {
  assert.equal(typeof handleResolveRepo, "function");
  assert.equal(typeof handleFetch, "function");
  assert.equal(typeof handleStatus, "function");
  assert.equal(typeof handleListFiles, "function");
  assert.equal(typeof handleReadFile, "function");
  assert.equal(typeof handleChangedFiles, "function");
  assert.equal(typeof handleDiff, "function");
  assert.equal(typeof handleShowCommit, "function");
  assert.equal(typeof handleCompareLocal, "function");
});

test("handleResolveRepo resolves current repo from cwd fallback", () => {
  const result = handleResolveRepo({}, noopContext);
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.ok(result.repo_path);
  assert.ok(result.remote_url);
});

test("handleFetch fetches from default remote", () => {
  const result = handleFetch({}, noopContext);
  assert.equal(result.ok, true);
  assert.ok(result.repo_path);
});

test("handleStatus returns git status for current repo", () => {
  const result = handleStatus({}, noopContext);
  assert.equal(result.ok, true);
  assert.ok(result.repo_path);
  assert.equal(typeof result.dirty, "boolean");
  assert.ok(Array.isArray(result.dirty_paths));
});

test("handleListFiles lists files in current repo", () => {
  const result = handleListFiles({ limit: 5 }, noopContext);
  assert.equal(result.ok, true);
  assert.ok(result.total_count > 0);
  assert.ok(Array.isArray(result.files));
  assert.ok(result.files.length <= 5);
});

test("handleReadFile returns error when path is missing", () => {
  const result = handleReadFile({}, noopContext);
  assert.equal(result.ok, false);
  assert.equal(result.error, "path is required");
});

test("handleReadFile reads a known file", () => {
  const result = handleReadFile({ path: "README.md" }, noopContext);
  assert.equal(result.ok, true);
  assert.ok(result.content);
  assert.ok(result.content.includes("GPT-Codex Workspace"));
});
