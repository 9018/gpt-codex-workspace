import test from "node:test";
import assert from "node:assert/strict";

import { buildExecutionCheckpoint } from "../src/execution/execution-checkpoint.mjs";
import { createExecutionOrchestrator } from "../src/execution/execution-orchestrator.mjs";

test("checkpoint preserves worktree, input, acceptance progress, error, and native session", () => {
  const checkpoint = buildExecutionCheckpoint({
    attempt: {
      task_id: "task_1",
      path_context: { execution_cwd: "/repo/wt" },
      input_snapshot: { digest: "input-1" },
    },
    repository: { head: "abc", dirty_paths: ["src/a.mjs"] },
    acceptance: { completed_items: ["tests"] },
    failure: { code: "provider_interruption" },
    nativeSessionId: "session-1",
    controlSessionId: "control-1",
  });
  assert.equal(checkpoint.repo_head, "abc");
  assert.deepEqual(checkpoint.dirty_paths, ["src/a.mjs"]);
  assert.equal(checkpoint.input_digest, "input-1");
  assert.equal(checkpoint.native_session_id, "session-1");
  assert.equal(checkpoint.control_session_id, "control-1");
});

test("orchestrator failover creates a new attempt with the same task, path and input", async () => {
  const attempts = [];
  let active = null;
  const attemptStore = {
    async claim(input) {
      const attempt = {
        id: `attempt_${attempts.length + 1}`,
        task_id: input.taskId,
        goal_id: input.goalId,
        provider: input.provider,
        state: "starting",
        attempt_number: attempts.length + 1,
        path_context: input.pathContext,
        input_snapshot: input.inputSnapshot,
        checkpoint: input.checkpoint || null,
      };
      attempts.push(attempt);
      active = attempt;
      return { claimed: true, attempt };
    },
    async transition(id, patch) {
      const attempt = attempts.find((entry) => entry.id === id);
      Object.assign(attempt, {
        state: patch.state,
        provider_handle: patch.providerHandle ?? attempt.provider_handle,
        failure: patch.failure ?? attempt.failure,
        evidence: patch.evidence ?? attempt.evidence,
      });
      if (["failed", "completed", "timed_out", "provider_unavailable"].includes(attempt.state)) active = null;
      return attempt;
    },
  };
  const providers = {
    codex_exec: {
      name: "codex_exec",
      async start() { return { id: "exec-handle" }; },
      async observe() { return { state: "failed", failure: { code: "no_content_output", retry_count: 1 } }; },
      async dispose() {},
    },
    codex_tui: {
      name: "codex_tui",
      async resume(attempt, checkpoint) { return { id: "tui-handle", checkpoint }; },
      async observe() { return { state: "evidence_ready" }; },
      async collect() { return { status: "completed", tests: [{ passed: true }] }; },
      async dispose() {},
    },
  };
  const registry = {
    get(name) { return providers[name]; },
    async availability() { return { codex_exec: true, codex_tui: true }; },
  };
  const orchestrator = createExecutionOrchestrator({
    attemptStore,
    providerRegistry: registry,
    repositorySnapshot: async () => ({ head: "abc", dirty_paths: ["src/a.mjs"] }),
  });

  const result = await orchestrator.run({
    taskId: "task_1",
    goalId: "goal_1",
    provider: "codex_exec",
    pathContext: { execution_cwd: "/repo/wt" },
    inputSnapshot: { digest: "input-1" },
  });

  assert.equal(result.attempt.provider, "codex_tui");
  assert.equal(result.attempt.state, "completed");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].path_context, attempts[0].path_context);
  assert.deepEqual(attempts[1].input_snapshot, attempts[0].input_snapshot);
  assert.equal(attempts[1].checkpoint.repo_head, "abc");
});

