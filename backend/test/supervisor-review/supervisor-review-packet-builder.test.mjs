/**
 * supervisor-review-packet-builder.test.mjs — Tests for Review Packet Builder
 *
 * @module test/supervisor-review/supervisor-review-packet-builder
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorReviewPacketBuilder } from "../../src/supervisor-review/supervisor-review-packet-builder.mjs";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    runStore: {
      readRun: async () => ({
        id: "run_1",
        version: 3,
        state: "running",
        supervision: { controller_owner: "codex_active", correction_cycles: 1 },
        context_ref: "ctx_1",
        acceptance_contract_digest: "acc123",
      }),
    },
    checkpointReader: {
      latest: async () => ({ id: "cp_1", digest: "cp_digest_1" }),
    },
    planReader: {
      readForRun: async () => ({
        version: 2,
        architecture_principles: ["principle_1"],
      }),
    },
    repositoryEvidence: {
      collect: async () => ({
        worktree_path: "/home/user/project",
        base_sha: "abc123",
        head_sha: "def456",
        changed_files: ["src/x.mjs"],
        diff_summary: "Added X",
        focused_diff: "+export function x()",
        new_symbols: ["x"],
        deleted_symbols: [],
        diff_digest: "diff_abc",
        dirty_paths: ["src/x.mjs"],
      }),
    },
    tuiProgressReader: {
      read: async () => ({ progress: "50% done" }),
    },
    tuiSessionReader: {
      read: async () => ({ session_id: "sess_1", native_session_id: "ns_1", status: "active" }),
    },
    decisionStore: {
      listByRun: async () => [{ id: "dec_1", verdict: "aligned" }],
    },
    contextReader: {
      read: async () => ({ digest: "ctx_digest_1" }),
    },
    objectiveReader: {
      read: async () => ({
        goalText: "Implement feature X",
        taskText: "Add X module",
        desiredOutcome: "All tests pass",
        nonGoals: ["No refactor Y"],
      }),
    },
    architectureBaselineReader: {
      read: async () => ({
        principles: ["Principle 1"],
        prohibitedPatterns: ["Pattern 1"],
        requiredFlow: ["Flow 1"],
        designDocs: ["doc.md"],
      }),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Successful build
// ---------------------------------------------------------------------------

test("build returns a complete SupervisorReviewPacket", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.ok(packet.id.startsWith("review_packet_"));
  assert.equal(packet.schema_version, 1);
  assert.equal(packet.execution.run_id, "run_1");
  assert.equal(packet.execution.run_state, "running");
  assert.equal(packet.execution.controller_owner, "codex_active");
});

test("build includes objective from objectiveReader", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.equal(packet.objective.goal_text, "Implement feature X");
  assert.equal(packet.objective.task_text, "Add X module");
  assert.deepEqual(packet.objective.non_goals, ["No refactor Y"]);
});

test("build includes architecture baseline from architectureBaselineReader", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.deepEqual(packet.architecture_baseline.principles, ["Principle 1"]);
  assert.deepEqual(packet.architecture_baseline.prohibited_patterns, ["Pattern 1"]);
});

test("build includes repository evidence", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.equal(packet.repository.worktree_path, "/home/user/project");
  assert.equal(packet.repository.focused_diff, "+export function x()");
  assert.deepEqual(packet.repository.new_symbols, ["x"]);
});

test("build includes TUI session and progress", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.equal(packet.tui.session_id, "sess_1");
  assert.equal(packet.tui.native_session_id, "ns_1");
  assert.equal(packet.tui.status, "active");
  assert.equal(packet.tui.progress, "50% done");
});

test("build includes prior decisions", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });

  assert.ok(packet.execution.prior_decisions.length > 0);
  assert.equal(packet.execution.prior_decisions[0].id, "dec_1");
});

test("build produces deterministic revision", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet1 = await builder.build({ runId: "run_1" });
  const packet2 = await builder.build({ runId: "run_1" });

  assert.equal(packet1.revision.id, packet2.revision.id);
});

// ---------------------------------------------------------------------------
// Evidence gaps handling
// ---------------------------------------------------------------------------

test("failing optional reader adds evidence gap not thrown error", async () => {
  const deps = createMockDeps({
    tuiProgressReader: {
      read: async () => { throw new Error("Progress reader unavailable"); },
    },
  });
  const builder = createSupervisorReviewPacketBuilder(deps);
  const packet = await builder.build({ runId: "run_1" });

  assert.ok(packet.verification.evidence_gaps.length > 0);
  assert.ok(packet.verification.evidence_gaps.some((g) => g.includes("tuiProgress")));
});

test("multiple failing readers produce multiple evidence gaps", async () => {
  const deps = createMockDeps({
    tuiProgressReader: { read: async () => { throw new Error("fail"); } },
    tuiSessionReader: { read: async () => { throw new Error("fail"); } },
  });
  const builder = createSupervisorReviewPacketBuilder(deps);
  const packet = await builder.build({ runId: "run_1" });

  assert.ok(packet.verification.evidence_gaps.length >= 2);
});

test("objectiveReader failure produces evidence gap", async () => {
  const deps = createMockDeps({
    objectiveReader: { read: async () => { throw new Error("Objective not available"); } },
  });
  const builder = createSupervisorReviewPacketBuilder(deps);
  const packet = await builder.build({ runId: "run_1" });

  assert.ok(packet.verification.evidence_gaps.length > 0);
  assert.equal(packet.objective.goal_text, null); // graceful fallback
});

// ---------------------------------------------------------------------------
// Bounded packet: large datasets trimmed
// ---------------------------------------------------------------------------

test("packet does not exceed reasonable size", async () => {
  const builder = createSupervisorReviewPacketBuilder(createMockDeps());
  const packet = await builder.build({ runId: "run_1" });
  const json = JSON.stringify(packet);

  // Should be well under 100KB for typical payload
  assert.ok(json.length < 100000, `Packet too large: ${json.length} bytes`);
  assert.ok(json.length > 200, `Packet too small: ${json.length} bytes`);
});
