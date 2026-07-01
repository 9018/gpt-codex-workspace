import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_BACKEND_IDS,
  createExecutionBackend,
  executeAgentBackendRun,
  normalizeBackendResult,
  resolveAgentBackendId,
} from "../src/agent-execution-backends.mjs";

test("resolveAgentBackendId defaults to codex_exec for legacy tasks", () => {
  assert.equal(resolveAgentBackendId({ config: {}, role: "builder", task: {} }), AGENT_BACKEND_IDS.CODEX_EXEC);
  assert.equal(resolveAgentBackendId({ config: { agentBackendDefault: "codex" }, role: "builder", task: {} }), AGENT_BACKEND_IDS.CODEX_EXEC);
});

test("resolveAgentBackendId lets role-specific config override the global backend", () => {
  const config = {
    agentBackend: "local_command",
    agentRoleBackends: { reviewer: "null" },
  };

  assert.equal(resolveAgentBackendId({ config, role: "builder", task: {} }), AGENT_BACKEND_IDS.LOCAL_COMMAND);
  assert.equal(resolveAgentBackendId({ config, role: "reviewer", task: {} }), AGENT_BACKEND_IDS.NULL);
});

test("resolveAgentBackendId accepts legacy role backend config names", () => {
  const config = {
    agentBackendDefault: "codex",
    agentBackendByRole: { verifier: "local_command" },
  };

  assert.equal(resolveAgentBackendId({ config, role: "builder", task: {} }), AGENT_BACKEND_IDS.CODEX_EXEC);
  assert.equal(resolveAgentBackendId({ config, role: "verifier", task: {} }), AGENT_BACKEND_IDS.LOCAL_COMMAND);
});

test("resolveAgentBackendId lets task metadata choose a backend", () => {
  const task = { metadata: { agent_backend: "local_command" } };

  assert.equal(resolveAgentBackendId({ config: {}, role: "builder", task }), AGENT_BACKEND_IDS.LOCAL_COMMAND);
});

test("normalizeBackendResult returns a uniform structured result for backend output", () => {
  const result = normalizeBackendResult({
    backendId: "local_command",
    task: { id: "task_backend" },
    goal: { id: "goal_backend" },
    role: "reviewer",
    output: {
      command: "node --version",
      cwd: "/repo",
      stdout: "ok",
      stderr: "",
      returncode: 0,
      timed_out: false,
    },
  });

  assert.equal(result.kind, "agent_backend_result");
  assert.equal(result.backend, "local_command");
  assert.equal(result.role, "reviewer");
  assert.equal(result.task_id, "task_backend");
  assert.equal(result.goal_id, "goal_backend");
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "ok");
  assert.deepEqual(result.command, { cmd: "node --version", cwd: "/repo", exit_code: 0, timed_out: false });
});

test("local_command backend runs configured role command and parses structured stdout", async () => {
  const calls = [];
  const backend = createExecutionBackend("local_command", {
    runLocalShellFn: async (cmd, cwd, timeout, maxBuffer, onPid, options) => {
      calls.push({ cmd, cwd, timeout, maxBuffer, options });
      onPid?.(2468);
      return { stdout: '{"status":"completed","summary":"local ok"}\n', stderr: "", returncode: 0 };
    },
  });

  const result = await backend.run({
    config: {
      agentLocalCommand: "npm test",
      agentRoleCommands: { reviewer: "node review.mjs" },
      agentCommandTimeout: 77,
      maxShellOutputBytes: 12345,
    },
    task: { id: "task_local" },
    goal: { id: "goal_local" },
    role: "reviewer",
    executionCwd: "/repo/worktree",
    workspaceRoot: "/workspace",
  });

  assert.equal(calls[0].cmd, "node review.mjs");
  assert.equal(calls[0].cwd, "/repo/worktree");
  assert.equal(calls[0].timeout, 77);
  assert.equal(calls[0].maxBuffer, 12345);
  assert.equal(result.cr.returncode, 0);
  assert.equal(result.parsedResult.status, "completed");
  assert.equal(result.parsedResult.summary, "local ok");
  assert.equal(result.parsedResult.backend, "local_command");
  assert.equal(result.summary, "local ok");
});

test("null backend returns a completed no-op result without invoking shell", async () => {
  const backend = createExecutionBackend("null", {
    runLocalShellFn: async () => { throw new Error("shell should not run"); },
  });

  const result = await backend.run({
    config: {},
    task: { id: "task_null" },
    goal: { id: "goal_null" },
    role: "tester",
    executionCwd: "/repo/worktree",
    workspaceRoot: "/workspace",
  });

  assert.equal(result.cr.returncode, 0);
  assert.equal(result.parsedResult.status, "completed");
  assert.equal(result.parsedResult.backend, "null");
  assert.equal(result.parsedResult.no_mutation, true);
  assert.equal(result.summary, "Null backend completed without executing external commands.");
});

test("executeAgentBackendRun selects backend by role and returns uniform result fields", async () => {
  const result = await executeAgentBackendRun({
    config: { agentRoleBackends: { verifier: "null" } },
    task: { id: "task_select" },
    goal: { id: "goal_select" },
    role: "verifier",
    executionCwd: "/repo/worktree",
    workspaceRoot: "/workspace",
  });

  assert.equal(result.backend, "null");
  assert.equal(result.parsedResult.backend, "null");
  assert.equal(result.parsedResult.role, "verifier");
  assert.equal(result.cr.returncode, 0);
});
