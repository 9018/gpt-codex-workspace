/**
 * supervisor-review-tools.test.mjs — Tests for Review/Decision Tools
 *
 * @module test/supervisor-review/supervisor-review-tools
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorReviewTools } from "../../src/tool-groups/supervisor-review/supervisor-review-tools.mjs";
import { createSupervisorDecisionTools } from "../../src/tool-groups/supervisor-review/supervisor-decision-tools.mjs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const activeRun = {
  id: "run_1",
  version: 3,
  state: "running",
  supervision: {
    controller_owner: "codex_active",
    correction_cycles: 1,
    chatgpt_takeover_count: 0,
  },
};

function createMockDeps(overrides = {}) {
  return {
    runStore: {
      readRun: async (id) => ({ ...activeRun, id }),
    },
    commandStore: {
      listPendingByRun: async () => [],
      createFromDecision: async (decision, run) => ({
        id: `cmd_${decision.action}`,
        run_id: run.id,
        decision_id: decision.id,
        action: decision.action,
        status: "pending",
      }),
    },
    decisionStore: {
      recordDecision: async (decision) => ({ ...decision }),
    },
    reviewRequestStore: {
      listByRun: async () => [],
    },
    leaseManager: {
      getLease: async () => ({ owner: "codex_active", epoch: 0 }),
      listActiveLeases: async () => [{ owner: "codex_active", run_id: "run_1" }],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Review Tool
// ---------------------------------------------------------------------------

test("review tool lists active runs without calling TUI sender", async () => {
  const tools = createSupervisorReviewTools(createMockDeps());
  const result = await tools.supervisor_review_active_runs.handler({});
  assert.ok(result.runs);
  assert.ok(result.runs.length > 0);
  assert.equal(result.runs[0].run_id, "run_1");
});

test("review tool filters by run ID", async () => {
  const tools = createSupervisorReviewTools(createMockDeps());
  const result = await tools.supervisor_review_active_runs.handler({ runId: "run_1" });
  assert.equal(result.runs.length, 1);
});

test("review tool returns empty for unknown run", async () => {
  const tools = createSupervisorReviewTools({
    ...createMockDeps(),
    runStore: {
      readRun: async () => { throw new Error("not found"); },
    },
  });
  const result = await tools.supervisor_review_active_runs.handler({ runId: "run_unknown" });
  assert.equal(result.runs.length, 0);
});

// ---------------------------------------------------------------------------
// Decision Tool
// ---------------------------------------------------------------------------

test("submit continue_codex does NOT create a command", async () => {
  const tools = createSupervisorDecisionTools(createMockDeps());
  const result = await tools.supervisor_submit_decisions.handler({
    decisions: [{
      id: "dec_1",
      run_id: "run_1",
      review_revision_id: "rev_001",
      verdict: "aligned",
      action: "continue_codex",
    }],
  });
  assert.ok(result.ok);
  assert.equal(result.total, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].command_created, false);
  assert.equal(result.results[0].command_id, null);
});

test("submit send_correction creates a command", async () => {
  const tools = createSupervisorDecisionTools(createMockDeps({
    decisionStore: {
      recordDecision: async (d) => ({ ...d }),
    },
  }));
  const result = await tools.supervisor_submit_decisions.handler({
    decisions: [{
      id: "dec_2",
      run_id: "run_1",
      review_revision_id: "rev_002",
      verdict: "minor_drift",
      action: "send_correction",
      correction: {
        objective: "Fix drift",
        required_changes: ["Refactor X"],
      },
    }],
  });
  assert.ok(result.ok);
  assert.equal(result.results[0].command_created, true);
  assert.ok(result.results[0].command_id);
});

// ---------------------------------------------------------------------------
// Batch partial failure isolation
// ---------------------------------------------------------------------------

test("batch submit handles partial failures in isolation", async () => {
  let callCount = 0;
  const tools = createSupervisorDecisionTools({
    ...createMockDeps(),
    decisionStore: {
      recordDecision: async (d) => {
        callCount++;
        if (callCount === 2) throw new Error("Simulated store failure");
        return { ...d };
      },
    },
  });

  const result = await tools.supervisor_submit_decisions.handler({
    decisions: [
      {
        id: "dec_3",
        run_id: "run_1",
        review_revision_id: "rev_003",
        verdict: "aligned",
        action: "continue_codex",
      },
      {
        id: "dec_4",
        run_id: "run_1",
        review_revision_id: "rev_004",
        verdict: "minor_drift",
        action: "continue_codex",
      },
      {
        id: "dec_5",
        run_id: "run_1",
        review_revision_id: "rev_005",
        verdict: "aligned",
        action: "continue_codex",
      },
    ],
  });

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.ok, false);

  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[2].ok, true);
});
