import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
});
