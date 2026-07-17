import test from "node:test";
import assert from "node:assert/strict";

import {
  createExecutionRun,
  EXECUTION_RUN_STATES,
  ACTIVE_RUN_STATES,
  WAITING_RUN_STATES,
  TERMINAL_RUN_STATES,
} from "../../src/execution-core/execution-run-schema.mjs";

import {
  isAllowedTransition,
  getAllowedTransitions,
  assertAllowedTransition,
} from "../../src/execution-core/execution-state-machine.mjs";

// ---------------------------------------------------------------------------
// Run state set sanity
// ---------------------------------------------------------------------------

test("EXECUTION_RUN_STATES contains all expected states", () => {
  assert.ok(EXECUTION_RUN_STATES.includes("created"));
  assert.ok(EXECUTION_RUN_STATES.includes("planning"));
  assert.ok(EXECUTION_RUN_STATES.includes("ready"));
  assert.ok(EXECUTION_RUN_STATES.includes("running"));
  assert.ok(EXECUTION_RUN_STATES.includes("collecting"));
  assert.ok(EXECUTION_RUN_STATES.includes("evaluating"));
  assert.ok(EXECUTION_RUN_STATES.includes("waiting_for_repair"));
  assert.ok(EXECUTION_RUN_STATES.includes("checkpointing"));
  assert.ok(EXECUTION_RUN_STATES.includes("correcting"));
  assert.ok(EXECUTION_RUN_STATES.includes("resuming"));
  assert.ok(EXECUTION_RUN_STATES.includes("waiting_for_review"));
  assert.ok(EXECUTION_RUN_STATES.includes("waiting_for_supervisor"));
  assert.ok(EXECUTION_RUN_STATES.includes("waiting_for_supervisor_direct"));
  assert.ok(EXECUTION_RUN_STATES.includes("chatgpt_direct"));
  assert.ok(EXECUTION_RUN_STATES.includes("waiting_for_integration"));
  assert.ok(EXECUTION_RUN_STATES.includes("completed"));
  assert.ok(EXECUTION_RUN_STATES.includes("failed"));
  assert.ok(EXECUTION_RUN_STATES.includes("cancelled"));
  assert.equal(EXECUTION_RUN_STATES.length, 18);
});

test("ACTIVE, WAITING, and TERMINAL sets partition all states", () => {
  const union = new Set([...ACTIVE_RUN_STATES, ...WAITING_RUN_STATES, ...TERMINAL_RUN_STATES]);
  for (const s of EXECUTION_RUN_STATES) {
    assert.ok(union.has(s), `State "${s}" is not in any category set`);
  }
  assert.equal(union.size, EXECUTION_RUN_STATES.length);
});

// ---------------------------------------------------------------------------
// Allowed transitions (happy path through the whole lifecycle)
// ---------------------------------------------------------------------------

test("full happy path: created -> planning -> ready -> running -> collecting -> evaluating -> completed", () => {
  assert.ok(isAllowedTransition("created", "planning"));
  assert.ok(isAllowedTransition("planning", "ready"));
  assert.ok(isAllowedTransition("ready", "running"));
  assert.ok(isAllowedTransition("running", "collecting"));
  assert.ok(isAllowedTransition("collecting", "evaluating"));
  assert.ok(isAllowedTransition("evaluating", "completed"));

  // Verify each transition via assertAllowedTransition
  assertAllowedTransition({ from: "created", to: "planning" });
  assertAllowedTransition({ from: "planning", to: "ready" });
  assertAllowedTransition({ from: "ready", to: "running" });
  assertAllowedTransition({ from: "running", to: "collecting" });
  assertAllowedTransition({ from: "collecting", to: "evaluating" });
  assertAllowedTransition({ from: "evaluating", to: "completed" });
});

// ---------------------------------------------------------------------------
// New supervising states
// ---------------------------------------------------------------------------

test("running can go to waiting_for_supervisor", () => {
  assert.ok(isAllowedTransition("running", "waiting_for_supervisor"));
});

test("collecting can go to waiting_for_supervisor", () => {
  assert.ok(isAllowedTransition("collecting", "waiting_for_supervisor"));
});

test("evaluating can go to waiting_for_supervisor", () => {
  assert.ok(isAllowedTransition("evaluating", "waiting_for_supervisor"));
});

