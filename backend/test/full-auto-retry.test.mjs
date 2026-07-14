import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("full-auto-retry", () => {
  it("retry inherits parent contract hash", async () => {
    const { hashContract, createRetryIterationAtomic } = await import("../src/task-retry.mjs");

    const parentContract = {
      mode: "full",
      operation_kind: "code_change",
      requires_commit: true,
      requires_integration: true,
      retry_policy: { max_attempts: 3, backoff_ms: [0, 5000] },
      acceptance_policy: { auto_accept: true },
    };

    const parentHash = hashContract(parentContract);

    // Cannot test createRetryIterationAtomic without a real transaction,
    // but we can verify hashContract works and the clone preserves it
    const cloned = structuredClone(parentContract);
    const cloneHash = hashContract(cloned);

    assert.equal(cloneHash, parentHash, "Clone must have same hash as parent");
  });

  it("hashContract returns deterministic hashes", async () => {
    const { hashContract } = await import("../src/task-retry.mjs");

    const c1 = { mode: "full", requires_commit: true };
    const c2 = { mode: "full", requires_commit: true };

    assert.equal(hashContract(c1), hashContract(c2));
  });

  it("hashContract returns null for null input", async () => {
    const { hashContract } = await import("../src/task-retry.mjs");
    assert.equal(hashContract(null), null);
  });
});

it("retry inherits contract/provider, updates goal pointer, and terminalizes parent", async () => {
  const { createRetryIterationAtomic } = await import("../src/task-retry.mjs");
  const state = {
    tasks: [{
      id: "parent", goal_id: "goal", status: "running", attempt: 0,
      acceptance_contract: { mode: "full", retry_policy: { max_attempts: 2, backoff_ms: [0] } },
      metadata: { codex_execution_provider: "codex_tui_goal", tui_session_owner: "manual", tui_session_id: "old" },
      execution_mode: "worktree", worktree: { enabled: true }, title: "canary", mode: "full",
    }],
    goals: [{ id: "goal", task_id: "parent", status: "assigned" }],
    goal_queue: [{ task_id: "parent", status: "running" }],
  };
  const tx = {
    tasks: {
      async create(payload) { const task = { status: "queued", ...payload }; state.tasks.push(task); return task; },
      async setState(id, status, patch = {}) { const task = state.tasks.find((t) => t.id === id); task.status = status; task.result = { ...(task.result || {}), ...patch }; },
    },
    locks: { async releaseForTask() {} },
    queue: { async replaceIteration(parent, retry) { state.goal_queue[0].task_id = retry; state.goal_queue[0].status = "waiting"; } },
    goals: { async replaceTask(goalId, retry) { state.goals[0].task_id = retry; } },
    scheduler: { async schedule() {} },
  };
  const result = await createRetryIterationAtomic(tx, { task: state.tasks[0] }, { class: "no_meaningful_progress" });
  const retry = state.tasks.find((t) => t.id === result.retry_task_id);
  assert.deepEqual(retry.acceptance_contract, state.tasks[0].acceptance_contract);
  assert.equal(retry.metadata.codex_execution_provider, "codex_tui_goal");
  assert.equal(retry.metadata.tui_session_owner, undefined);
  assert.equal(state.tasks[0].status, "cancelled");
  assert.equal(state.goals[0].task_id, retry.id);
  assert.equal(state.goal_queue[0].task_id, retry.id);
});
