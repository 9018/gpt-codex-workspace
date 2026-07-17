import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorTakeoverService } from "../../src/supervisor/supervisor-takeover-service.mjs";
import { createExecutionRunStore, StateConflictError } from "../../src/execution-core/execution-run-store.mjs";

test("takeover requires runStore", () => {
  assert.throws(() => createSupervisorTakeoverService({}), /runStore is required/);
});

test("takeover transitions from waiting_for_supervisor to chatgpt_direct", async () => {
  const runStore = createExecutionRunStore();
  let run = await runStore.createRun({ intent_id: "intent_001" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "running", nextState: "waiting_for_supervisor" });

  const svc = createSupervisorTakeoverService({ runStore });
  const result = await svc.takeover({ runId: run.id, reason: "Needs human judgment" });

  assert.ok(["chatgpt_direct", "waiting_for_supervisor_direct"].includes(result.run.state),
    `State should be chatgpt_direct or waiting_for_supervisor_direct, got ${result.run.state}`);
  assert.equal(result.run.supervision.controller_owner, "chatgpt_direct");
  assert.equal(result.run.supervision.chatgpt_takeover_count, 1);
  assert.equal(result.run.supervision.takeover_reason, "Needs human judgment");
  assert.ok(result.context_packet, "context packet should be present");
});

test("takeover throws for invalid state", async () => {
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001" });

  const svc = createSupervisorTakeoverService({ runStore });
  await assert.rejects(() => svc.takeover({ runId: run.id }), /Cannot takeover/);
});

test("relinquishControl transitions from chatgpt_direct to ready", async () => {
  const runStore = createExecutionRunStore();
  let run = await runStore.createRun({ intent_id: "intent_001" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "created", nextState: "planning" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "planning", nextState: "ready" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "ready", nextState: "running" });
  run = await runStore.compareAndSetState({ runId: run.id, expectedState: "running", nextState: "waiting_for_supervisor" });

  const svc = createSupervisorTakeoverService({ runStore });
  await svc.takeover({ runId: run.id });

  // Read current state (may be chatgpt_direct or waiting_for_supervisor_direct)
  const current = await runStore.readRun(run.id);
  if (current.state === "waiting_for_supervisor_direct") {
    // Need a second transition
    await runStore.compareAndSetState({
      runId: run.id, expectedState: "waiting_for_supervisor_direct", nextState: "chatgpt_direct",
      patch: { supervision: { ...current.supervision, controller_owner: "chatgpt_direct" } },
    });
  }

  const relinquished = await svc.relinquishControl({ runId: run.id });
  assert.equal(relinquished.run.state, "ready");
  assert.equal(relinquished.run.supervision.controller_owner, "workmcp_autopilot");
});

test("relinquishControl throws for invalid state", async () => {
  const runStore = createExecutionRunStore();
  const run = await runStore.createRun({ intent_id: "intent_001" });

  const svc = createSupervisorTakeoverService({ runStore });
  await assert.rejects(() => svc.relinquishControl({ runId: run.id }), /Cannot relinquish/);
});
