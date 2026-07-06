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

// ===========================================================================
// P0-05: Execution semantic tests
// ===========================================================================

test("resolveBackendSemantic returns 'real' for codex_exec and local_command", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  assert.equal(resolveBackendSemantic("codex_exec"), AGENT_BACKEND_SEMANTIC.REAL);
  assert.equal(resolveBackendSemantic("local_command"), AGENT_BACKEND_SEMANTIC.REAL);
});

test("resolveBackendSemantic returns test_noop for null backend with test_only reason", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");  const { NULL_REASON } = await import("../src/agent-execution-backends.mjs");

  assert.equal(resolveBackendSemantic("null", { nullReason: NULL_REASON.TEST_ONLY }), AGENT_BACKEND_SEMANTIC.TEST_NOOP);
});

test("resolveBackendSemantic returns configured for explicit configured_null reason", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");
  const { NULL_REASON } = await import("../src/agent-execution-backends.mjs");

  assert.equal(resolveBackendSemantic("null", { nullReason: NULL_REASON.CONFIGURED }), AGENT_BACKEND_SEMANTIC.CONFIGURED);
});

test("resolveBackendSemantic returns auto_artifact for null backend with auto_artifact reason", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");
  const { NULL_REASON } = await import("../src/agent-execution-backends.mjs");

  assert.equal(resolveBackendSemantic("null", { nullReason: NULL_REASON.AUTO_ARTIFACT }), AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
});

test("resolveBackendSemantic infers auto_artifact from integrator/finalizer defaults", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC, ROLE_BACKEND_DEFAULTS } = await import("../src/agent-execution-backends.mjs");

  const integratorSemantic = resolveBackendSemantic(ROLE_BACKEND_DEFAULTS.integrator.backend, { role: "integrator" });
  assert.equal(integratorSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);

  const finalizerSemantic = resolveBackendSemantic(ROLE_BACKEND_DEFAULTS.finalizer.backend, { role: "finalizer" });
  assert.equal(finalizerSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
});

test("normalizeBackendResult includes execution_semantic and evidence_source for codex_exec", async () => {
  const { normalizeBackendResult } = await import("../src/agent-execution-backends.mjs");
  const result = normalizeBackendResult({
    backendId: "codex_exec",
    role: "builder",
    output: { stdout: "done", returncode: 0 },
  });

  assert.equal(result.execution_semantic, "real");
  assert.equal(result.evidence_source, "codex_exec (real agent execution)");
  assert.equal(result.null_backend, false);
  assert.equal(result.null_reason, null);
});

test("normalizeBackendResult includes execution_semantic and evidence_source for local_command", async () => {
  const { normalizeBackendResult } = await import("../src/agent-execution-backends.mjs");
  const result = normalizeBackendResult({
    backendId: "local_command",
    role: "verifier",
    output: { stdout: "verified", returncode: 0 },
  });

  assert.equal(result.execution_semantic, "real");
  assert.equal(result.evidence_source, "local_command (deterministic shell command)");
  assert.equal(result.null_backend, false);
});

test("normalizeBackendResult includes null_backend=true for null backend", async () => {
  const { normalizeBackendResult } = await import("../src/agent-execution-backends.mjs");
  const result = normalizeBackendResult({
    backendId: "null",
    role: "finalizer",
    output: {},
  });

  assert.equal(result.backend, "null");
  assert.equal(result.null_backend, true);
  assert.equal(result.null_reason, "auto_artifact");
  assert.equal(result.execution_semantic, "auto_artifact");
  assert.ok(result.evidence_source.includes("null"));
  assert.ok(result.evidence_source.includes("auto_artifact"));
});

test("isNullBackendResult detects null backend results", async () => {
  const { isNullBackendResult, normalizeBackendResult } = await import("../src/agent-execution-backends.mjs");

  const nullResult = normalizeBackendResult({ backendId: "null", role: "tester", output: {} });
  assert.equal(isNullBackendResult(nullResult), true);

  const realResult = normalizeBackendResult({ backendId: "codex_exec", role: "builder", output: { stdout: "ok", returncode: 0 } });
  assert.equal(isNullBackendResult(realResult), false);
});

test("isRealBackendResult correctly classifies execution backends", async () => {
  const { isRealBackendResult, normalizeBackendResult } = await import("../src/agent-execution-backends.mjs");

  const codexExecResult = normalizeBackendResult({ backendId: "codex_exec", role: "builder", output: { stdout: "ok", returncode: 0 } });
  assert.equal(isRealBackendResult(codexExecResult), true);

  const localCmdResult = normalizeBackendResult({ backendId: "local_command", role: "verifier", output: { stdout: "ok", returncode: 0 } });
  assert.equal(isRealBackendResult(localCmdResult), true);

  const nullResult = normalizeBackendResult({ backendId: "null", role: "finalizer", output: {} });
  assert.equal(isRealBackendResult(nullResult), false);
});

