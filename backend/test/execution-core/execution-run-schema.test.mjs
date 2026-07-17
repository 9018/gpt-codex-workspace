import test from "node:test";
import assert from "node:assert/strict";

import {
  createExecutionRun,
  EXECUTION_RUN_STATES,
  ACTIVE_RUN_STATES,
  WAITING_RUN_STATES,
  TERMINAL_RUN_STATES,
} from "../../src/execution-core/execution-run-schema.mjs";

// ---------------------------------------------------------------------------
// createExecutionRun
// ---------------------------------------------------------------------------

test("requires intent_id", () => {
  assert.throws(() => createExecutionRun({}), /intent_id is required/);
  assert.throws(() => createExecutionRun(), /intent_id is required/);
});

test("creates a run in 'created' state with default values", () => {
  const run = createExecutionRun({ intent_id: "intent_abc" });
  assert.ok(run.id.startsWith("run_"), `id should start with 'run_', got ${run.id}`);
  assert.equal(run.intent_id, "intent_abc");
  assert.equal(run.state, "created");
  assert.equal(run.request_id, null);
  assert.equal(run.idempotency_key, null);
  assert.equal(run.goal_id, null);
  assert.equal(run.task_id, null);
  assert.equal(run.workstream_id, null);
  assert.equal(run.plan_id, null);
  assert.equal(run.supervisor_plan_id, null);
  assert.equal(run.acceptance_contract_id, null);
  assert.equal(run.outcome, null);
  assert.equal(run.active_attempt_id, null);
  assert.deepEqual(run.attempt_ids, []);
  assert.equal(run.workspace_ref, null);
  assert.equal(run.context_ref, null);
  assert.equal(run.evidence_bundle_id, null);
  assert.equal(run.acceptance_decision_id, null);
  assert.equal(run.delivery_id, null);
  assert.equal(run.failure, null);
  assert.equal(run.active_checkpoint_id, null);
  assert.deepEqual(run.checkpoint_ids, []);
  assert.deepEqual(run.pending_effects, []);
  assert.deepEqual(run.applied_mutation_keys, []);
  assert.equal(run.version, 1);
  assert.equal(typeof run.created_at, "string");
  assert.equal(typeof run.updated_at, "string");
});

test("createExecutionRun includes supervision defaults", () => {
  const run = createExecutionRun({ intent_id: "intent_abc" });
  assert.ok(run.supervision, "supervision object should exist");
  assert.equal(run.supervision.controller_owner, "workmcp_autopilot");
  assert.equal(run.supervision.execution_mode, "native_tui");
  assert.equal(run.supervision.correction_cycles, 0);
  assert.equal(run.supervision.same_failure_retries, 0);
  assert.equal(run.supervision.native_resume_count, 0);
  assert.equal(run.supervision.chatgpt_takeover_count, 0);
  assert.equal(run.supervision.last_failure_signature, null);
  assert.equal(run.supervision.waiting_reason, null);
  assert.equal(run.supervision.takeover_reason, null);
  assert.equal(run.supervision.last_instruction_digest, null);
});

test("createExecutionRun preserves explicit fields", () => {
  const run = createExecutionRun({
    id: "run_custom_001",
    intent_id: "intent_abc",
    request_id: "req_001",
    idempotency_key: "idem_001",
    goal_id: "goal_xyz",
    task_id: "task_123",
    workstream_id: "ws_456",
    plan_id: "plan_789",
    supervisor_plan_id: "sp_001",
    acceptance_contract_id: "contract_abc",
  });
  assert.equal(run.id, "run_custom_001");
  assert.equal(run.intent_id, "intent_abc");
  assert.equal(run.request_id, "req_001");
  assert.equal(run.idempotency_key, "idem_001");
  assert.equal(run.goal_id, "goal_xyz");
  assert.equal(run.task_id, "task_123");
  assert.equal(run.workstream_id, "ws_456");
  assert.equal(run.plan_id, "plan_789");
  assert.equal(run.supervisor_plan_id, "sp_001");
  assert.equal(run.acceptance_contract_id, "contract_abc");
});

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

test("ACTIVE_RUN_STATES includes new active states", () => {
  assert.ok(ACTIVE_RUN_STATES.has("correcting"));
  assert.ok(ACTIVE_RUN_STATES.has("resuming"));
});

test("WAITING_RUN_STATES includes new waiting states", () => {
  assert.ok(WAITING_RUN_STATES.has("checkpointing"));
  assert.ok(WAITING_RUN_STATES.has("waiting_for_supervisor"));
  assert.ok(WAITING_RUN_STATES.has("waiting_for_supervisor_direct"));
  assert.ok(WAITING_RUN_STATES.has("chatgpt_direct"));
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test("state constants are frozen", () => {
  assert.throws(() => {
    EXECUTION_RUN_STATES.push("extra");
  }, /Cannot add property/);
});
