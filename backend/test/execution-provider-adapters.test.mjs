import test from "node:test";
import assert from "node:assert/strict";

import { assertExecutionProviderContract } from "../src/execution/execution-provider-contract.mjs";
import { createCodexExecProvider } from "../src/execution/providers/codex-exec-provider.mjs";
import { createCodexTuiProvider } from "../src/execution/providers/codex-tui-provider.mjs";

test("codex exec adapter wraps executeCodexTaskRun and exposes provider-neutral evidence", async () => {
  let received = null;
  const provider = createCodexExecProvider({
    executeCodexTaskRunFn: async (args) => {
      received = args;
      return {
        cr: { returncode: 0, timed_out: false },
        parsedResult: {
          status: "completed",
          summary: "implemented",
          changed_files: ["backend/src/a.mjs"],
          tests: "node --test",
          commit: "abc123",
          remote_head: "abc123",
          verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
        },
        summary: "implemented",
        codexMeta: { native_session_id: "native-exec-1" },
      };
    },
  });

  assert.equal(assertExecutionProviderContract(provider), true);
  const attempt = { id: "attempt_1", task_id: "task_1" };
  const context = {
    config: { codexExecTimeout: 60 },
    workspaceRoot: "/workspace",
    executionCwd: "/workspace/.gptwork/worktrees/task_1",
    task: { id: "task_1" },
    goal: { id: "goal_1" },
    promptFile: "/workspace/prompt.md",
    resultJsonPath: "/workspace/.gptwork/goals/goal_1/result.json",
  };
  const handle = await provider.start(attempt, context);

  assert.equal(received.executionCwd, context.executionCwd);
  assert.equal(received.executionId, attempt.id);
  assert.equal((await provider.observe(handle)).state, "evidence_ready");
  const evidence = await provider.collect(handle);
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.commit, "abc123");
  assert.deepEqual(evidence.changed_files, ["backend/src/a.mjs"]);
});

test("codex exec adapter classifies no-content completion for automatic TUI failover", async () => {
  const provider = createCodexExecProvider({
    executeCodexTaskRunFn: async () => ({
      cr: { returncode: 0, stdout_bytes: 0, stderr_bytes: 0 },
      parsedResult: { _no_structured_summary: true },
      summary: "",
      codexMeta: {},
    }),
  });

  const handle = await provider.start({ id: "attempt_2", task_id: "task_2", attempt_number: 2 }, {
    config: {},
    workspaceRoot: "/workspace",
    task: { id: "task_2" },
    goal: { id: "goal_2" },
    promptFile: "/workspace/prompt.md",
  });
  const observed = await provider.observe(handle);
  assert.equal(observed.state, "failed");
  assert.equal(observed.failure.code, "no_content_output");
  assert.equal(observed.failure.retry_count, 1);
});

test("codex TUI adapter wraps session lifecycle and completion evidence", async () => {
  const calls = [];
  const provider = createCodexTuiProvider({
    startCodexTuiGoalSessionFn: async (args) => {
      calls.push(["start", args]);
      return { id: "session_1", cwd: args.cwd, status: "running", native_session_id: "native-tui-1" };
    },
    getCodexTuiSessionStatusFn: async (id) => ({ id, status: "completed" }),
    sendCodexTuiSessionInputFn: async (id, text) => calls.push(["send", id, text]),
    stopCodexTuiSessionFn: async (id, options) => calls.push(["stop", id, options]),
    collectCodexTuiCompletionFn: async () => ({
      result_json: {
        status: "completed",
        summary: "TUI implemented",
        changed_files: ["backend/src/tui.mjs"],
        tests: "node --test",
        commit: "def456",
        remote_head: "def456",
        verification: { passed: true, commands: [] },
      },
      ready_for_review: true,
      changed_files: ["backend/src/tui.mjs"],
      commit: "def456",
      tests: "node --test",
      findings: [],
    }),
  });

  assert.equal(assertExecutionProviderContract(provider), true);
  const handle = await provider.resume({ id: "attempt_3", task_id: "task_3" }, {
    execution_cwd: "/workspace/.gptwork/worktrees/task_3",
    native_session_id: "native-exec-3",
  }, {
    task: { id: "task_3" },
    goal: { id: "goal_3" },
    workspaceRoot: "/workspace",
  });

  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].cwd, "/workspace/.gptwork/worktrees/task_3");
  assert.equal(calls[0][1].checkpoint.native_session_id, "native-exec-3");
  assert.equal((await provider.observe(handle, { workspaceRoot: "/workspace" })).state, "evidence_ready");
  await provider.send(handle, "continue", { workspaceRoot: "/workspace" });
  const evidence = await provider.collect(handle, { workspaceRoot: "/workspace" });
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.commit, "def456");
  await provider.interrupt(handle, { workspaceRoot: "/workspace" });
  assert.deepEqual(calls.map((entry) => entry[0]), ["start", "send", "stop"]);
});

