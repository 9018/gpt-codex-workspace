import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskTransition } from "../src/task-state/task-state-model.mjs";
import { TASK_EVENTS } from "../src/task-state/task-transition-events.mjs";

test("reconciliation can recover failed to completed with durable evidence", () => {
  const result = resolveTaskTransition({
    currentStatus: "failed",
    event: TASK_EVENTS.RECONCILIATION_CORRECTION,
    payload: { canonical_status: "completed" },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.nextStatus, "completed");
  assert.equal(result.terminal, true);
});