test("orchestrator keeps observing a running provider until evidence is ready", async () => {
  const attempts = [];
  let observations = 0;
  const attemptStore = {
    async claim(input) {
      const attempt = {
        id: "attempt_poll",
        task_id: input.taskId,
        provider: input.provider,
        state: "starting",
        attempt_number: 1,
        path_context: input.pathContext,
        input_snapshot: input.inputSnapshot,
      };
      attempts.push(attempt);
      return { claimed: true, attempt };
    },
    async transition(id, patch) {
      const attempt = attempts.find((entry) => entry.id === id);
      attempt.state = patch.state;
      if (patch.providerHandle !== undefined) attempt.provider_handle = patch.providerHandle;
      if (patch.evidence !== undefined) attempt.evidence = patch.evidence;
      return attempt;
    },
  };
  const provider = {
    name: "codex_tui",
    async start() { return { session_id: "session_poll" }; },
    async observe() {
      observations += 1;
      return { state: observations < 3 ? "running" : "evidence_ready" };
    },
    async collect() { return { status: "completed", summary: "done" }; },
    async dispose() {},
  };
  const orchestrator = createExecutionOrchestrator({
    attemptStore,
    providerRegistry: {
      get() { return provider; },
      async availability() { return { codex_exec: true, codex_tui: true }; },
    },
    sleepFn: async () => {},
    observeIntervalMs: 0,
  });

  const result = await orchestrator.run({
    taskId: "task_poll",
    provider: "codex_tui",
    pathContext: { execution_cwd: "/repo/wt" },
    inputSnapshot: { digest: "poll-input" },
  });

  assert.equal(observations, 3);
  assert.equal(result.attempt.state, "completed");
});

test("orchestrator persists provider start failure and automatically fails over", async () => {
  const attempts = [];
  const attemptStore = {
    async claim(input) {
      const attempt = {
        id: `attempt_start_${attempts.length + 1}`,
        task_id: input.taskId,
        provider: input.provider,
        state: "starting",
        attempt_number: attempts.length + 1,
        path_context: input.pathContext,
        input_snapshot: input.inputSnapshot,
        checkpoint: input.checkpoint || null,
      };
      attempts.push(attempt);
      return { claimed: true, attempt };
    },
    async transition(id, patch) {
      const attempt = attempts.find((entry) => entry.id === id);
      attempt.state = patch.state;
      if (patch.providerHandle !== undefined) attempt.provider_handle = patch.providerHandle;
      if (patch.failure !== undefined) attempt.failure = patch.failure;
      if (patch.evidence !== undefined) attempt.evidence = patch.evidence;
      if (patch.checkpoint !== undefined) attempt.checkpoint = patch.checkpoint;
      return attempt;
    },
  };
  const providers = {
    codex_tui: {
      name: "codex_tui",
      async start() { throw Object.assign(new Error("node-pty unavailable"), { code: "CODEX_TUI_UNAVAILABLE" }); },
      async dispose() {},
    },
    codex_exec: {
      name: "codex_exec",
      async resume() { return { id: "exec-resumed" }; },
      async observe() { return { state: "evidence_ready" }; },
      async collect() { return { status: "completed", summary: "exec recovered" }; },
      async dispose() {},
    },
  };
  const orchestrator = createExecutionOrchestrator({
    attemptStore,
    providerRegistry: {
      get(name) { return providers[name]; },
      async availability() { return { codex_exec: true, codex_tui: true }; },
    },
    repositorySnapshot: async () => ({ head: "head-1", dirty_paths: [] }),
  });

  const result = await orchestrator.run({
    taskId: "task_start_failure",
    provider: "codex_tui",
    pathContext: { execution_cwd: "/repo/wt" },
    inputSnapshot: { digest: "start-input" },
  });

  assert.equal(attempts[0].state, "provider_unavailable");
  assert.equal(attempts[0].failure.code, "pty_unavailable");
  assert.equal(result.attempt.provider, "codex_exec");
  assert.equal(result.attempt.state, "completed");
});
