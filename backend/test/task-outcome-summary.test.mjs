import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { buildTaskOutcomeSummary, updateWorkstreamContextFromCompletedTask } from "../src/workstream/task-outcome-summary.mjs";

test("failed or non-integrated task cannot produce a workstream outcome", () => {
  assert.equal(buildTaskOutcomeSummary({ task: { id: "t", status: "failed", workstream_id: "ws_x", task_context_digest: "sha256:x" }, goal: { id: "g" }, result: {} }).eligible, false);
  const nonIntegrated = buildTaskOutcomeSummary({
    task: { id: "t", status: "completed", workstream_id: "ws_x", task_context_digest: "sha256:x" },
    goal: { id: "g" }, result: { verification: { passed: true } }
  });
  assert.equal(nonIntegrated.eligible, false);
  assert.equal(nonIntegrated.reason, "integration_not_satisfied");
});

test("accepted integrated task updates workstream snapshot idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "workstream-outcome-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  store.state.workstreams = [{ id: "ws_outcome", title: "Outcome", updated_at: new Date().toISOString() }];
  await store.save();
  const task = { id: "task_outcome", status: "completed", workstream_id: "ws_outcome", task_context_digest: "sha256:context" };
  const goal = { id: "goal_outcome", workstream_id: "ws_outcome" };
  const result = {
    verification: { passed: true, report_path: "verify.json" },
    integration: { status: "merged", merged: true },
    commit: "abc123", repo_head: "def456",
    delivered_capabilities: [{ id: "cap", statement: "Capability delivered" }],
    durable_decisions: [{ id: "decision", statement: "Use Task isolation" }]
  };
  const first = await updateWorkstreamContextFromCompletedTask({ store, workspaceRoot: root, task, goal, result });
  assert.equal(first.applied, true);
  assert.equal(first.snapshot.revision, 1);
  assert.equal(first.snapshot.accepted_outcomes.length, 1);
  const second = await updateWorkstreamContextFromCompletedTask({ store, workspaceRoot: root, task, goal, result });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "outcome_already_applied");
  const state = await store.load();
  assert.equal(state.workstreams[0].context_revision, 1);
  assert.equal(state.workstreams[0].last_accepted_task_id, "task_outcome");
  const persistedOutcome = JSON.parse(await readFile(join(root, ".gptwork", "goals", "goal_outcome", "outcome.json"), "utf8"));
  assert.equal(persistedOutcome.task_id, "task_outcome");
  assert.equal(persistedOutcome.digest, first.outcome.digest);
});

test("completed readonly diagnostic task derives integration_not_required from acceptance contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "workstream-readonly-outcome-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  store.state.workstreams = [{ id: "ws_readonly", title: "Readonly", updated_at: new Date().toISOString() }];
  await store.save();
  const contract = {
    intent: { operation_kind: "diagnostic", mutation_scope: "none" },
    requirements: { requires_commit: false, requires_integration: false },
    requires_commit: false,
    requires_integration: false,
  };
  const task = { id: "task_readonly", status: "completed", workstream_id: "ws_readonly", task_context_digest: "sha256:readonly", acceptance_contract: contract };
  const goal = { id: "goal_readonly", workstream_id: "ws_readonly", acceptance_contract: contract };
  const result = { verification: { passed: true }, summary: "Diagnostic complete", changed_files: [] };
  const built = buildTaskOutcomeSummary({ task, goal, result });
  assert.equal(built.eligible, true);
  assert.equal(built.outcome.integration_not_required, true);
  assert.equal(built.outcome.integrated, false);
  const updated = await updateWorkstreamContextFromCompletedTask({ store, workspaceRoot: root, task, goal, result });
  assert.equal(updated.applied, true);
  assert.equal(updated.snapshot.revision, 1);
  assert.equal(updated.outcome_path, ".gptwork/goals/goal_readonly/outcome.json");
});