test("NullBackend.run with explicit test_only nullReason marks as test_noop", async () => {
  const { createExecutionBackend, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");
  const { NULL_REASON } = await import("../src/agent-execution-backends.mjs");

  const backend = createExecutionBackend("null");
  const result = await backend.run({
    config: {},
    task: { id: "task_test_noop" },
    role: "tester",
    nullReason: NULL_REASON.TEST_ONLY,
  });

  assert.equal(result.parsedResult.backend, "null");
  assert.equal(result.parsedResult.execution_semantic, AGENT_BACKEND_SEMANTIC.TEST_NOOP);
  assert.equal(result.parsedResult.null_reason, NULL_REASON.TEST_ONLY);
  assert.equal(result.parsedResult.noop, true);
  assert.equal(result.parsedResult.no_mutation, true);
  assert.ok(result.parsedResult.noop_reason.includes("test only"));
});

test("NullBackend.run with integrator role defaults to auto_artifact semantic", async () => {
  const { createExecutionBackend, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  const backend = createExecutionBackend("null");
  const result = await backend.run({
    config: {},
    task: { id: "task_auto_integrator" },
    role: "integrator",
  });

  assert.equal(result.parsedResult.backend, "null");
  assert.equal(result.parsedResult.execution_semantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
  assert.equal(result.parsedResult.null_reason, "auto_artifact");
});

test("NullBackend.run with finalizer role defaults to auto_artifact semantic", async () => {
  const { createExecutionBackend, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  const backend = createExecutionBackend("null");
  const result = await backend.run({
    config: {},
    task: { id: "task_auto_finalizer" },
    role: "finalizer",
  });

  assert.equal(result.parsedResult.backend, "null");
  assert.equal(result.parsedResult.execution_semantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
  assert.equal(result.parsedResult.null_reason, "auto_artifact");
});

test("resolveAgentBackendId uses ROLE_BACKEND_DEFAULTS for verifier when no config", async () => {
  const { resolveAgentBackendId, AGENT_BACKEND_IDS } = await import("../src/agent-execution-backends.mjs");

  // With no config, verifier should resolve to local_command from ROLE_BACKEND_DEFAULTS
  const verifierBackend = resolveAgentBackendId({ config: {}, role: "verifier", task: {} });
  assert.equal(verifierBackend, AGENT_BACKEND_IDS.LOCAL_COMMAND);

  // reviewer should also resolve to local_command
  const reviewerBackend = resolveAgentBackendId({ config: {}, role: "reviewer", task: {} });
  assert.equal(reviewerBackend, AGENT_BACKEND_IDS.LOCAL_COMMAND);

  // integrator should resolve to null
  const integratorBackend = resolveAgentBackendId({ config: {}, role: "integrator", task: {} });
  assert.equal(integratorBackend, AGENT_BACKEND_IDS.NULL);

  // finalizer should resolve to null
  const finalizerBackend = resolveAgentBackendId({ config: {}, role: "finalizer", task: {} });
  assert.equal(finalizerBackend, AGENT_BACKEND_IDS.NULL);
});

test("ROLE_BACKEND_DEFAULTS reflects product defaults for all pipeline roles", async () => {
  const { ROLE_BACKEND_DEFAULTS, AGENT_BACKEND_IDS, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  assert.equal(ROLE_BACKEND_DEFAULTS.verifier.backend, AGENT_BACKEND_IDS.LOCAL_COMMAND);
  assert.equal(ROLE_BACKEND_DEFAULTS.verifier.semantic, AGENT_BACKEND_SEMANTIC.REAL);
  assert.equal(ROLE_BACKEND_DEFAULTS.reviewer.backend, AGENT_BACKEND_IDS.LOCAL_COMMAND);
  assert.equal(ROLE_BACKEND_DEFAULTS.reviewer.semantic, AGENT_BACKEND_SEMANTIC.REAL);
  assert.equal(ROLE_BACKEND_DEFAULTS.integrator.backend, AGENT_BACKEND_IDS.NULL);
  assert.equal(ROLE_BACKEND_DEFAULTS.integrator.semantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
  assert.equal(ROLE_BACKEND_DEFAULTS.finalizer.backend, AGENT_BACKEND_IDS.NULL);
  assert.equal(ROLE_BACKEND_DEFAULTS.finalizer.semantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);
  assert.equal(ROLE_BACKEND_DEFAULTS.builder.backend, AGENT_BACKEND_IDS.CODEX_EXEC);
  assert.equal(ROLE_BACKEND_DEFAULTS.repairer.backend, AGENT_BACKEND_IDS.CODEX_EXEC);
});