test("codex TUI adapter maps detached sessions to provider interruption", async () => {
  const provider = createCodexTuiProvider({
    getCodexTuiSessionStatusFn: async () => ({ status: "detached", detach_reason: "pty_process_not_alive" }),
  });
  const observed = await provider.observe({ session_id: "session_detached" }, { workspaceRoot: "/workspace" });
  assert.equal(observed.state, "failed");
  assert.equal(observed.failure.code, "pty_unavailable");
});

test("codex TUI adapter surfaces a persisted supervisor checkpoint", async () => {
  const provider = createCodexTuiProvider({
    getCodexTuiSessionStatusFn: async () => ({
      status: "waiting_for_supervisor",
      checkpoint: { version: 1, reason_code: "choice_without_options" },
      native_session_id: "native-supervisor",
    }),
  });

  const observed = await provider.observe({ session_id: "control-supervisor" }, {
    workspaceRoot: "/workspace",
  });

  assert.equal(observed.state, "waiting_for_supervisor");
  assert.equal(observed.checkpoint.reason_code, "choice_without_options");
  assert.equal(observed.native_session_id, "native-supervisor");
});

test("codex TUI adapter passes autonomous runtime policy to the session manager", async () => {
  let received = null;
  const provider = createCodexTuiProvider({
    startCodexTuiGoalSessionFn: async (args) => {
      received = args;
      return { id: "session_policy", cwd: args.cwd, status: "running" };
    },
  });

  await provider.start({ id: "attempt_policy", task_id: "task_policy" }, {
    workspaceRoot: "/workspace",
    executionCwd: "/workspace/.gptwork/worktrees/task_policy",
    task: { id: "task_policy" },
    goal: { id: "goal_policy" },
    config: {
      tuiAutopilotEnabled: true,
      tuiAutopilotMaxActions: 41,
      tuiAutopilotMaxRepairs: 5,
      tuiFrameStableMs: 750,
      tuiNoProgressSeconds: 33,
      tuiClassifierEnabled: false,
    },
  });

  assert.equal(received.tuiAutopilotEnabled, true);
  assert.equal(received.tuiAutopilotMaxActions, 41);
  assert.equal(received.tuiAutopilotMaxRepairs, 5);
  assert.equal(received.tuiFrameStableMs, 750);
  assert.equal(received.tuiNoProgressSeconds, 33);
  assert.equal(received.tuiClassifierEnabled, false);
});

test("codex TUI adapter resumes a live control session before spawning a native resume", async () => {
  const calls = [];
  const provider = createCodexTuiProvider({
    getCodexTuiSessionStatusFn: async (id) => ({ id, status: "running", native_session_id: "native-live" }),
    sendCodexTuiSessionInputFn: async (id, input) => calls.push([id, input]),
    startCodexTuiGoalSessionFn: async () => {
      throw new Error("must not spawn while the control session is live");
    },
  });

  const handle = await provider.resume({ id: "attempt_resume", task_id: "task_resume" }, {
    control_session_id: "control-live",
    native_session_id: "native-live",
    execution_cwd: "/workspace/repo",
  }, {
    workspaceRoot: "/workspace",
    task: { id: "task_resume" },
    goal: { id: "goal_resume" },
  });

  assert.equal(handle.session_id, "control-live");
  assert.equal(handle.native_session_id, "native-live");
  // Running session should NOT blindly send /resume
  assert.deepEqual(calls, []);
});

test("codex TUI adapter starts native resume when the control session cannot be attached", async () => {
  let received = null;
  const provider = createCodexTuiProvider({
    getCodexTuiSessionStatusFn: async () => { throw new Error("control session detached"); },
    startCodexTuiGoalSessionFn: async (args) => {
      received = args;
      return { id: "control-new", native_session_id: args.resumeNativeSessionId, cwd: args.cwd };
    },
  });

  const handle = await provider.resume({ id: "attempt_native", task_id: "task_native" }, {
    control_session_id: "control-old",
    native_session_id: "native-old",
    execution_cwd: "/workspace/repo",
  }, {
    workspaceRoot: "/workspace",
    task: { id: "task_native" },
    goal: { id: "goal_native" },
  });

  assert.equal(received.resumeNativeSessionId, "native-old");
  assert.equal(handle.session_id, "control-new");
});
