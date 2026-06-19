import test from "node:test";
import assert from "node:assert/strict";
import {
  isTaskTerminal,
  isCodexSessionInventoryTask,
  isCodexSessionInventoryTaskKind,
  extractTaskLimit,
} from "../src/task-status.mjs";

// ---------------------------------------------------------------------------
// isTaskTerminal
// ---------------------------------------------------------------------------

test("isTaskTerminal returns true for terminal statuses", () => {
  for (const status of ["completed", "failed", "waiting_for_review", "cancelled"]) {
    assert.equal(isTaskTerminal({ status }), true, `expected terminal for status=${status}`);
  }
});

test("isTaskTerminal returns false for non-terminal statuses", () => {
  for (const status of ["assigned", "queued", "running", "waiting_for_lock"]) {
    assert.equal(isTaskTerminal({ status }), false, `expected non-terminal for status=${status}`);
  }
});

test("isTaskTerminal returns false for null/undefined/empty", () => {
  assert.equal(isTaskTerminal(null), false);
  assert.equal(isTaskTerminal(undefined), false);
  assert.equal(isTaskTerminal({}), false);
  assert.equal(isTaskTerminal({ status: undefined }), false);
});

// ---------------------------------------------------------------------------
// isCodexSessionInventoryTask
// ---------------------------------------------------------------------------

function inventoryTask(overrides = {}) {
  return {
    assignee: "codex",
    status: "assigned",
    mode: "readonly",
    title: "Codex session metadata for 2026-06",
    description: "Collect metadata. Do not read session file contents.",
    ...overrides,
  };
}

test("isCodexSessionInventoryTask matches fully qualified inventory task", () => {
  assert.equal(isCodexSessionInventoryTask(inventoryTask()), true);
});

test("isCodexSessionInventoryTask rejects non-codex assignee", () => {
  assert.equal(isCodexSessionInventoryTask(inventoryTask({ assignee: "user" })), false);
});

test("isCodexSessionInventoryTask rejects non-assigned status", () => {
  assert.equal(isCodexSessionInventoryTask(inventoryTask({ status: "running" })), false);
});

test("isCodexSessionInventoryTask rejects non-readonly mode", () => {
  assert.equal(isCodexSessionInventoryTask(inventoryTask({ mode: "builder" })), false);
});

test("isCodexSessionInventoryTask rejects non-matching task kind", () => {
  assert.equal(isCodexSessionInventoryTask(inventoryTask({ title: "Regular task" })), false);
});

// ---------------------------------------------------------------------------
// isCodexSessionInventoryTaskKind
// ---------------------------------------------------------------------------

test("isCodexSessionInventoryTaskKind matches expected patterns", () => {
  const base = { assignee: "codex", title: "Codex session metadata June", description: "Do not read session file contents" };
  assert.equal(isCodexSessionInventoryTaskKind(base), true);
});

test("isCodexSessionInventoryTaskKind rejects non-codex assignee", () => {
  assert.equal(isCodexSessionInventoryTaskKind({ assignee: "user", title: "Codex session metadata", description: "Do not read session file contents" }), false);
});

test("isCodexSessionInventoryTaskKind rejects missing title pattern", () => {
  assert.equal(isCodexSessionInventoryTaskKind({ assignee: "codex", title: "Regular work", description: "Do not read session file contents" }), false);
});

test("isCodexSessionInventoryTaskKind rejects missing description pattern", () => {
  assert.equal(isCodexSessionInventoryTaskKind({ assignee: "codex", title: "Codex session metadata", description: "Normal task" }), false);
});

// ---------------------------------------------------------------------------
// extractTaskLimit
// ---------------------------------------------------------------------------

test("extractTaskLimit parses explicit limit from description", () => {
  assert.equal(extractTaskLimit("Return at most 10 files"), 10);
  assert.equal(extractTaskLimit("Return at most 200 files"), 200);
});

test("extractTaskLimit caps at 200", () => {
  assert.equal(extractTaskLimit("Return at most 500 files"), 200);
});

test("extractTaskLimit zero becomes fallback (0 is falsy in || guard)", () => {
  assert.equal(extractTaskLimit("Return at most 0 files"), 50); // original has `Number(match[1]) || fallback` so 0 is falsy
});

test("extractTaskLimit returns fallback when no match", () => {
  assert.equal(extractTaskLimit(""), 50);
  assert.equal(extractTaskLimit("List up to 20 files"), 50);
});

test("extractTaskLimit uses custom fallback", () => {
  assert.equal(extractTaskLimit("", 25), 25);
});

test("extractTaskLimit handles null/undefined gracefully", () => {
  assert.equal(extractTaskLimit(null), 50);
  assert.equal(extractTaskLimit(undefined), 50);
});

console.log("task-status tests loaded");
