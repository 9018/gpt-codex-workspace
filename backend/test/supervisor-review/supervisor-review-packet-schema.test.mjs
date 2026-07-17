/**
 * supervisor-review-packet-schema.test.mjs — Tests for createSupervisorReviewPacket
 *
 * @module test/supervisor-review/supervisor-review-packet-schema
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorReviewPacket } from "../../src/supervisor-review/supervisor-review-packet-schema.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseInput = {
  run: { id: "run_1", state: "running", supervision: { controller_owner: "workmcp_autopilot", correction_cycles: 0 } },
  revision: { id: "rev_abc123", run_id: "run_1" },
  goalText: "Implement feature X",
  taskText: "Add the X module with tests",
  desiredOutcome: "All tests pass",
  nonGoals: ["Do not refactor Y"],
  repository: {
    worktree_path: "/home/user/project",
    base_sha: "abc123",
    head_sha: "def456",
    changed_files: ["src/x.mjs"],
    diff_summary: "Added X module",
    focused_diff: "+export function x() {}",
    new_symbols: ["x"],
    deleted_symbols: [],
  },
  allowedActions: ["continue_codex", "send_correction"],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("requires run.id", () => {
  assert.throws(
    () => createSupervisorReviewPacket({ ...baseInput, run: {} }),
    /run\.id is required/
  );
});

test("requires revision.id", () => {
  assert.throws(
    () => createSupervisorReviewPacket({ ...baseInput, revision: {} }),
    /revision\.id is required/
  );
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("creates packet with all expected sections", () => {
  const packet = createSupervisorReviewPacket(baseInput);
  assert.equal(packet.schema_version, 1);
  assert.ok(packet.id.startsWith("review_packet_"));
  assert.equal(packet.revision, baseInput.revision);
  assert.equal(packet.objective.goal_text, "Implement feature X");
  assert.equal(packet.objective.task_text, "Add the X module with tests");
  assert.deepEqual(packet.objective.non_goals, ["Do not refactor Y"]);
  assert.equal(packet.execution.run_id, "run_1");
  assert.equal(packet.execution.run_state, "running");
  assert.equal(packet.execution.controller_owner, "workmcp_autopilot");
  assert.equal(packet.repository.worktree_path, "/home/user/project");
  assert.equal(packet.repository.base_sha, "abc123");
  assert.ok(Array.isArray(packet.repository.new_symbols));
  assert.ok(Array.isArray(packet.repository.deleted_symbols));
  assert.ok(Array.isArray(packet.verification.evidence_gaps));
  assert.ok(Array.isArray(packet.limits.allowed_actions));
  assert.ok(Array.isArray(packet.review_questions));
  assert.equal(typeof packet.created_at, "string");
});

test("allowed_actions defaults to full set", () => {
  const { allowedActions, ...rest } = baseInput;
  const packet = createSupervisorReviewPacket(rest);
  assert.ok(packet.limits.allowed_actions.includes("continue_codex"));
  assert.ok(packet.limits.allowed_actions.includes("chatgpt_takeover"));
});

test("packet includes review questions", () => {
  const packet = createSupervisorReviewPacket(baseInput);
  assert.ok(packet.review_questions.length > 0);
  assert.ok(packet.review_questions.some((q) => q.includes("方向")));
});

// ---------------------------------------------------------------------------
// Security: no secret fields leaked
// ---------------------------------------------------------------------------

test("packet does not include api keys or tokens", () => {
  const packet = createSupervisorReviewPacket(baseInput);
  const json = JSON.stringify(packet);
  assert.ok(!json.includes("api_key"));
  assert.ok(!json.includes("token"));
  assert.ok(!json.includes("secret"));
  assert.ok(!json.includes("password"));
});

// ---------------------------------------------------------------------------
// TUI section
// ---------------------------------------------------------------------------

test("tui section defaults to null fields when session absent", () => {
  const packet = createSupervisorReviewPacket(baseInput);
  assert.equal(packet.tui.session_id, null);
  assert.equal(packet.tui.native_session_id, null);
  assert.equal(packet.tui.status, null);
});

test("tui section reflects provided session data", () => {
  const input = {
    ...baseInput,
    session: { session_id: "sess_1", native_session_id: "ns_1", status: "active" },
    progress: "50% done",
    recentLogExcerpt: "ERROR: timeout",
  };
  const packet = createSupervisorReviewPacket(input);
  assert.equal(packet.tui.session_id, "sess_1");
  assert.equal(packet.tui.native_session_id, "ns_1");
  assert.equal(packet.tui.status, "active");
  assert.equal(packet.tui.progress, "50% done");
  assert.equal(packet.tui.recent_log_excerpt, "ERROR: timeout");
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("limits include max_correction_scope_files and allowed_actions", () => {
  const packet = createSupervisorReviewPacket(baseInput);
  assert.equal(typeof packet.limits.max_correction_scope_files, "number");
  assert.ok(Array.isArray(packet.limits.allowed_actions));
});
