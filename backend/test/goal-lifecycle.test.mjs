import test from "node:test";
import assert from "node:assert/strict";
import {
  titleFromGoal,
  normalizeGoalMessage,
  normalizeGoalMessages,
  normalizeGoalMemory,
  normalizeGoalMemories,
} from "../src/goal-lifecycle.mjs";

// ---------------------------------------------------------------------------
// titleFromGoal
// ---------------------------------------------------------------------------

test("titleFromGoal uses user_request when present", () => {
  const result = titleFromGoal({ user_request: "Add login page" });
  assert.equal(result, "Add login page");
});

test("titleFromGoal falls back to goal_prompt", () => {
  const result = titleFromGoal({ goal_prompt: "Fix the bug" });
  assert.equal(result, "Fix the bug");
});

test("titleFromGoal uses default when both absent", () => {
  const result = titleFromGoal({});
  assert.equal(result, "Codex goal");
});

test("titleFromGoal truncates at 80 chars", () => {
  const long = "a".repeat(100);
  const result = titleFromGoal({ user_request: long });
  assert.equal(result, `${"a".repeat(77)}...`);
  assert.equal(result.length, 80);
});

test("titleFromGoal normalizes whitespace", () => {
  const result = titleFromGoal({ user_request: "  hello   world\n  test  " });
  assert.equal(result, "hello world test");
});

// ---------------------------------------------------------------------------
// normalizeGoalMessage
// ---------------------------------------------------------------------------

test("normalizeGoalMessage assigns msg_ id", () => {
  const now = "2025-01-01T00:00:00.000Z";
  const result = normalizeGoalMessage({ role: "user", content: "hi" }, now, "user_1");
  assert.match(result.id, /^msg_/);
  assert.equal(result.role, "user");
  assert.equal(result.content, "hi");
  assert.equal(result.author_id, "user_1");
  assert.equal(result.created_at, now);
});

test("normalizeGoalMessage defaults role to user for unknown roles", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessage({ role: "admin", content: "test" }, now, "u1");
  assert.equal(result.role, "user");
});

test("normalizeGoalMessage normalizes role case", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessage({ role: "CODEX", content: "msg" }, now, "u1");
  assert.equal(result.role, "codex");
});

test("normalizeGoalMessage uses provided author_id and created_at", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessage(
    { role: "user", content: "hi", author_id: "custom_user", created_at: "2024-01-01" },
    now,
    "default_user"
  );
  assert.equal(result.author_id, "custom_user");
  assert.equal(result.created_at, "2024-01-01");
});

test("normalizeGoalMessage coerces content to string", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessage({ role: "user", content: 42 }, now, "u1");
  assert.equal(result.content, "42");
});

test("normalizeGoalMessage handles missing role", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessage({}, now, "u1");
  assert.equal(result.role, "user");
  assert.equal(result.content, "");
  assert.equal(result.author_id, "u1");
  assert.equal(result.created_at, now);
});

// ---------------------------------------------------------------------------
// normalizeGoalMessages
// ---------------------------------------------------------------------------

test("normalizeGoalMessages filters null/empty messages", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMessages([{ role: "user", content: "hi" }, null, { role: "codex", content: "" }], now, "u1");
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "hi");
});

test("normalizeGoalMessages returns empty array for non-array input", () => {
  const now = new Date().toISOString();
  assert.deepEqual(normalizeGoalMessages(null, now, "u1"), []);
  assert.deepEqual(normalizeGoalMessages(undefined, now, "u1"), []);
});

// ---------------------------------------------------------------------------
// normalizeGoalMemory
// ---------------------------------------------------------------------------

test("normalizeGoalMemory assigns mem_ id and required fields", () => {
  const now = "2025-01-01T00:00:00.000Z";
  const result = normalizeGoalMemory({ key: "note", value: "hello" }, "goal_1", "conv_1", now, "user_1");
  assert.match(result.id, /^mem_/);
  assert.equal(result.goal_id, "goal_1");
  assert.equal(result.conversation_id, "conv_1");
  assert.equal(result.key, "note");
  assert.equal(result.value, "hello");
  assert.equal(result.created_by, "user_1");
  assert.equal(result.created_at, now);
});

test("normalizeGoalMemory defaults key and value", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMemory({}, "g1", "c1", now, "u1");
  assert.equal(result.key, "note");
  assert.equal(result.value, "");
});

test("normalizeGoalMemory uses provided created_by and created_at", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMemory(
    { key: "k", value: "v", created_by: "someone", created_at: "2024-06-01" },
    "g1", "c1", now, "u1"
  );
  assert.equal(result.created_by, "someone");
  assert.equal(result.created_at, "2024-06-01");
});

// ---------------------------------------------------------------------------
// normalizeGoalMemories
// ---------------------------------------------------------------------------

test("normalizeGoalMemories filters null/empty memories", () => {
  const now = new Date().toISOString();
  const result = normalizeGoalMemories(
    [{ key: "a", value: "b" }, null, { key: "", value: "" }],
    "g1", "c1", now, "u1"
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "a");
});

test("normalizeGoalMemories returns empty array for non-array input", () => {
  const now = new Date().toISOString();
  assert.deepEqual(normalizeGoalMemories(null, "g1", "c1", now, "u1"), []);
  assert.deepEqual(normalizeGoalMemories(undefined, "g1", "c1", now, "u1"), []);
});
