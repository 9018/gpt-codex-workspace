import {
  writeBuilderAgentRun,
  writeFinalizerAgentRun,
  writeIntegratorAgentRun,
  writeReviewerAgentRun,
  writeVerifierAgentRun,
} from "../agent-run-writeback.mjs";
import { recordAgentRunWritebackFailure } from "../task-processing/agent-run-writeback-failure.mjs";

export async function notifyAppliedFinalizationCommand(command = {}, {
  taskResolver,
  notifyTerminalTaskFn,
} = {}) {
  if (command.status !== "applied") return { notified: false, reason: "command_not_applied" };
  if (command.action !== "complete_task") return { notified: false, reason: "not_terminal_notification_command" };
  if (typeof taskResolver !== "function") throw new TypeError("taskResolver is required");
  if (typeof notifyTerminalTaskFn !== "function") throw new TypeError("notifyTerminalTaskFn is required");

  const taskId = command.payload?.task_id || command.task_id;
  const task = await taskResolver(taskId, command);
  if (!task) return { notified: false, reason: "task_not_found", task_id: taskId || null };
  await notifyTerminalTaskFn(task);
  return { notified: true, task_id: task.id || taskId || null, action: command.action };
}

async function runNonBlockingAgentWrite({ role, taskResult, recordAgentRunWritebackFailureFn, writeFn }) {
  try {
    const result = await writeFn();
    return { ok: true, role, result };
  } catch (err) {
    recordAgentRunWritebackFailureFn(taskResult, role, err);
    return { ok: false, role, error: err?.message || String(err) };
  }
}

export async function writeFinalizationAgentRuns({
  store,
  task = {},
  goal = null,
  taskResult = {},
  taskStatus,
  context = {},
  writeBuilderAgentRunFn,
  writeIntegratorAgentRunFn,
  writeVerifierAgentRunFn,
  writeReviewerAgentRunFn,
  writeFinalizerAgentRunFn,
  recordAgentRunWritebackFailureFn,
} = {}) {
  const writebackCtx = { eventLogger: context?.eventLogger, hookBus: context?.hookBus };
  const common = { task_id: task.id, goal_id: goal?.id };
  const report = {};

  report.builder = await runNonBlockingAgentWrite({
    role: "builder",
    taskResult,
    recordAgentRunWritebackFailureFn,
    writeFn: () => writeBuilderAgentRunFn(store, {
      ...common,
      taskResult,
      summary: taskResult.summary || "",
    }, writebackCtx),
  });

  if (taskResult.integration?.status || taskResult.integration?.satisfied === true || taskResult.auto_integration_completion?.attempted === true) {
    report.integrator = await runNonBlockingAgentWrite({
      role: "integrator",
      taskResult,
      recordAgentRunWritebackFailureFn,
      writeFn: () => writeIntegratorAgentRunFn(store, {
        ...common,
        integrationResult: taskResult.integration || {},
      }, writebackCtx),
    });
    report.integrator.skipped = false;
  } else {
    report.integrator = { ok: true, role: "integrator", skipped: true, reason: "no_integration_result" };
  }

  report.verifier = await runNonBlockingAgentWrite({
    role: "verifier",
    taskResult,
    recordAgentRunWritebackFailureFn,
    writeFn: () => writeVerifierAgentRunFn(store, {
      ...common,
      verification: taskResult.verification || {},
    }, writebackCtx),
  });

  report.reviewer = await runNonBlockingAgentWrite({
    role: "reviewer",
    taskResult,
    recordAgentRunWritebackFailureFn,
    writeFn: () => writeReviewerAgentRunFn(store, {
      ...common,
      reviewer_decision: taskResult.reviewer_decision || { decision: { status: taskStatus } },
    }, writebackCtx),
  });

  report.finalizer = await runNonBlockingAgentWrite({
    role: "finalizer",
    taskResult,
    recordAgentRunWritebackFailureFn,
    writeFn: () => writeFinalizerAgentRunFn(store, {
      ...common,
      taskResult,
      taskStatus,
    }, writebackCtx),
  });

  return report;
}

export async function writeDefaultFinalizationAgentRuns({
  store,
  task,
  goal,
  taskResult,
  taskStatus,
  context,
  agentRunWriters = {},
  recordAgentRunWritebackFailureFn = recordAgentRunWritebackFailure,
} = {}) {
  return writeFinalizationAgentRuns({
    store,
    task,
    goal,
    taskResult,
    taskStatus,
    context,
    writeBuilderAgentRunFn: agentRunWriters.writeBuilderAgentRunFn || writeBuilderAgentRun,
    writeIntegratorAgentRunFn: agentRunWriters.writeIntegratorAgentRunFn || writeIntegratorAgentRun,
    writeVerifierAgentRunFn: agentRunWriters.writeVerifierAgentRunFn || writeVerifierAgentRun,
    writeReviewerAgentRunFn: agentRunWriters.writeReviewerAgentRunFn || writeReviewerAgentRun,
    writeFinalizerAgentRunFn: agentRunWriters.writeFinalizerAgentRunFn || writeFinalizerAgentRun,
    recordAgentRunWritebackFailureFn,
  });
}
