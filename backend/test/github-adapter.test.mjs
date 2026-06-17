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
