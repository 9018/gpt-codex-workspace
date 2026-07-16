import test from "node:test";
import assert from "node:assert/strict";

import { finalizeCodexTaskRun } from "../src/task-final-writeback.mjs";

function createPersistentStore({ task, goal }) {
  const state = {
    tasks: [{ ...task, logs: [] }],
    goals: [{ ...goal }],
    goal_queue: [{
      queue_id: `queue_${task.id}`,
      goal_id: goal.id,
      task_id: task.id,
      status: "running",
      auto_start: true,
    }],
    activities: [],
    agent_runs: [],
    progression_commands: {},
    progression_command_idempotency: {},
  };
  return {
    state,
    mutationSnapshots: [],
    async load() { return state; },
    async mutate(updater) {
      const result = await updater(state);
      this.mutationSnapshots.push(structuredClone(state));
      return result;
    },
  };
}

function makeArgs({ taskStatus = "completed", integrationRequired = false } = {}) {
  const task = {
    id: integrationRequired ? "task_waiting_integration" : "task_completed",
    goal_id: integrationRequired ? "goal_waiting_integration" : "goal_completed",
    title: "Persist canonical progression commands",
    status: "running",
    attempt: 0,
    max_attempts: 2,
    logs: [],
  };
  const goal = {
    id: task.goal_id,
    title: task.title,
    workspace_id: "hosted-default",
    status: "running",
    acceptance_contract: {
      intent: { operation_kind: integrationRequired ? "code_change" : "diagnostic", semantic_confidence: "high" },
      requirements: {
        requires_commit: integrationRequired,
        requires_integration: integrationRequired,
        requires_no_mutation: !integrationRequired,
      },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    },
  };
  const store = createPersistentStore({ task, goal });
  const contractVerification = {
    contract_valid: true,
    blocking_passed: true,
    completion_eligible: true,
    requires_review: false,
    blockers: [],
    non_blocking_followups: [],
    quality_notes: [],
    state_assertions: { passed: true, failures: [] },
  };
  const integration = integrationRequired
    ? { required: true, status: "branch_pushed", satisfied: false, terminal: false }
    : { required: false, status: "not_required", satisfied: true, terminal: true };
  const taskResult = {
    kind: "codex_executed",
    summary: task.title,
    operation_kind: integrationRequired ? "code_change" : "diagnostic",
    repo_mutated: integrationRequired,
    no_mutation: !integrationRequired,
    changed_files: integrationRequired ? ["backend/src/example.mjs"] : [],
    commit: integrationRequired ? "abc123" : null,
    integration,
    needs_integration: integrationRequired,
    warnings: [],
    followups: [],
    reviewer_decision: { status: "accepted", passed: true },
    verification: {
      passed: true,
      status: "completed",
      commands: [{ cmd: "node --test", exit_code: 0 }],
      findings: [],
      contract_verification: contractVerification,
    },
    contract_verification: contractVerification,
  };

  return {
    store,
    args: {
      store,
      config: { defaultWorkspaceRoot: "/tmp", maxRepairAttempts: 2 },
      task,
      taskStatus,
      taskResult,
      doneAt: "2026-07-17T08:00:00.000Z",
      cr: { returncode: 0, timed_out: false },
      workspace: { root: "/tmp/progression-boundary" },
      goal,
      workspaceFiles: { result_md: "/tmp/result.md", dir: "/tmp" },
      summary: task.title,
      resultJsonPath: null,
      context: {},
      runFilePath: null,
      repoLockPath: null,
      github: { syncTask: async () => ({ ok: true }) },
      appendGoalMessageFn: async () => {},
      writeWorkspaceTextInternalFn: async () => {},
      writeFileFn: async () => {},
      verifyTaskCompletionFn: async () => taskResult.verification,
      runAcceptanceGateFn: async () => ({
        passed: true,
        status: "passed",
        contract_verification: contractVerification,
        closure_decision: integrationRequired
          ? {
              status: "waiting_for_integration",
              reason: "integration_required_not_terminal",
              blocking_passed: true,
              auto_complete_allowed: false,
              requires_human_decision: false,
              task_status: "waiting_for_integration",
              blockers: [],
              repairable_blockers: [],
            }
          : {
              status: "auto_completed_clean",
              reason: "blocking_requirements_satisfied",
              blocking_passed: true,
              auto_complete_allowed: true,
              requires_human_decision: false,
              task_status: "completed",
              blockers: [],
              repairable_blockers: [],
            },
      }),
      autoStartNextOnTaskCompletedFn: async () => ({ auto_started: false, details: [] }),
      removeTaskWorktreeFn: async () => null,
      loadRestartMarkerFn: async () => null,
      releaseRepoLockFn: async () => {},
    },
  };
}

test("completed unified decision persists idempotent terminal progression commands", async () => {
  const { store, args } = makeArgs();

  await finalizeCodexTaskRun(args);
  await finalizeCodexTaskRun(args);

  const commands = Object.values(store.state.progression_commands);
  assert.deepEqual(commands.map((command) => command.action).sort(), [
    "advance_queue",
    "complete_task",
    "propagate_goal",
  ]);
  assert.ok(commands.every((command) => command.task_id === args.task.id));
  assert.ok(commands.every((command) => command.decision_revision === args.doneAt));
  const completeTask = commands.find((command) => command.action === "complete_task");
  assert.equal(completeTask.payload.unified_decision.decision_revision, args.doneAt);
  assert.equal(completeTask.payload.unified_decision.evidence_revision, args.doneAt);
  assert.equal(completeTask.payload.unified_decision.normalized_at, args.doneAt);
});

test("task final state and progression commands persist in one mutation", async () => {
  const { store, args } = makeArgs();

  await finalizeCodexTaskRun(args);

  assert.equal(store.state.tasks[0].status, "completed");
  const terminalSnapshot = store.mutationSnapshots.find((snapshot) => snapshot.tasks[0].status === "completed");
  assert.ok(terminalSnapshot);
  assert.equal(terminalSnapshot.tasks[0].decision_revision, args.doneAt);
  assert.deepEqual(Object.values(terminalSnapshot.progression_commands).map((command) => command.action).sort(), [
    "advance_queue",
    "complete_task",
    "propagate_goal",
  ]);
});

test("waiting integration decision does not persist terminal progression commands", async () => {
  const { store, args } = makeArgs({ taskStatus: "waiting_for_integration", integrationRequired: true });
  args.resolvedRepo = null;

  await finalizeCodexTaskRun(args);

  const terminalActions = new Set(["complete_task", "propagate_goal", "advance_queue"]);
  const commands = Object.values(store.state.progression_commands);
  assert.equal(commands.some((command) => terminalActions.has(command.action)), false);
});
