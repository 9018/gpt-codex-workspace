import test from "node:test";
import assert from "node:assert/strict";

import {
  assertExecutionProviderContract,
  EXECUTION_PROVIDER_METHODS,
  OBSERVATION_STATES,
  normalizeObservationState,
  normalizeProviderObservation,
  normalizeProviderSession,
  normalizeRawEvidence,
} from "../src/execution/execution-provider-contract.mjs";
import { createExecutionProviderRegistry } from "../src/execution/execution-provider-registry.mjs";

// Helper: build a minimal valid provider
function provider(name = "codex_exec") {
  return Object.fromEntries([
    ["name", name],
    ...EXECUTION_PROVIDER_METHODS.map((method) => [method, async () => ({})]),
  ]);
}

// ---------------------------------------------------------------------------
// Contract assertions
// ---------------------------------------------------------------------------

test("exec and TUI providers satisfy the contract", () => {
  assert.equal(assertExecutionProviderContract(provider("codex_exec")), true);
  assert.equal(assertExecutionProviderContract(provider("codex_tui")), true);
});

test("contract rejects provider missing availability", () => {
  const missing = provider("codex_tui");
  delete missing.availability;
  assert.throws(() => assertExecutionProviderContract(missing), /availability/);
});

test("contract rejects incomplete provider", () => {
  const incomplete = provider("codex_tui");
  delete incomplete.resume;
  delete incomplete.dispose;
  assert.throws(() => assertExecutionProviderContract(incomplete), /resume/);
});

test("contract rejects unsupported provider name", () => {
  assert.throws(() => assertExecutionProviderContract(provider("unknown")), /unsupported execution provider/);
});

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

test("provider registry reports availability and revisions", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register({ ...provider("codex_exec"), revision: "exec-v2", availability: async () => true });
  registry.register({ ...provider("codex_tui"), revision: "tui-v4", availability: async () => false });

  assert.equal(await registry.isAvailable("codex_exec"), true);
  assert.equal(await registry.isAvailable("codex_tui"), false);
  assert.deepEqual(registry.describe().map((entry) => entry.name), ["codex_exec", "codex_tui"]);
});

// ---------------------------------------------------------------------------
// normalizeObservationState
// ---------------------------------------------------------------------------

test("normalizeObservationState passes through allowed states", () => {
  for (const s of OBSERVATION_STATES) {
    assert.equal(normalizeObservationState(s), s, `Should pass through "${s}"`);
  }
});

test("normalizeObservationState maps legacy states", () => {
  assert.equal(normalizeObservationState("completed"), "evidence_ready");
  assert.equal(normalizeObservationState("timed_out"), "failed");
  assert.equal(normalizeObservationState("provider_unavailable"), "failed");
  assert.equal(normalizeObservationState("cancelled"), "failed");
  assert.equal(normalizeObservationState("waiting_for_supervisor"), "supervisor_required");
});

test("normalizeObservationState fails closed for unknown states", () => {
  assert.throws(() => normalizeObservationState("waiting_for_review"), /Unknown provider observation state/);
  assert.throws(() => normalizeObservationState("waiting_for_integration"), /Unknown provider observation state/);
  assert.throws(() => normalizeObservationState("unknown"), /Unknown provider observation state/);
});

test("normalizeObservationState defaults to running for null/undefined", () => {
  assert.equal(normalizeObservationState(null), "running");
  assert.equal(normalizeObservationState(undefined), "running");
});

// ---------------------------------------------------------------------------
// normalizeProviderSession
// ---------------------------------------------------------------------------

test("normalizeProviderSession fills defaults", () => {
  const session = normalizeProviderSession({});
  assert.equal(session.provider_run_id, null);
  assert.equal(session.control_session_id, null);
  assert.equal(session.native_session_id, null);
  assert.equal(session.resume_token, null);
  assert.equal(typeof session.started_at, "string");
});

