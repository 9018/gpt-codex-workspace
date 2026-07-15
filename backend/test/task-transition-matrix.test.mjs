import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTaskTransition,
  canTransitionTask,
  isTerminalPhase,
} from "../src/task-state/task-state-model.mjs";
import { TASK_EVENTS, isKnownTaskEvent } from "../src/task-state/task-transition-events.mjs";
import { TASK_STATUSES } from "../src/task-status-taxonomy.mjs";

test("all defined TASK_EVENTS are recognized", () => {
  for (const key of Object.keys(TASK_EVENTS)) {
    assert.ok(isKnownTaskEvent(TASK_EVENTS[key]), `event ${key}=${TASK_EVENTS[key]} should be known`);
  }
});

test("execution evidence ready moves collecting task to waiting_for_review", () => {
  const result = resolveTaskTransition({
    currentStatus: "collecting",
    event: "execution_evidence_ready",
    payload: { canonical_status: "waiting_for_review" },
  });
  assert.equal(result.nextStatus, "waiting_for_review");
  assert.ok(result.allowed);
});

test("execution session stop does not decide task acceptance", () => {
  const result = resolveTaskTransition({
    currentStatus: "running",
    event: "execution_session_stopped",
    payload: { evidence_available: true },
  });
  assert.equal(result.nextStatus, "collecting");
  assert.ok(result.allowed);
});

test("terminal task cannot regress to running", () => {
  assert.equal(
    canTransitionTask({ currentStatus: "completed", event: "execution_started" }),
    false,
  );
});

test("terminal task can be reconciled with reconciliation_correction", () => {
  assert.ok(
    canTransitionTask({
      currentStatus: "completed",
      event: "reconciliation_correction",
      payload: { canonical_status: "completed" },
    }),
  );
});

test("canonical decision completed may close review state", () => {
  const result = resolveTaskTransition({
    currentStatus: "waiting_for_review",
    event: "canonical_decision_applied",
    payload: { canonical_status: "completed" },
  });
  assert.equal(result.nextStatus, "completed");
  assert.ok(result.allowed);
});

test("cancel from running goes to cancelled", () => {
  const result = resolveTaskTransition({
    currentStatus: "running",
    event: "cancel_requested",
  });
  assert.equal(result.nextStatus, "cancelled");
  assert.ok(result.allowed);
});

test("runtime lost from running goes to waiting_for_repair", () => {
  const result = resolveTaskTransition({
    currentStatus: "running",
    event: "runtime_lost",
  });
  assert.equal(result.nextStatus, "waiting_for_repair");
  assert.ok(result.allowed);
});

test("collecting with evidence ready uses canonical_status from payload", () => {
  const result = resolveTaskTransition({
    currentStatus: "collecting",
    event: "execution_evidence_ready",
    payload: { canonical_status: "waiting_for_review" },
  });
  assert.equal(result.nextStatus, "waiting_for_review");
});

test("collecting with evidence failed repairable goes to waiting_for_repair", () => {
  const result = resolveTaskTransition({
    currentStatus: "collecting",
    event: "execution_evidence_failed",
    payload: { repairable: true },
  });
  assert.equal(result.nextStatus, "waiting_for_repair");
});

test("collecting with evidence failed not repairable goes to failed", () => {
  const result = resolveTaskTransition({
    currentStatus: "collecting",
    event: "execution_evidence_failed",
    payload: { repairable: false },
  });
  assert.equal(result.nextStatus, "failed");
});

test("waiting_for_repair with repair_scheduled goes to assigned", () => {
  const result = resolveTaskTransition({
    currentStatus: "waiting_for_repair",
    event: "repair_scheduled",
  });
  assert.equal(result.nextStatus, "assigned");
});

test("waiting_for_integration with integration_started goes to integrating", () => {
  const result = resolveTaskTransition({
    currentStatus: "waiting_for_integration",
    event: "integration_started",
  });
  assert.equal(result.nextStatus, "integrating");
});

test("integrating with integration_completed goes to completed", () => {
  const result = resolveTaskTransition({
    currentStatus: "integrating",
    event: "integration_completed",
    payload: { canonical_status: "completed" },
  });
  assert.equal(result.nextStatus, "completed");
});

test("unknown event returns not allowed", () => {
  const result = resolveTaskTransition({
    currentStatus: "assigned",
    event: "nonexistent_event",
  });
  assert.equal(result.allowed, false);
});

test("unknown status returns not allowed", () => {
  const result = resolveTaskTransition({
    currentStatus: "garbage_status",
    event: "execution_claimed",
  });
  assert.equal(result.allowed, false);
});

test("missing parameters return not allowed", () => {
  assert.equal(resolveTaskTransition({}).allowed, false);
  assert.equal(resolveTaskTransition({ currentStatus: "assigned" }).allowed, false);
});

test("terminal phase detection", () => {
  assert.ok(isTerminalPhase("completed"));
  assert.ok(isTerminalPhase("failed"));
  assert.ok(isTerminalPhase("cancelled"));
  assert.ok(isTerminalPhase("timed_out"));
  assert.ok(isTerminalPhase("blocked"));
  assert.equal(isTerminalPhase("running"), false);
  assert.equal(isTerminalPhase("assigned"), false);
});

import { isTerminalStatus as _isTerminalStatus } from "../src/task-status-taxonomy.mjs";

test("isTerminalStatus from model exports works", () => {
  assert.ok(_isTerminalStatus("completed"));
  assert.equal(_isTerminalStatus("running"), false);
});


test("reconciliation correction may repair active task to canonical terminal status", () => {
  const result = resolveTaskTransition({
    currentStatus: "running",
    event: TASK_EVENTS.RECONCILIATION_CORRECTION,
    payload: { canonical_status: "completed", audit: { reason: "durable result recovered" } },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.nextStatus, "completed");
  assert.equal(result.terminal, true);
});
