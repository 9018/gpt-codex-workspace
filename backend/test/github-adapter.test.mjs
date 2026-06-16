import test from "node:test";
import assert from "node:assert/strict";
import { createGithubSync } from "../src/github-adapter.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

test("createGithubSync is disabled when no env vars", () => {
  const sync = createGithubSync({});
  assert.equal(sync.enabled, false);
  assert.equal(typeof sync.syncTask, "function");
  assert.equal(typeof sync.pollIssues, "function");
  assert.equal(typeof sync.importFromIssues, "function");
  assert.equal(typeof sync.importResponsesFromComments, "function");
  assert.equal(typeof sync.pollIssueComments, "function");
  assert.equal(typeof sync.syncChatGptRequest, "function");
  assert.equal(typeof sync.getKnownIssues, "function");
  assert.equal(typeof sync.syncAllTasks, "function");
  assert.equal(typeof sync.syncAllRequests, "function");
});

test("createGithubSync syncTask returns api call failed when fetch returns 404", async (t) => {
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  process.env.GPTWORK_GITHUB_REPO = "test/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "test-token";

  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 404,
    text: async () => '{"message":"Not Found"}',
    json: async () => ({ message: "Not Found" })
  }));

  const sync = createGithubSync({});
  assert.equal(sync.enabled, true);

  const result = await sync.syncTask({ id: "task_test123", title: "Test Task", status: "queued" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "api call failed");

  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});

test("createGithubSync pollIssues returns empty array when disabled", async () => {
  const sync = createGithubSync({});
  const issues = await sync.pollIssues();
  assert.deepEqual(issues, []);
});

test("createGithubSync importFromIssues returns empty when disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-store-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: join(root, "ws") });
  const sync = createGithubSync({});
  const imported = await sync.importFromIssues(store);
  assert.deepEqual(imported, []);
});

test("createGithubSync importResponsesFromComments returns empty when disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-store-2"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: join(root, "ws") });
  const sync = createGithubSync({});
  const responses = await sync.importResponsesFromComments(store);
  assert.deepEqual(responses, []);
});

test("createGithubSync tracks known issues after poll", async (t) => {
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  process.env.GPTWORK_GITHUB_REPO = "test/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "test-token";

  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/issues?labels=")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{
          number: 42,
          title: "[Task] Fix build [queued]",
          body: "## Task: Fix build\n\n**Task ID**: `task_abc123`\n",
          labels: [{ name: "gptwork-task" }],
          state: "open",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/test/repo/issues/42"
        }]
      };
    }
    return { ok: false, status: 404, text: async () => "" };
  });

  const sync = createGithubSync({});
  const issues = await sync.pollIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 42);
  assert.equal(issues[0].labels.includes("gptwork-task"), true);

  const known = sync.getKnownIssues();
  assert.equal(known.length, 1);

  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});

// ================================================================
// Tests: GPTWORK_GITHUB_ENABLED controls API sync
// ================================================================

test("createGithubSync GPTWORK_GITHUB_ENABLED=false disables even with repo/token", () => {
  const oldEnabled = process.env.GPTWORK_GITHUB_ENABLED;
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  process.env.GPTWORK_GITHUB_ENABLED = "false";
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret";
  const sync = createGithubSync({});
  assert.equal(sync.enabled, false, "should be disabled when GPTWORK_GITHUB_ENABLED=false");
  process.env.GPTWORK_GITHUB_ENABLED = oldEnabled || "";
  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});

test("createGithubSync GPTWORK_GITHUB_ENABLED=true enables API sync", () => {
  const oldEnabled = process.env.GPTWORK_GITHUB_ENABLED;
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  process.env.GPTWORK_GITHUB_ENABLED = "true";
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret";
  const sync = createGithubSync({});
  assert.equal(sync.enabled, true, "should be enabled when GPTWORK_GITHUB_ENABLED=true and repo/token set");
  process.env.GPTWORK_GITHUB_ENABLED = oldEnabled || "";
  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});

test("createGithubSync respects config.githubEnabled=false even with repo/token", () => {
  const oldEnabled = process.env.GPTWORK_GITHUB_ENABLED;
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  // Clear env so no auto-detect interference
  process.env.GPTWORK_GITHUB_ENABLED = "false";
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret";
  const sync = createGithubSync({});
  assert.equal(sync.enabled, false, "should respect githubEnabled=false from config");
  process.env.GPTWORK_GITHUB_ENABLED = oldEnabled || "";
  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});

test("createGithubSync status() reflects closure state, not direct env reads", () => {
  const oldRepo = process.env.GPTWORK_GITHUB_REPO;
  const oldToken = process.env.GPTWORK_GITHUB_TOKEN;
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret";
  const sync = createGithubSync({});
  const st = sync.status();
  assert.equal(st.api_sync_enabled, true, "status should report enabled");
  assert.equal(st.api_repo, "owner/repo");
  assert.equal(st.api_token_set, true);
  process.env.GPTWORK_GITHUB_REPO = oldRepo || "";
  process.env.GPTWORK_GITHUB_TOKEN = oldToken || "";
});