test("waiting_for_supervisor can go to chatgpt_direct or waiting_for_supervisor_direct", () => {
  assert.ok(isAllowedTransition("waiting_for_supervisor", "chatgpt_direct"));
  assert.ok(isAllowedTransition("waiting_for_supervisor", "waiting_for_supervisor_direct"));
  assert.ok(isAllowedTransition("waiting_for_supervisor", "ready"));
  assert.ok(isAllowedTransition("waiting_for_supervisor", "running"));
});

test("waiting_for_supervisor_direct can go to chatgpt_direct", () => {
  assert.ok(isAllowedTransition("waiting_for_supervisor_direct", "chatgpt_direct"));
});

test("chatgpt_direct can go to running or ready", () => {
  assert.ok(isAllowedTransition("chatgpt_direct", "running"));
  assert.ok(isAllowedTransition("chatgpt_direct", "ready"));
});

// ---------------------------------------------------------------------------
// Checkpointing, correcting, resuming transitions
// ---------------------------------------------------------------------------

test("running can go to checkpointing", () => {
  assert.ok(isAllowedTransition("running", "checkpointing"));
});

test("evaluating does NOT go to checkpointing", () => {
  assert.equal(isAllowedTransition("evaluating", "checkpointing"), false);
});

test("checkpointing can go to correcting, resuming, ready, running, or waiting_for_supervisor", () => {
  assert.ok(isAllowedTransition("checkpointing", "correcting"));
  assert.ok(isAllowedTransition("checkpointing", "resuming"));
  assert.ok(isAllowedTransition("checkpointing", "ready"));
  assert.ok(isAllowedTransition("checkpointing", "running"));
  assert.ok(isAllowedTransition("checkpointing", "waiting_for_supervisor"));
});

test("correcting can go to running or collecting", () => {
  assert.ok(isAllowedTransition("correcting", "running"));
  assert.ok(isAllowedTransition("correcting", "collecting"));
});

test("resuming can go to running or collecting", () => {
  assert.ok(isAllowedTransition("resuming", "running"));
  assert.ok(isAllowedTransition("resuming", "collecting"));
});

// ---------------------------------------------------------------------------
// No direct collecting->completed path
// ---------------------------------------------------------------------------

test("collecting cannot go directly to completed", () => {
  assert.equal(isAllowedTransition("collecting", "completed"), false);
});

test("collecting cannot go to completed (must go through evaluating)", () => {
  assert.throws(
    () => assertAllowedTransition({ from: "collecting", to: "completed" }),
    /is not allowed/
  );
});

// ---------------------------------------------------------------------------
// Cancellation from any active state
// ---------------------------------------------------------------------------

