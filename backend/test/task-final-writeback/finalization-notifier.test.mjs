import test from "node:test";
import assert from "node:assert/strict";

import {
  notifyAppliedFinalizationCommand,
  writeDefaultFinalizationAgentRuns,
  writeFinalizationAgentRuns,
} from "../../src/task-finalization/finalization-notifier.mjs";

test("notifyAppliedFinalizationCommand notifies terminal task after complete_task applies", async () => {
  const notified = [];
  const task = { id: "task_1", status: "completed", result: { summary: "done" } };
  const command = {
    id: "pcmd_complete_1",
    status: "applied",
    action: "complete_task",
    task_id: "task_1",
    payload: { task_id: "task_1" },
  };

  const result = await notifyAppliedFinalizationCommand(command, {
    taskResolver: async () => task,
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });

  assert.deepEqual(notified, ["task_1"]);
  assert.deepEqual(result, { notified: true, task_id: "task_1", action: "complete_task" });
});

test("notifyAppliedFinalizationCommand ignores non-applied or non-terminal commands", async () => {
  const notified = [];

  const pending = await notifyAppliedFinalizationCommand({ status: "pending", action: "complete_task", task_id: "task_1" }, {
    taskResolver: async () => ({ id: "task_1", status: "completed" }),
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });
  const cleanup = await notifyAppliedFinalizationCommand({ status: "applied", action: "cleanup_worktree", task_id: "task_1" }, {
    taskResolver: async () => ({ id: "task_1", status: "completed" }),
    notifyTerminalTaskFn: async (item) => notified.push(item.id),
  });

  assert.deepEqual(notified, []);
  assert.deepEqual(pending, { notified: false, reason: "command_not_applied" });
  assert.deepEqual(cleanup, { notified: false, reason: "not_terminal_notification_command" });
});

test("writeFinalizationAgentRuns writes stage runs and records non-blocking failures", async () => {
  const calls = [];
  const failures = [];
  const taskResult = {
    summary: "done",
    verification: { passed: true },
    reviewer_decision: { passed: true },
    integration: { status: "merged" },
  };

  const result = await writeFinalizationAgentRuns({
    store: { state: {} },
    task: { id: "task_agent_runs" },
    goal: { id: "goal_agent_runs" },
    taskResult,
    taskStatus: "completed",
    context: { eventLogger: {}, hookBus: {} },
    writeBuilderAgentRunFn: async () => calls.push("builder"),
    writeIntegratorAgentRunFn: async () => calls.push("integrator"),
    writeVerifierAgentRunFn: async () => { throw new Error("verifier down"); },
    writeReviewerAgentRunFn: async () => calls.push("reviewer"),
    writeFinalizerAgentRunFn: async () => calls.push("finalizer"),
    recordAgentRunWritebackFailureFn: (_taskResult, role, err) => failures.push({ role, message: err.message }),
  });

  assert.deepEqual(calls, ["builder", "integrator", "reviewer", "finalizer"]);
  assert.deepEqual(failures, [{ role: "verifier", message: "verifier down" }]);
  assert.equal(result.verifier.ok, false);
  assert.equal(result.integrator.skipped, false);
});

test("writeDefaultFinalizationAgentRuns binds default agent writers", async () => {
  const calls = [];
  const failures = [];
  const taskResult = { summary: "done", verification: { passed: true }, reviewer_decision: { passed: true } };

  const result = await writeDefaultFinalizationAgentRuns({
    store: { state: {} },
    task: { id: "task_default_agent_runs" },
    goal: { id: "goal_default_agent_runs" },
    taskResult,
    taskStatus: "completed",
    context: { eventLogger: {}, hookBus: {} },
    agentRunWriters: {
      writeBuilderAgentRunFn: async () => calls.push("builder"),
      writeIntegratorAgentRunFn: async () => calls.push("integrator"),
      writeVerifierAgentRunFn: async () => calls.push("verifier"),
      writeReviewerAgentRunFn: async () => calls.push("reviewer"),
      writeFinalizerAgentRunFn: async () => calls.push("finalizer"),
    },
    recordAgentRunWritebackFailureFn: (_taskResult, role, err) => failures.push({ role, message: err.message }),
  });

  assert.deepEqual(calls, ["builder", "verifier", "reviewer", "finalizer"]);
  assert.deepEqual(failures, []);
  assert.equal(result.integrator.skipped, true);
  assert.equal(result.finalizer.ok, true);
});