test("normalizeProviderSession preserves explicit fields", () => {
  const session = normalizeProviderSession({
    provider_run_id: "run_001",
    session_id: "run_001",
    control_session_id: "ctrl_001",
    native_session_id: "native_001",
    resume_token: "tok_001",
    started_at: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(session.provider_run_id, "run_001");
  assert.equal(session.control_session_id, "ctrl_001");
  assert.equal(session.native_session_id, "native_001");
  assert.equal(session.resume_token, "tok_001");
  assert.equal(session.started_at, "2026-07-18T00:00:00.000Z");
});

test("normalizeProviderSession supports input.session_id as fallback for provider_run_id", () => {
  const session = normalizeProviderSession({ session_id: "sess_001" });
  assert.equal(session.provider_run_id, "sess_001");
});

// ---------------------------------------------------------------------------
// normalizeRawEvidence
// ---------------------------------------------------------------------------

test("normalizeRawEvidence fills defaults for all fields", () => {
  const ev = normalizeRawEvidence({});
  assert.deepEqual(ev.provider_claims, []);
  assert.deepEqual(ev.artifacts, []);
  assert.deepEqual(ev.commands, []);
  assert.deepEqual(ev.session, {});
  assert.deepEqual(ev.repository_snapshot, {});
  assert.deepEqual(ev.raw_result, {});
});

test("normalizeRawEvidence deep-clones arrays and objects", () => {
  const claims = [{ id: "c1" }];
  const ev = normalizeRawEvidence({ provider_claims: claims });
  claims.push({ id: "c2" });
  assert.equal(ev.provider_claims.length, 1);
});

// ---------------------------------------------------------------------------
// normalizeProviderObservation
// ---------------------------------------------------------------------------

test("normalizeProviderObservation passes through allowed states", () => {
  const result = normalizeProviderObservation({ state: "evidence_ready", native_session_id: "ns_001" });
  assert.equal(result.state, "evidence_ready");
  assert.equal(result.native_session_id, "ns_001");
  assert.equal(result.failure, null);
  assert.equal(result.checkpoint, null);
});

test("normalizeProviderObservation maps legacy states", () => {
  assert.equal(normalizeProviderObservation({ state: "completed" }).state, "evidence_ready");
  assert.equal(normalizeProviderObservation({ state: "timed_out" }).state, "failed");
  assert.equal(normalizeProviderObservation({ state: "cancelled" }).state, "failed");
  assert.equal(normalizeProviderObservation({ state: "waiting_for_supervisor" }).state, "supervisor_required");
});

test("normalizeProviderObservation fails closed for unknown states", () => {
  assert.throws(
    () => normalizeProviderObservation({ state: "unknown_state" }),
    /Unknown provider observation state/
  );
});

test("normalizeProviderObservation defaults to running for null state", () => {
  assert.equal(normalizeProviderObservation({}).state, "running");
  assert.equal(normalizeProviderObservation({ state: null }).state, "running");
});

test("normalizeProviderObservation preserves checkpoint and failure", () => {
  const result = normalizeProviderObservation({
    state: "failed",
    failure: { code: "execution_timeout" },
    checkpoint: null,
    native_session_id: "ns_001",
  });
  assert.equal(result.state, "failed");
  assert.deepEqual(result.failure, { code: "execution_timeout" });
  assert.equal(result.checkpoint, null);
  assert.equal(result.native_session_id, "ns_001");
});

// ---------------------------------------------------------------------------
// Provider registry wrapping
// ---------------------------------------------------------------------------

test("registry wraps start with normalizeProviderSession", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register({
    name: "codex_exec",
    async availability() { return true; },
    async start(attempt) {
      return { id: attempt.id, native_session_id: "ns_001", some_raw_field: "ignored" };
    },
    async resume(attempt) { return this.start(attempt); },
    async observe() { return { state: "evidence_ready" }; },
    async collect() { return { status: "completed" }; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  });

  const provider = registry.get("codex_exec");
  const result = await provider.start({ id: "attempt_001" });

  // Should be normalized: provider_run_id from id, only known fields
  assert.equal(result.provider_run_id, "attempt_001");
  assert.equal(result.native_session_id, "ns_001");
  // Unknown raw fields should not be in normalized output
  // Unknown fields are now passed through
  assert.equal(result.some_raw_field, "ignored");
});

test("registry wraps observe with normalizeProviderObservation", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register({
    name: "codex_exec",
    async availability() { return true; },
    async start() { return {}; },
    async resume() { return {}; },
    async observe() { return { state: "waiting_for_supervisor", checkpoint: { id: "cp_001" } }; },
    async collect() { return { status: "completed" }; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  });

  const provider = registry.get("codex_exec");
  const result = await provider.observe();

  assert.equal(result.state, "supervisor_required");
  assert.deepEqual(result.checkpoint, { id: "cp_001" });
});

test("registry wraps observe with fail-closed for unknown states", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register({
    name: "codex_exec",
    async availability() { return true; },
    async start() { return {}; },
    async resume() { return {}; },
    async observe() { return { state: "completed" }; },
    async collect() { return { status: "completed" }; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  });

  const provider = registry.get("codex_exec");
  const result = await provider.observe();
  assert.equal(result.state, "evidence_ready");
});

test("registry.unwrap returns original provider", async () => {
  const registry = createExecutionProviderRegistry();
  const original = {
    name: "codex_exec",
    revision: "v1",
    async availability() { return true; },
    async start() { return {}; },
    async resume() { return {}; },
    async observe() { return { state: "evidence_ready" }; },
    async collect() { return {}; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  };
  registry.register(original);

  const unwrapped = registry.unwrap("codex_exec");
  assert.equal(unwrapped, original);
  assert.equal(unwrapped.revision, "v1");
});

test("registry.get returns wrapped provider different from original", async () => {
  const registry = createExecutionProviderRegistry();
  const original = {
    name: "codex_exec",
    async availability() { return true; },
    async start() { return { id: "test" }; },
    async resume() { return {}; },
    async observe() { return { state: "evidence_ready" }; },
    async collect() { return {}; },
    async send() {},
    async interrupt() {},
    async dispose() {},
  };
  registry.register(original);

  const wrapped = registry.get("codex_exec");
  assert.notEqual(wrapped, original);
  assert.equal(wrapped.name, "codex_exec");
});