test("can cancel from any active (non-terminal) state", () => {
  for (const state of EXECUTION_RUN_STATES) {
    if (TERMINAL_RUN_STATES.has(state)) {
      assert.ok(!isAllowedTransition(state, "cancelled"),
        `Should NOT allow cancellation from terminal state "${state}"`);
    } else {
      assert.ok(isAllowedTransition(state, "cancelled"),
        `Should allow cancellation from "${state}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// Repair / Review / Integration transitions
// ---------------------------------------------------------------------------

test("running can go to waiting_for_repair or waiting_for_review", () => {
  assert.ok(isAllowedTransition("running", "waiting_for_repair"));
  assert.ok(isAllowedTransition("running", "waiting_for_review"));
});

test("collecting can go to waiting_for_repair", () => {
  assert.ok(isAllowedTransition("collecting", "waiting_for_repair"));
});

test("evaluating can go to any waiting state or completed or failed", () => {
  assert.ok(isAllowedTransition("evaluating", "waiting_for_repair"));
  assert.ok(isAllowedTransition("evaluating", "waiting_for_review"));
  assert.ok(isAllowedTransition("evaluating", "waiting_for_supervisor"));
  assert.ok(isAllowedTransition("evaluating", "waiting_for_integration"));
  assert.ok(isAllowedTransition("evaluating", "completed"));
  assert.ok(isAllowedTransition("evaluating", "failed"));
});

test("waiting states can go back to ready or running (repair recovery)", () => {
  for (const waitState of ["waiting_for_repair", "waiting_for_review", "waiting_for_integration"]) {
    assert.ok(isAllowedTransition(waitState, "ready"),
      `"${waitState}" -> ready should be allowed`);
    assert.ok(isAllowedTransition(waitState, "running"),
      `"${waitState}" -> running should be allowed`);
  }
});

test("waiting_for_repair can go to failed or cancelled", () => {
  assert.ok(isAllowedTransition("waiting_for_repair", "failed"));
  assert.ok(isAllowedTransition("waiting_for_repair", "cancelled"));
});

// ---------------------------------------------------------------------------
// Terminal state invariants
// ---------------------------------------------------------------------------

test("terminal states have no outgoing transitions", () => {
  for (const terminal of ["completed", "failed", "cancelled"]) {
    const allowed = getAllowedTransitions(terminal);
    assert.equal(allowed.size, 0,
      `Terminal state "${terminal}" should have 0 outgoing transitions, got ${[...allowed]}`);
  }
});

test("assertAllowedTransition throws for transition from terminal state", () => {
  assert.throws(
    () => assertAllowedTransition({ from: "completed", to: "running" }),
    /Cannot transition from terminal state/
  );
  assert.throws(
    () => assertAllowedTransition({ from: "failed", to: "planning" }),
    /Cannot transition from terminal state/
  );
  assert.throws(
    () => assertAllowedTransition({ from: "cancelled", to: "created" }),
    /Cannot transition from terminal state/
  );
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

test("assertAllowedTransition throws for impossible transitions", () => {
  assert.throws(
    () => assertAllowedTransition({ from: "created", to: "completed" }),
    /Transition from "created" to "completed" is not allowed/
  );
  assert.throws(
    () => assertAllowedTransition({ from: "created", to: "running" }),
    /is not allowed/
  );
  assert.throws(
    () => assertAllowedTransition({ from: "planning", to: "collecting" }),
    /is not allowed/
  );
  assert.throws(
    () => assertAllowedTransition({ from: "collecting", to: "completed" }),
    /is not allowed/
  );
});

// ---------------------------------------------------------------------------
// isAllowedTransition returns false for invalid transitions
// ---------------------------------------------------------------------------

test("isAllowedTransition returns false for unknown source state", () => {
  assert.equal(isAllowedTransition("unknown_state", "created"), false);
});

test("isAllowedTransition returns false for unknown target state", () => {
  assert.equal(isAllowedTransition("created", "unknown_state"), false);
});

// ---------------------------------------------------------------------------
// getAllowedTransitions
// ---------------------------------------------------------------------------

test("getAllowedTransitions returns correct set for each state", () => {
  const createdAllowed = getAllowedTransitions("created");
  assert.ok(createdAllowed.has("planning"));
  assert.ok(createdAllowed.has("cancelled"));
  assert.equal(createdAllowed.size, 2);

  const evaluatingAllowed = getAllowedTransitions("evaluating");
  assert.ok(evaluatingAllowed.has("completed"));
  assert.ok(evaluatingAllowed.has("waiting_for_integration"));
  assert.ok(evaluatingAllowed.has("waiting_for_repair"));
  assert.ok(evaluatingAllowed.has("waiting_for_review"));
  assert.ok(evaluatingAllowed.has("waiting_for_supervisor"));
  assert.ok(evaluatingAllowed.has("failed"));
  assert.ok(evaluatingAllowed.has("cancelled"));
  assert.equal(evaluatingAllowed.size, 7);

  const runningAllowed = getAllowedTransitions("running");
  assert.ok(runningAllowed.has("collecting"));
  assert.ok(runningAllowed.has("evaluating"));
  assert.ok(runningAllowed.has("checkpointing"));
  assert.ok(runningAllowed.has("waiting_for_repair"));
  assert.ok(runningAllowed.has("waiting_for_review"));
  assert.ok(runningAllowed.has("waiting_for_supervisor"));
});

// ---------------------------------------------------------------------------
// assertAllowedTransition includes metadata in error
// ---------------------------------------------------------------------------

test("assertAllowedTransition includes runId in error message when provided", () => {
  try {
    assertAllowedTransition({ from: "created", to: "completed", metadata: { runId: "run_001" } });
    assert.fail("Should have thrown");
  } catch (e) {
    assert.ok(e.message.includes("run_001"), `Message should include runId, got: ${e.message}`);
    assert.ok(e.message.includes("created"), `Message should include current state`);
    assert.ok(e.message.includes("completed"), `Message should include target state`);
  }
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

test("state constants are frozen", () => {
  assert.throws(() => {
    EXECUTION_RUN_STATES.push("extra");
  }, /Cannot add property/);
});
