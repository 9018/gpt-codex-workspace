import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubSync, parseRepo, parseIssueNumber } from "../src/github-adapter.mjs";

test("parseRepo extracts owner/repo from various formats", () => {
  assert.equal(parseRepo("9018/gpt-codex-workspace"), "9018/gpt-codex-workspace");
  assert.equal(parseRepo("https://github.com/9018/gpt-codex-workspace"), "9018/gpt-codex-workspace");
  assert.equal(parseRepo("https://github.com/9018/gpt-codex-workspace.git"), "9018/gpt-codex-workspace");
  assert.equal(parseRepo("git@github.com:9018/gpt-codex-workspace.git"), "9018/gpt-codex-workspace");
  assert.equal(parseRepo("repo:9018/gpt-codex-workspace"), "9018/gpt-codex-workspace");
  assert.equal(parseRepo(""), null);
  assert.equal(parseRepo(null), null);
});

test("parseIssueNumber extracts issue numbers", () => {
  assert.equal(parseIssueNumber("Issue #1"), 1);
  assert.equal(parseIssueNumber("#42"), 42);
  assert.equal(parseIssueNumber("issue 100"), 100);
  assert.equal(parseIssueNumber("no number here"), null);
});

test("createGithubSync returns an object with expected methods", () => {
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);
  assert.equal(typeof sync, "object");
  assert.equal(sync.enabled, false);
  assert.equal(typeof sync.syncTask, "function");
  assert.equal(typeof sync.pollIssues, "function");
  assert.equal(typeof sync.status, "function");
  assert.equal(typeof sync.syncAllTasks, "function");
});

test("createGithubSync returns disabled status when not configured", () => {
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);
  const status = sync.status();
  assert.equal(status.api_sync_enabled, false);
  assert.equal(status.api_token_set, false);
  assert.equal(status.api_repo, null);
});

test("syncTask returns not-configured when github not enabled", async () => {
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);
  const result = await sync.syncTask({ id: "test-1", title: "test", status: "open" });
  assert.deepEqual(result, { ok: false, reason: "github not configured" });
});

test("addIssueComment method exists", async () => {
  const { createGithubSync } = await import("../src/github-adapter.mjs");
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);
  assert.equal(typeof sync.addIssueComment, "function", "addIssueComment should be a method");
});

test("buildResultComment method exists", async () => {
  const { createGithubSync } = await import("../src/github-adapter.mjs");
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);
  assert.equal(typeof sync.buildResultComment, "function", "buildResultComment should be a method");
});

test("buildResultComment produces correct output", async () => {
  const { createGithubSync } = await import("../src/github-adapter.mjs");
  const config = { githubRepo: "", githubToken: "" };
  const sync = createGithubSync(config);

  const task = {
    id: "task_123",
    title: "Test task",
    status: "completed",
    result: {
      summary: "Implemented feature X",
      tests: "npm test: passed 15/15",
      commit: "abc123def456",
      remote_head: "abc123def456",
      changed_files: ["src/file1.js", "src/file2.js"],
      warnings: ["Minor lint issue"]
    }
  };

  const comment = sync.buildResultComment(task);
  assert.ok(comment.includes("Complete"), "should mention Complete");
  assert.ok(comment.includes("abc123def456"), "should include commit SHA");
  assert.ok(comment.includes("pass"), "should include test result");
  assert.ok(comment.includes("task_123"), "should include task ID");
});

// ---------------------------------------------------------------------------
// P1.2 GitHub sync config consistency tests
// ---------------------------------------------------------------------------

test("createGithubSync uses config.githubEnabled for enabled state", () => {
  // With githubEnabled: true but no repo/token, should be disabled
  const config1 = { githubEnabled: true, githubRepo: "", githubToken: "" };
  const sync1 = createGithubSync(config1);
  assert.equal(sync1.enabled, false, "needs repo and token");

  // With githubEnabled: false but repo and token set, should be disabled
  const config2 = { githubEnabled: false, githubRepo: "owner/repo", githubToken: "ghp_token123" };
  const sync2 = createGithubSync(config2);
  assert.equal(sync2.enabled, false, "explicit false should disable");

  // With githubEnabled: true and repo/token, should be enabled
  const config3 = { githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" };
  const sync3 = createGithubSync(config3);
  assert.equal(sync3.enabled, true, "all three set should enable");
});

test("status() returns consistent values matching resolved config", () => {
  const config = { githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" };
  const sync = createGithubSync(config);
  const status = sync.status();

  assert.equal(status.api_sync_enabled, true);
  assert.equal(status.api_repo, "owner/repo");
  assert.equal(status.api_token_set, true);
});

test("status() shows disabled when only repo/token are set without enabled flag", () => {
  // config.githubEnabled defaults to false/undefined when not set
  const config = { githubRepo: "owner/repo", githubToken: "ghp_token123" };
  const sync = createGithubSync(config);
  const status = sync.status();

  assert.equal(status.api_sync_enabled, false, "should be disabled without explicit githubEnabled");
  assert.equal(status.api_repo, "owner/repo");
  assert.equal(status.api_token_set, true);
});

test("syncTask returns not-configured when explicitly disabled", async () => {
  const config = { githubEnabled: false, githubRepo: "owner/repo", githubToken: "ghp_token123" };
  const sync = createGithubSync(config);
  const result = await sync.syncTask({ id: "test-1", title: "test", status: "open" });
  assert.deepEqual(result, { ok: false, reason: "github not configured" });
});
