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

test("importFromIssues limits batches, assigns Codex, and dedupes repeated issue sync", async () => {
  const previousFetch = globalThis.fetch;
  const issues = [1, 2, 3].map((number) => ({
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    labels: [{ name: "gptwork-task" }],
    state: "open",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/issues/${number}`
  }));
  globalThis.fetch = async () => ({ ok: true, json: async () => issues });

  const state = { tasks: [], activities: [] };
  let saves = 0;
  const store = {
    load: async () => state,
    save: async () => { saves += 1; }
  };

  try {
    const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
    const first = await sync.importFromIssues(store, { limit: 2, assignToCodex: true });
    const second = await sync.importFromIssues(store, { limit: 2, assignToCodex: true });
    const third = await sync.importFromIssues(store, { limit: 2, assignToCodex: true });

    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
    assert.equal(third.length, 0);
    assert.equal(state.tasks.length, 3);
    assert.deepEqual(state.tasks.map((task) => task.github_issue_number), [1, 2, 3]);
    assert.deepEqual(state.tasks.map((task) => task.assignee), ["codex", "codex", "codex"]);
    assert.deepEqual(state.tasks.map((task) => task.status), ["queued", "queued", "queued"]);
    assert.equal(saves, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("pollIssues imports gptwork labels or GPTWork title prefixes without requiring both labels", async () => {
  const previousFetch = globalThis.fetch;
  const issues = [
    { number: 1, title: "Labelled task", body: "", labels: [{ name: "gptwork-task" }], state: "open", html_url: "https://github.com/owner/repo/issues/1" },
    { number: 2, title: "Labelled question", body: "", labels: [{ name: "gptwork-question" }], state: "open", html_url: "https://github.com/owner/repo/issues/2" },
    { number: 3, title: "[GPTWork Task] Title-only task", body: "", labels: [], state: "open", html_url: "https://github.com/owner/repo/issues/3" },
    { number: 4, title: "Unrelated issue", body: "", labels: [], state: "open", html_url: "https://github.com/owner/repo/issues/4" },
    { number: 5, title: "PR should not import", body: "", labels: [{ name: "gptwork-task" }], state: "open", html_url: "https://github.com/owner/repo/pull/5", pull_request: {} },
  ];
  const requestedPaths = [];
  globalThis.fetch = async (url) => {
    requestedPaths.push(String(url));
    return { ok: true, json: async () => issues };
  };

  try {
    const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
    const result = await sync.pollIssues();

    assert.equal(requestedPaths.some((url) => url.includes("labels=gptwork-task,gptwork-question")), false);
    assert.deepEqual(result.map((issue) => issue.number), [1, 2, 3]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("syncTask comments and closes imported GitHub issue by stored issue number", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/issues/4") && options.method === "PATCH") {
      return { ok: true, json: async () => ({ number: 4 }) };
    }
    if (String(url).endsWith("/issues/4/comments") && options.method === "POST") {
      return { ok: true, json: async () => ({ id: 40 }) };
    }
    throw new Error("unexpected GitHub request: " + String(url));
  };

  try {
    const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
    const result = await sync.syncTask({
      id: "task_imported",
      title: "Imported issue task",
      status: "completed",
      github_issue_number: 4,
      result: {
        summary: "Implemented hotfix",
        tests: "npm test: passed",
        commit: "abc123",
        remote_head: "abc123"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.issue, 4);
    assert.equal(result.updated, true);
    const patch = requests.find((request) => request.options.method === "PATCH");
    assert.ok(patch, "should PATCH the stored issue number");
    assert.ok(patch.url.endsWith("/issues/4"));
    const patchBody = JSON.parse(patch.options.body);
    assert.equal(patchBody.state, "closed");
    assert.match(patchBody.body, /abc123/);

    const comment = requests.find((request) => request.options.method === "POST" && request.url.endsWith("/issues/4/comments"));
    assert.ok(comment, "should post a result comment to the stored issue number");
    const commentBody = JSON.parse(comment.options.body).body;
    assert.match(commentBody, /Implemented hotfix/);
    assert.match(commentBody, /npm test: passed/);
    assert.match(commentBody, /abc123/);
    assert.equal(requests.some((request) => request.options.method === "POST" && request.url.endsWith("/issues")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// ---------------------------------------------------------------------------
// P1.3 Diagnostic tracking and skipped reasons tests
// ---------------------------------------------------------------------------

test("importFromIssues returns skipped_reasons when all issues are already imported", async () => {
  const previousFetch = globalThis.fetch;
  const issues = [
    { number: 1, title: "[Task] Issue 1 [queued]", body: "**Task ID**: `task_existing1`\nStuff", labels: [{ name: "gptwork-task" }], state: "open", html_url: "https://github.com/owner/repo/issues/1" },
    { number: 2, title: "[Task] Issue 2 [queued]", body: "**Task ID**: `task_existing2`\nStuff", labels: [{ name: "gptwork-task" }], state: "open", html_url: "https://github.com/owner/repo/issues/2" },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => issues });

  const state = {
    tasks: [
      { id: "task_existing1", title: "Existing1", github_issue_number: 1, github_issue_url: "https://github.com/owner/repo/issues/1" },
      { id: "task_existing2", title: "Existing2", github_issue_number: 2, github_issue_url: "https://github.com/owner/repo/issues/2" },
    ],
    activities: []
  };
  const store = { load: async () => state, save: async () => {} };

  try {
    const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
    const imported = await sync.importFromIssues(store);
    const diag = sync.getSyncDiagnostics();

    assert.equal(imported.length, 0);
    assert.ok(Array.isArray(diag.skipped_reasons));
    assert.ok(diag.skipped_reasons.length > 0, "should have skipped reasons");
    assert.ok(diag.last_raw_api_issue_count >= 2, "should track raw API count: got " + diag.last_raw_api_issue_count);
    assert.ok(diag.last_scanned_issue_count > 0, "should have scanned issue count > 0");
    assert.equal(diag.last_imported_tasks, 0);
    assert.equal(diag.last_imported_responses, 0);

    // Verify skip reasons include specific types
    const reasons = diag.skipped_reasons.map(r => r.reason);
    assert.ok(reasons.includes("already_imported") || reasons.includes("duplicate_issue_number"),
      "should include skip reasons like already_imported or duplicate_issue_number, got: " + reasons.join(", "));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("importFromIssues records no_open_issues skip with raw count when no issues match filters", async () => {
  const previousFetch = globalThis.fetch;
  // Issues without gptwork-task label AND without GPTWork title prefix
  const issues = [
    { number: 101, title: "Random thing", body: "", labels: [], state: "open", html_url: "https://github.com/owner/repo/issues/101" },
    { number: 102, title: "Another thing", body: "", labels: [], state: "open", html_url: "https://github.com/owner/repo/issues/102" },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => issues });

  const store = { load: async () => ({ tasks: [], chatgpt_requests: [] }), save: async () => {} };

  try {
    const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
    const imported = await sync.importFromIssues(store);
    const diag = sync.getSyncDiagnostics();

    assert.equal(imported.length, 0);
    assert.ok(Array.isArray(diag.skipped_reasons));
    const noOpenIssues = diag.skipped_reasons.find(s => s.reason === "no_open_issues");
    assert.ok(noOpenIssues, "should have no_open_issues skip reason");
    assert.ok(noOpenIssues.details.includes("raw API returned"), "details should mention raw API count: " + noOpenIssues.details);
    assert.ok(noOpenIssues.details.includes("2"), "should mention count of 2: " + noOpenIssues.details);
    assert.equal(diag.last_raw_api_issue_count, 2);
    assert.equal(diag.last_scanned_issue_count, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("getSyncDiagnostics returns all expected fields", () => {
  const sync = createGithubSync({ githubEnabled: true, githubRepo: "owner/repo", githubToken: "ghp_token123" });
  const diag = sync.getSyncDiagnostics();

  assert.ok(diag !== null && typeof diag === "object", "should return an object");
  assert.ok("last_sync_at" in diag);
  assert.ok("last_sync_ok" in diag);
  assert.ok("last_sync_error" in diag);
  assert.ok("last_raw_api_issue_count" in diag);
  assert.ok("last_imported_tasks" in diag);
  assert.ok("last_imported_responses" in diag);
  assert.ok("last_scanned_issue_count" in diag);
  assert.ok("skipped_reasons" in diag);
  assert.ok(Array.isArray(diag.skipped_reasons));
});
