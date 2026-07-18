/**
 * supervisor-command-executor.test.mjs — Tests for Command Executor
 *
 * @module test/supervisor-review/supervisor-command-executor
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorCommandExecutor } from "../../src/supervisor-review/supervisor-command-executor.mjs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    runStore: {
      readRun: async () => ({
        id: "run_1",
        version: 3,
        state: "running",
        supervisor_plan_id: "plan_1",
      }),
    },
    revisionReader: {
      current: async () => ({ id: "rev_001" }),
    },
    actionGuard: {
      validateCommand: () => ({ valid: true, errors: [] }),
    },
    leaseStore: {
      read: async () => ({ owner: "codex_active", epoch: 0 }),
    },
    planStore: {
      readPlan: async () => ({ autonomy_budget: { max_corrections: 5 } }),
    },
    commandStore: {
      markApplying: async (id) => ({ id, status: "applying" }),
      markApplied: async (id, result) => ({ id, status: "applied", result }),
      markRetryableFailure: async (id, failure) => ({ id, status: "retryable_failed", failure }),
      markTerminalFailure: async (id, failure) => ({ id, status: "terminal_failed", failure }),
    },
    tuiCorrectionService: {
      apply: async (cmd, run) => ({ session_id: "sess_1", delta_id: "delta_1" }),
    },
    quiescenceService: {
      pause: async (cmd, run) => ({ paused: true }),
    },
    takeoverService: {
      apply: async (cmd, run) => ({ taken_over: true }),
    },
    terminalService: {
      evaluate: async (cmd, run) => ({ terminal: true }),
    },
    failureClassifier: {
      classify: (err) => ({
        retryable: err.message?.includes("timeout") || err.message?.includes("retryable"),
        message: err.message,
      }),
    },
    ...overrides,
  };
}

const baseCommand = {
  id: "cmd_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
  action: "send_correction",
  payload: { objective: "Fix X", required_changes: ["Y"] },
};

// ---------------------------------------------------------------------------
// Route: send_correction
// ---------------------------------------------------------------------------

test("execute send_correction routes to tuiCorrectionService", async () => {
  let called = false;
  const deps = createMockDeps({
    tuiCorrectionService: {
      apply: async (cmd, run) => {
        called = true;
        assert.equal(cmd.id, "cmd_1");
        return { session_id: "sess_1" };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  const result = await executor.execute(baseCommand);
  assert.ok(called);
  assert.ok(result.session_id, "sess_1");
});

// ---------------------------------------------------------------------------
// Route: wait
// ---------------------------------------------------------------------------

test("execute wait returns no_op", async () => {
  const executor = createSupervisorCommandExecutor(createMockDeps());
  const result = await executor.execute({ ...baseCommand, action: "wait" });
  assert.deepEqual(result, { no_op: true });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("execute marks retryable failure on timeout", async () => {
  let markedFailure = null;
  const deps = createMockDeps({
    tuiCorrectionService: {
      apply: async () => { throw new Error("timeout: connection lost"); },
    },
    commandStore: {
      markApplying: async (id) => ({ id, status: "applying" }),
      markRetryableFailure: async (id, failure) => {
        markedFailure = { id, failure };
        return { id, status: "retryable_failed" };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  await assert.rejects(
    () => executor.execute(baseCommand),
    /timeout/
  );
  assert.ok(markedFailure);
  assert.equal(markedFailure.id, "cmd_1");
});

test("execute marks terminal failure on non-retryable error", async () => {
  let markedFailure = null;
  const deps = createMockDeps({
    tuiCorrectionService: {
      apply: async () => { throw new Error("fatal: invalid state"); },
    },
    commandStore: {
      markApplying: async (id) => ({ id, status: "applying" }),
      markTerminalFailure: async (id, failure) => {
        markedFailure = { id, failure };
        return { id, status: "terminal_failed" };
      },
    },
    failureClassifier: {
      classify: () => ({ retryable: false, message: "fatal" }),
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  await assert.rejects(
    () => executor.execute(baseCommand),
    /fatal/
  );
  assert.ok(markedFailure);
  assert.equal(markedFailure.id, "cmd_1");
});

// ---------------------------------------------------------------------------
// Action guard validates
// ---------------------------------------------------------------------------

test("execute validates command through action guard", async () => {
  let guarded = false;
  const deps = createMockDeps({
    actionGuard: {
      validateCommand: (args) => {
        guarded = true;
        assert.equal(args.command.id, "cmd_1");
        return { valid: true, errors: [] };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  await executor.execute(baseCommand);
  assert.ok(guarded);
});

test("execute rejects command when action guard fails", async () => {
  const deps = createMockDeps({
    actionGuard: {
      validateCommand: () => ({ valid: false, errors: ["Stale revision"] }),
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  await assert.rejects(
    () => executor.execute(baseCommand),
    /Action guard/
  );
});

// ---------------------------------------------------------------------------
// Mark applying before route
// ---------------------------------------------------------------------------

test("execute marks command applying before routing", async () => {
  const order = [];
  const deps = createMockDeps({
    commandStore: {
      markApplying: async (id) => {
        order.push("markApplying");
        return { id, status: "applying" };
      },
      markApplied: async (id, result) => {
        order.push("markApplied");
        return { id, status: "applied" };
      },
    },
    tuiCorrectionService: {
      apply: async () => {
        order.push("route");
        return { session_id: "sess_1" };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  await executor.execute(baseCommand);
  assert.deepEqual(order, ["markApplying", "route", "markApplied"]);
});

test("start_repair_cycle fails closed when goal relay service is missing", async () => {
  const command = {
    ...baseCommand,
    action: "start_repair_cycle",
    payload: { remaining_work_summary: "Finish production wiring" },
  };
  const executor = createSupervisorCommandExecutor(createMockDeps({ goalRelayService: undefined }));
  await assert.rejects(() => executor.execute(command), /goalRelayService not configured/);
});

// ---------------------------------------------------------------------------
// Route: resume_and_send_correction
// ---------------------------------------------------------------------------

test("execute resume_and_send_correction calls nativeResumeService then tuiCorrectionService", async () => {
  let resumeCalled = false;
  let correctionCalled = false;
  const deps = createMockDeps({
    nativeResumeService: {
      resume: async ({ run, nativeSessionId, worktreePath }) => {
        resumeCalled = true;
        assert.equal(run.id, "run_1");
        assert.equal(nativeSessionId, "ns_001");
        assert.equal(worktreePath, "/tmp/worktree");
        return { control_session_id: "ctrl_sess_resumed" };
      },
    },
    tuiCorrectionService: {
      apply: async (cmd, run) => {
        correctionCalled = true;
        // Verify the preconditions and run were updated with the resumed session
        assert.equal(cmd.preconditions.expected_session_id, "ctrl_sess_resumed");
        assert.equal(run.active_session_id, "ctrl_sess_resumed");
        return { session_id: "ctrl_sess_resumed", delta_id: "delta_resumed" };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  const command = {
    ...baseCommand,
    action: "resume_and_send_correction",
    preconditions: {
      expected_native_session_id: "ns_001",
      expected_worktree_path: "/tmp/worktree",
    },
  };
  const result = await executor.execute(command);
  assert.ok(resumeCalled, "nativeResumeService.resume should be called");
  assert.ok(correctionCalled, "tuiCorrectionService.apply should be called");
  assert.equal(result.delta_id, "delta_resumed");
});

test("execute resume_and_send_correction fails closed when nativeResumeService is missing", async () => {
  const deps = createMockDeps({ nativeResumeService: undefined });
  const executor = createSupervisorCommandExecutor(deps);
  const command = {
    ...baseCommand,
    action: "resume_and_send_correction",
  };
  await assert.rejects(
    () => executor.execute(command),
    /nativeResumeService not configured/
  );
});

// ---------------------------------------------------------------------------
// Route: handoff_to_codex
// ---------------------------------------------------------------------------

test("execute handoff_to_codex calls handoffService.handoff", async () => {
  let handoffCalled = false;
  const deps = createMockDeps({
    handoffService: {
      handoff: async ({ runId, receipt }) => {
        handoffCalled = true;
        assert.equal(runId, "run_1");
        assert.deepEqual(receipt, { status: "handoff_ready" });
        return { handed_off: true, new_owner: "codex" };
      },
    },
  });
  const executor = createSupervisorCommandExecutor(deps);
  const command = {
    ...baseCommand,
    action: "handoff_to_codex",
    payload: { status: "handoff_ready" },
  };
  const result = await executor.execute(command);
  assert.ok(handoffCalled, "handoffService.handoff should be called");
  assert.equal(result.handed_off, true);
});

test("execute handoff_to_codex fails closed when handoffService is missing", async () => {
  const deps = createMockDeps({ handoffService: undefined });
  const executor = createSupervisorCommandExecutor(deps);
  const command = {
    ...baseCommand,
    action: "handoff_to_codex",
  };
  await assert.rejects(
    () => executor.execute(command),
    /handoffService not configured/
  );
});
