import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "github-dispatch");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function readFixture(name) {
  const p = path.join(FIXTURES_DIR, name);
  if (!existsSync(p)) {
    throw new Error(`Fixture not found: ${p}`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function readFixtureText(name) {
  const p = path.join(FIXTURES_DIR, name);
  return readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// Mock dispatch helpers (simulate the dispatch script's internal functions)
// ---------------------------------------------------------------------------

/**
 * Simulate handleIssues label checking without requiring GitHub API.
 */
function getLabelsFromIssue(issue) {
  return (issue.labels || []).map((label) =>
    typeof label === "string" ? label : (label.name || "")
  );
}

function hasGptworkTaskLabel(labels) {
  return labels.some((l) => l === "gptwork-task");
}

/**
 * Simulate issue body parsing for payload paths.
 */
function parseIssueBodyForPayload(body) {
  const zipMatch = body.match(/ZIP\s*base64:\s*`([^`]+)`|ZIP\s*base64:\s*([^\s]+)/i);
  const restoreMatch = body.match(/Restore\s+instructions:\s*`([^`]+)`|Restore\s+instructions:\s*([^\s]+)/i);
  const fallbackMatch = body.match(/Fallback\s+queued\s+task\s+file:\s*`([^`]+)`|Fallback\s+queued\s+task\s+file:\s*([^\s]+)/i);

  // Prefer ZIP base64
  if (zipMatch) return { source: "zip", path: zipMatch[1] || zipMatch[2] };
  if (restoreMatch) return { source: "restore", path: restoreMatch[1] || restoreMatch[2] };
  if (fallbackMatch) return { source: "fallback", path: fallbackMatch[1] || fallbackMatch[2] };
  return null;
}

/**
 * Simulate push event file filtering — aggregates added/modified files
 * from ALL commits in the push to catch payloads in non-head commits.
 */
function getGoalInboxFilesFromPush(payload) {
  const commits = payload.commits || (payload.head_commit ? [payload.head_commit] : []);
  const changedSet = new Set();
  for (const commit of commits) {
    for (const f of [...(commit.added || []), ...(commit.modified || [])]) {
      if (f.startsWith(".gptwork/goal-inbox/")) {
        changedSet.add(f);
      }
    }
  }
  return [...changedSet];
}

function selectBestPayload(changed) {
  const zipB64 = changed.filter((f) => f.endsWith(".zip.b64"));
  const taskMd = changed.filter((f) => f.endsWith("-task.md"));
  const restoreMd = changed.filter((f) => f.endsWith("-restore.md"));

  if (zipB64.length > 0) return zipB64[0];
  if (taskMd.length > 0) return taskMd[0];
  if (restoreMd.length > 0) return restoreMd[0];
  return null;
}

/**
 * Simulate markdown frontmatter parsing.
 */
function parseMarkdownFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const frontmatterLines = match[1].split("\n");
  const frontmatter = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      frontmatter[key] = val;
    }
  }

  return { frontmatter, body: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("fixtures directory exists", () => {
  assert.ok(existsSync(FIXTURES_DIR), `Fixtures dir should exist: ${FIXTURES_DIR}`);
});

test("fixtures have expected push event structure", () => {
  const payload = readFixture("push-event-goal-inbox.json");
  assert.equal(payload.ref, "refs/heads/main");
  assert.ok(payload.head_commit);
  assert.ok(Array.isArray(payload.head_commit.added));
});

test("fixtures have expected issues with gptwork-task structure", () => {
  const payload = readFixture("issues-opened-gptwork-task.json");
  assert.equal(payload.action, "opened");
  assert.equal(payload.issue.number, 42);
  assert.ok(payload.issue.labels.some((l) => l.name === "gptwork-task"));
});

test("fixtures have expected issues without gptwork-task structure", () => {
  const payload = readFixture("issues-opened-no-label.json");
  assert.equal(payload.issue.number, 99);
  assert.equal(payload.issue.labels.length, 1);
  assert.equal(payload.issue.labels[0].name, "bug");
});

test("fixtures have expected workflow_dispatch structure", () => {
  const payload = readFixture("workflow-dispatch-payload-path.json");
  assert.equal(payload.inputs.payload_path, ".gptwork/goal-inbox/foo-task.md");
});

test("zip.b64 fixture exists and is valid base64", () => {
  const b64Path = path.join(FIXTURES_DIR, "test-payload.zip.b64");
  assert.ok(existsSync(b64Path));

  const content = readFileSync(b64Path, "utf8").trim();
  const decoded = Buffer.from(content, "base64");

  // Should be a valid ZIP (starts with PK)
  assert.equal(decoded[0], 0x50);
  assert.equal(decoded[1], 0x4b);
});

test("sample task markdown fixture exists", () => {
  const mdPath = path.join(FIXTURES_DIR, "sample-task.md");
  assert.ok(existsSync(mdPath));
});

// -- Label checking tests --

test("detects gptwork-task label from fixture", () => {
  const payload = readFixture("issues-opened-gptwork-task.json");
  const labels = getLabelsFromIssue(payload.issue);
  assert.ok(hasGptworkTaskLabel(labels));
});

test("rejects issue without gptwork-task label", () => {
  const payload = readFixture("issues-opened-no-label.json");
  const labels = getLabelsFromIssue(payload.issue);
  assert.equal(hasGptworkTaskLabel(labels), false);
});

// -- Issue body parsing tests --

test("parses ZIP base64 path from issue body", () => {
  const payload = readFixture("issues-opened-gptwork-task.json");
  const result = parseIssueBodyForPayload(payload.issue.body);
  assert.ok(result);
  assert.equal(result.source, "zip");
  assert.equal(result.path, ".gptwork/goal-inbox/foo.zip.b64");
});

test("returns null for issues without payload references", () => {
  const payload = readFixture("issues-opened-no-label.json");
  const result = parseIssueBodyForPayload(payload.issue.body);
  assert.equal(result, null);
});

// -- Push event file discovery tests --

test("discovers goal-inbox files from push event", () => {
  const payload = readFixture("push-event-goal-inbox.json");
  const files = getGoalInboxFilesFromPush(payload);
  assert.ok(files.length > 0);
  assert.ok(files.includes(".gptwork/goal-inbox/foo.zip.b64"));
  assert.ok(files.includes(".gptwork/goal-inbox/foo-task.md"));
});

test("prefers zip.b64 over markdown in push event", () => {
  const payload = readFixture("push-event-goal-inbox.json");
  const files = getGoalInboxFilesFromPush(payload);
  const selected = selectBestPayload(files);
  assert.equal(selected, ".gptwork/goal-inbox/foo.zip.b64");
});

test("handles push event with no goal-inbox files", () => {
  const payload = {
    ref: "refs/heads/main",
    head_commit: { added: ["README.md"], modified: ["src/index.js"], removed: [] }
  };
  const files = getGoalInboxFilesFromPush(payload);
  assert.equal(files.length, 0);
  const selected = selectBestPayload(files);
  assert.equal(selected, null);
});


// -- Multi-commit push event tests --

test("discovers goal-inbox files from non-head commit in multi-commit push", () => {
  const payload = readFixture("push-event-multi-commit.json");
  const files = getGoalInboxFilesFromPush(payload);
  assert.ok(files.length > 0, "Should discover files from non-head commit");
  assert.ok(files.includes(".gptwork/goal-inbox/foo.zip.b64"));
  assert.ok(files.includes(".gptwork/goal-inbox/foo-task.md"));
});

test("prefers zip.b64 even when only present in non-head commit", () => {
  const payload = readFixture("push-event-multi-commit.json");
  const files = getGoalInboxFilesFromPush(payload);
  const selected = selectBestPayload(files);
  assert.equal(selected, ".gptwork/goal-inbox/foo.zip.b64");
});

test("deduplicates files appearing in multiple commits", () => {
  const payload = readFixture("push-event-multi-commit.json");
  const files = getGoalInboxFilesFromPush(payload);
  // Both commits have foo.zip.b64 ? No — only commit 0 has it.
  // Let's verify dedup by constructing a payload where same file appears twice.
  const dedupPayload = {
    ref: "refs/heads/main",
    commits: [
      { id: "c1", added: [".gptwork/goal-inbox/dup.zip.b64"], modified: [], removed: [] },
      { id: "c2", added: [".gptwork/goal-inbox/dup.zip.b64"], modified: [], removed: [] }
    ]
  };
  const dupFiles = getGoalInboxFilesFromPush(dedupPayload);
  assert.equal(dupFiles.length, 1, "Duplicate file should appear only once");
  assert.equal(dupFiles[0], ".gptwork/goal-inbox/dup.zip.b64");
});

test("multi-commit push with no goal-inbox files returns empty", () => {
  const payload = {
    ref: "refs/heads/main",
    commits: [
      { id: "c1", added: ["README.md"], modified: [], removed: [] },
      { id: "c2", added: [], modified: ["src/index.js"], removed: ["old.txt"] }
    ]
  };
  const files = getGoalInboxFilesFromPush(payload);
  assert.equal(files.length, 0);
});

// -- Markdown parsing tests --

test("parses YAML frontmatter from task markdown", () => {
  const content = readFixtureText("sample-task.md");
  const { frontmatter, body } = parseMarkdownFrontmatter(content);
  assert.ok(frontmatter);
  assert.equal(frontmatter.kind, "gptwork-task");
  assert.equal(frontmatter.assignee, "codex");
  assert.equal(frontmatter.mode, "builder");
  assert.ok(body);
  assert.ok(body.includes("Sample Task"));
});

test("handles markdown without frontmatter", () => {
  const content = "# Just a heading\n\nSome plain task text.\n";
  const { frontmatter, body } = parseMarkdownFrontmatter(content);
  assert.equal(frontmatter, null);
  assert.equal(body, content);
});

// -- Workflow dispatch input parsing --

test("extracts payload_path from workflow_dispatch inputs", () => {
  const payload = readFixture("workflow-dispatch-payload-path.json");
  assert.equal(payload.inputs.payload_path, ".gptwork/goal-inbox/foo-task.md");
});

test("zip.b64 decodes correctly to a ZIP file", () => {
  const b64Path = path.join(FIXTURES_DIR, "test-payload.zip.b64");
  const content = readFileSync(b64Path, "utf8").trim();
  const decoded = Buffer.from(content, "base64");

  // Check it's a valid ZIP
  assert.equal(decoded.readUInt32LE(0), 0x04034b50); // PK\x03\x04

  // Parse the central directory to find entries
  // Just check header
  assert.ok(decoded.length > 40, "ZIP should be larger than header size");
});

test("selectBestPayload returns null for empty list", () => {
  assert.equal(selectBestPayload([]), null);
});

test("selectBestPayload chooses zip.b64 over -task.md", () => {
  const files = [
    ".gptwork/goal-inbox/foo-task.md",
    ".gptwork/goal-inbox/foo.zip.b64",
  ];
  assert.equal(selectBestPayload(files), ".gptwork/goal-inbox/foo.zip.b64");
});

test("selectBestPayload chooses -task.md when no zip.b64", () => {
  const files = [
    ".gptwork/goal-inbox/foo-task.md",
    ".gptwork/goal-inbox/bar-restore.md",
  ];
  assert.equal(selectBestPayload(files), ".gptwork/goal-inbox/foo-task.md");
});

test("selectBestPayload falls back to -restore.md", () => {
  const files = [".gptwork/goal-inbox/bar-restore.md"];
  assert.equal(selectBestPayload(files), ".gptwork/goal-inbox/bar-restore.md");
});

test("parseIssueBodyForPayload handles backtick and non-backtick formats", () => {
  const body1 = "ZIP base64: `.gptwork/goal-inbox/x.zip.b64`";
  const body2 = "ZIP base64: .gptwork/goal-inbox/x.zip.b64";
  const r1 = parseIssueBodyForPayload(body1);
  const r2 = parseIssueBodyForPayload(body2);
  assert.equal(r1.path, ".gptwork/goal-inbox/x.zip.b64");
  assert.equal(r2.path, ".gptwork/goal-inbox/x.zip.b64");
});

test("parseIssueBodyForPayload parses restore instructions", () => {
  const body = "Restore instructions: `.gptwork/goal-inbox/some-restore.md`";
  const result = parseIssueBodyForPayload(body);
  assert.ok(result);
  assert.equal(result.source, "restore");
  assert.equal(result.path, ".gptwork/goal-inbox/some-restore.md");
});

test("parseIssueBodyForPayload parses fallback task file", () => {
  const body = "Fallback queued task file: `.gptwork/goal-inbox/some-task.md`";
  const result = parseIssueBodyForPayload(body);
  assert.ok(result);
  assert.equal(result.source, "fallback");
  assert.equal(result.path, ".gptwork/goal-inbox/some-task.md");
});
