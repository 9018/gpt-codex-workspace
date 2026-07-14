import test from "node:test";
import assert from "node:assert/strict";
import { createTaskTransitionService } from "../src/task-state/task-transition-service.mjs";
import { TASK_EVENTS } from "../src/task-state/task-transition-events.mjs";

/**
 * Create a minimal fake store for testing transition service.
 */
function createFakeStore(initialTasks = []) {
  const state = {
    tasks: [...initialTasks],
    activities: [],
  };
  let version = 0;

  return {
    state,
    async load() { return state; },
    async mutate(updater) {
      const result = await updater(state);
      version++;
      return result;
    },
    getVersion() { return version; },
  };
}

test("transitionTask applies a valid transition", async () => {
  const store = createFakeStore([
    { id: "task_1", status: "assigned", title: "Test task", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  const result = await service.transitionTask({
    task_id: "task_1",
    event: "execution_claimed",
    expected_statuses: ["assigned"],
    idempotency_key: "test:claim:v1",
    source: "codex_exec",
    actor: { type: "system", id: "test" },
    reason: "claiming for test",
  });

  assert.ok(result.applied);
  assert.equal(result.idempotent_replay, false);
  assert.equal(result.previous_status, "assigned");
  assert.equal(result.next_status, "starting");
  assert.equal(result.task.status, "starting");
  assert.ok(result.event_record);
});

test("transitionTask returns idempotent replay for duplicate key", async () => {
  const store = createFakeStore([
    { id: "task_1", status: "assigned", title: "Test task", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  const first = await service.transitionTask({
    task_id: "task_1",
    event: "execution_claimed",
    expected_statuses: ["assigned"],
    idempotency_key: "test:dupe:v1",
    source: "codex_exec",
  });

  assert.ok(first.applied);

  const second = await service.transitionTask({
    task_id: "task_1",
    event: "execution_claimed",
    expected_statuses: ["assigned"],
    idempotency_key: "test:dupe:v1",
    source: "codex_exec",
  });

  assert.equal(second.applied, false);
  assert.ok(second.idempotent_replay);
  assert.equal(second.previous_status, first.previous_status);
  assert.equal(second.next_status, first.next_status);
});

test("transitionTask rejects status conflict", async () => {
  const store = createFakeStore([
    { id: "task_1", status: "running", title: "Test task", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  await assert.rejects(
    () => service.transitionTask({
      task_id: "task_1",
      event: "execution_claimed",
      expected_statuses: ["assigned"],
      idempotency_key: "test:conflict:v1",
      source: "codex_exec",
    }),
    { code: "task_transition_conflict" },
  );
});

test("transitionTask rejects disallowed transition", async () => {
  const store = createFakeStore([
    { id: "task_1", status: "completed", title: "Test terminal", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  await assert.rejects(
    () => service.transitionTask({
      task_id: "task_1",
      event: "execution_started",
      expected_statuses: [],
      idempotency_key: "test:terminal:v1",
      source: "codex_exec",
    }),
    { code: "task_transition_not_allowed" },
  );
});

test("transitionTask rejects invalid event", async () => {
  const store = createFakeStore([
    { id: "task_1", status: "assigned", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  await assert.rejects(
    () => service.transitionTask({
      task_id: "task_1",
      event: "invalid_event",
      expected_statuses: [],
      idempotency_key: "test:invalid:v1",
      source: "codex_exec",
    }),
    { code: "task_transition_invalid" },
  );
});

test("transitionTask full lifecycle flow", async () => {
  const store = createFakeStore([
    { id: "task_flow", status: "assigned", title: "Flow task", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  // assigned -> starting
  const r1 = await service.transitionTask({
    task_id: "task_flow", event: "execution_claimed",
    expected_statuses: ["assigned"],
    idempotency_key: "flow:claim", source: "codex_exec",
  });
  assert.equal(r1.next_status, "starting");

  // starting -> running
  const r2 = await service.transitionTask({
    task_id: "task_flow", event: "execution_started",
    expected_statuses: ["starting"],
    idempotency_key: "flow:start", source: "codex_exec",
  });
  assert.equal(r2.next_status, "running");

  // running -> collecting
  const r3 = await service.transitionTask({
    task_id: "task_flow", event: "execution_session_stopped",
    expected_statuses: ["running"],
    idempotency_key: "flow:stop", source: "codex_tui",
  });
  assert.equal(r3.next_status, "collecting");

  // collecting -> completed
  const r4 = await service.transitionTask({
    task_id: "task_flow", event: "execution_evidence_ready",
    expected_statuses: ["collecting"],
    payload: { canonical_status: "completed" },
    idempotency_key: "flow:evidence", source: "collector",
  });
  assert.equal(r4.next_status, "completed");

  // Verify final state
  const finalTask = store.state.tasks.find(t => t.id === "task_flow");
  assert.equal(finalTask.status, "completed");
  assert.ok(finalTask.completed_at);
  assert.equal(store.state.task_transition_events.length, 4);
});

test("transitionTask persists events in store", async () => {
  const store = createFakeStore([
    { id: "task_evt", status: "assigned", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  await service.transitionTask({
    task_id: "task_evt", event: "execution_claimed",
    expected_statuses: ["assigned"],
    idempotency_key: "evt:test", source: "codex_tui",
    actor: { type: "system", id: "test_actor" },
    reason: "testing event persistence",
  });

  assert.ok(Array.isArray(store.state.task_transition_events));
  assert.equal(store.state.task_transition_events.length, 1);

  const evt = store.state.task_transition_events[0];
  assert.equal(evt.task_id, "task_evt");
  assert.equal(evt.event, "execution_claimed");
  assert.equal(evt.previous_status, "assigned");
  assert.equal(evt.next_status, "starting");
  assert.equal(evt.source, "codex_tui");
  assert.equal(evt.actor.id, "test_actor");
  assert.ok(evt.idempotency_key);
  assert.ok(evt.persisted_at);
});

test("transitionTask with canonical decision requires unified_decision", async () => {
  const store = createFakeStore([
    { id: "task_cd", status: "collecting", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  await assert.rejects(
    () => service.transitionTask({
      task_id: "task_cd",
      event: "canonical_decision_applied",
      expected_statuses: ["collecting"],
      idempotency_key: "cd:missing",
      source: "finalizer",
    }),
    { code: "task_transition_missing_canonical_decision" },
  );
});

test("transitionTask canonical decision transition from waiting_for_review", async () => {
  const store = createFakeStore([
    { id: "task_cd2", status: "waiting_for_review", metadata: {} },
  ]);

  const service = createTaskTransitionService({ store });

  const result = await service.transitionTask({
    task_id: "task_cd2",
    event: "canonical_decision_applied",
    expected_statuses: ["waiting_for_review"],
    payload: {
      canonical_status: "completed",
      unified_decision: { status: "completed", blocking_passed: true },
      task_result_patch: { outcome: "accepted" },
    },
    idempotency_key: "cd:valid",
    source: "finalizer",
    reason: "all checks passed",
  });

  assert.equal(result.next_status, "completed");
  assert.equal(result.task.result.outcome, "accepted");
  assert.ok(store.state.tasks.find(t => t.id === "task_cd2").completed_at);
});
