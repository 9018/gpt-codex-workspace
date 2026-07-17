import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionEvent, EVENT_TYPES } from "../../src/execution-core/execution-event-schema.mjs";
import { createExecutionEventStore } from "../../src/execution-core/execution-event-store.mjs";

// ---------------------------------------------------------------------------
// createExecutionEvent
// ---------------------------------------------------------------------------

test("requires run_id", () => {
  assert.throws(() => createExecutionEvent({ type: "run.created" }), /run_id is required/);
  assert.throws(() => createExecutionEvent({}), /run_id is required/);
});

test("requires valid event type", () => {
  assert.throws(
    () => createExecutionEvent({ run_id: "run_1", type: "invalid_type" }),
    /Invalid event type/
  );
});

test("requires valid severity", () => {
  assert.throws(
    () => createExecutionEvent({ run_id: "run_1", type: "run.created", severity: "critical" }),
    /Invalid severity/
  );
});

test("creates event with default values", () => {
  const event = createExecutionEvent({ run_id: "run_001", type: "run.created" });
  assert.ok(event.id.startsWith("evt_"), `id should start with 'evt_', got ${event.id}`);
  assert.equal(event.run_id, "run_001");
  assert.equal(event.type, "run.created");
  assert.equal(event.severity, "info");
  assert.equal(event.attempt_id, null);
  assert.deepEqual(event.data, {});
  assert.equal(event.source, "system");
  assert.equal(typeof event.created_at, "string");
});

test("preserves explicit fields", () => {
  const event = createExecutionEvent({
    id: "evt_custom",
    run_id: "run_001",
    attempt_id: "attempt_001",
    type: "attempt.failed",
    severity: "error",
    data: { code: "TIMEOUT" },
    source: "provider",
    created_at: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(event.id, "evt_custom");
  assert.equal(event.attempt_id, "attempt_001");
  assert.equal(event.severity, "error");
  assert.deepEqual(event.data, { code: "TIMEOUT" });
  assert.equal(event.source, "provider");
  assert.equal(event.created_at, "2026-07-18T00:00:00.000Z");
});

test("data is deep-cloned from input", () => {
  const original = { nested: { value: 1 } };
  const event = createExecutionEvent({
    run_id: "run_001",
    type: "run.state_changed",
    data: original,
  });
  original.nested.value = 2;
  assert.deepEqual(event.data, { nested: { value: 1 } });
});

// ---------------------------------------------------------------------------
// EVENT_TYPES constants
// ---------------------------------------------------------------------------

test("EVENT_TYPES contains all expected categories", () => {
  assert.ok(EVENT_TYPES.includes("run.created"));
  assert.ok(EVENT_TYPES.includes("run.state_changed"));
  assert.ok(EVENT_TYPES.includes("attempt.started"));
  assert.ok(EVENT_TYPES.includes("attempt.failed"));
  assert.ok(EVENT_TYPES.includes("evidence.collected"));
  assert.ok(EVENT_TYPES.includes("acceptance.decision"));
  assert.ok(EVENT_TYPES.includes("recovery.action"));
  assert.ok(EVENT_TYPES.includes("signal.supervisor_input"));
});

// ---------------------------------------------------------------------------
// Event Store - appendEvent / readEvent
// ---------------------------------------------------------------------------

test("appendEvent stores and returns event", async () => {
  const store = createExecutionEventStore();
  const event = await store.appendEvent({ run_id: "run_001", type: "run.created" });
  assert.ok(event.id.startsWith("evt_"));
  assert.equal(event.run_id, "run_001");

  const read = await store.readEvent(event.id);
  assert.deepEqual(read, event);
});

test("readEvent throws for unknown event", async () => {
  const store = createExecutionEventStore();
  await assert.rejects(() => store.readEvent("nonexistent"), /ExecutionEvent not found/);
});

// ---------------------------------------------------------------------------
// queryEvents
// ---------------------------------------------------------------------------

test("queryEvents returns all events without filters", async () => {
  const store = createExecutionEventStore();
  await store.appendEvent({ run_id: "run_1", type: "run.created" });
  await store.appendEvent({ run_id: "run_1", type: "run.state_changed" });
  await store.appendEvent({ run_id: "run_2", type: "run.created" });
  assert.equal((await store.queryEvents()).length, 3);
});

test("queryEvents filters by run_id", async () => {
  const store = createExecutionEventStore();
  await store.appendEvent({ run_id: "run_1", type: "run.created" });
  await store.appendEvent({ run_id: "run_2", type: "run.created" });

  const results = await store.queryEvents({ run_id: "run_1" });
  assert.equal(results.length, 1);
  assert.equal(results[0].run_id, "run_1");
});

test("queryEvents filters by type", async () => {
  const store = createExecutionEventStore();
  await store.appendEvent({ run_id: "run_1", type: "run.created" });
  await store.appendEvent({ run_id: "run_1", type: "run.state_changed" });

  const created = await store.queryEvents({ type: "run.created" });
  assert.equal(created.length, 1);

  const multi = await store.queryEvents({ type: ["run.created", "run.state_changed"] });
  assert.equal(multi.length, 2);
});

test("queryEvents filters by severity", async () => {
  const store = createExecutionEventStore();
  await store.appendEvent({ run_id: "run_1", type: "run.created", severity: "info" });
  await store.appendEvent({ run_id: "run_1", type: "attempt.failed", severity: "error" });

  const errors = await store.queryEvents({ severity: "error" });
  assert.equal(errors.length, 1);
});

test("queryEvents filters by time range", async () => {
  const store = createExecutionEventStore();
  const e1 = await store.appendEvent({ run_id: "run_1", type: "run.created", created_at: "2026-07-18T10:00:00.000Z" });
  const e2 = await store.appendEvent({ run_id: "run_1", type: "run.state_changed", created_at: "2026-07-18T11:00:00.000Z" });

  const range = await store.queryEvents({
    from: "2026-07-18T10:30:00.000Z",
    to: "2026-07-18T11:30:00.000Z",
  });
  assert.equal(range.length, 1);
  assert.equal(range[0].id, e2.id);
});

test("queryEvents respects limit", async () => {
  const store = createExecutionEventStore();
  await store.appendEvent({ run_id: "run_1", type: "run.created" });
  await store.appendEvent({ run_id: "run_1", type: "run.state_changed" });
  await store.appendEvent({ run_id: "run_1", type: "evidence.collected" });

  const limited = await store.queryEvents({ limit: 2 });
  assert.equal(limited.length, 2);
});

// ---------------------------------------------------------------------------
// Event immutability
// ---------------------------------------------------------------------------

test("events returned from store are immutable copies", async () => {
  const store = createExecutionEventStore();
  const event = await store.appendEvent({ run_id: "run_1", type: "run.created" });
  event.severity = "error"; // mutate the returned object

  const read = await store.readEvent(event.id);
  assert.equal(read.severity, "info");
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

test("count returns correct number of events", async () => {
  const store = createExecutionEventStore();
  assert.equal(await await store.count(), 0);
  await store.appendEvent({ run_id: "run_1", type: "run.created" });
  assert.equal(await await store.count(), 1);
  await store.appendEvent({ run_id: "run_1", type: "run.state_changed" });
  assert.equal(await await store.count(), 2);
});
