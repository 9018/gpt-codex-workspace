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

test("resolveBackendSemantic infers auto_artifact for integrator/finalizer when null is explicitly configured", async () => {
  const { resolveBackendSemantic, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  // When null backend is explicitly passed, auto-artifact roles should still get auto_artifact semantic
  const integratorSemantic = resolveBackendSemantic("null", { role: "integrator" });
  assert.equal(integratorSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);

  const finalizerSemantic = resolveBackendSemantic("null", { role: "finalizer" });
  assert.equal(finalizerSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);

  const contextCuratorSemantic = resolveBackendSemantic("null", { role: "context_curator" });
  assert.equal(contextCuratorSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);

  const plannerSemantic = resolveBackendSemantic("null", { role: "planner" });
  assert.equal(plannerSemantic, AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT);

  // Non-auto-artifact roles with null should get configured semantic
  const builderSemantic = resolveBackendSemantic("null", { role: "builder" });
  assert.equal(builderSemantic, AGENT_BACKEND_SEMANTIC.CONFIGURED);
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

test("resolveAgentBackendId uses ROLE_BACKEND_DEFAULTS for all roles when no config", async () => {
  const { resolveAgentBackendId, AGENT_BACKEND_IDS } = await import("../src/agent-execution-backends.mjs");

  // With no config, ALL roles should resolve to codex_exec from ROLE_BACKEND_DEFAULTS
  const verifierBackend = resolveAgentBackendId({ config: {}, role: "verifier", task: {} });
  assert.equal(verifierBackend, AGENT_BACKEND_IDS.CODEX_EXEC);

  const reviewerBackend = resolveAgentBackendId({ config: {}, role: "reviewer", task: {} });
  assert.equal(reviewerBackend, AGENT_BACKEND_IDS.CODEX_EXEC);

  const integratorBackend = resolveAgentBackendId({ config: {}, role: "integrator", task: {} });
  assert.equal(integratorBackend, AGENT_BACKEND_IDS.CODEX_EXEC);

  const finalizerBackend = resolveAgentBackendId({ config: {}, role: "finalizer", task: {} });
  assert.equal(finalizerBackend, AGENT_BACKEND_IDS.CODEX_EXEC);

  const builderBackend = resolveAgentBackendId({ config: {}, role: "builder", task: {} });
  assert.equal(builderBackend, AGENT_BACKEND_IDS.CODEX_EXEC);

  const repairerBackend = resolveAgentBackendId({ config: {}, role: "repairer", task: {} });
  assert.equal(repairerBackend, AGENT_BACKEND_IDS.CODEX_EXEC);
});

test("ROLE_BACKEND_DEFAULTS defaults all roles to codex_exec", async () => {
  const { ROLE_BACKEND_DEFAULTS, AGENT_BACKEND_IDS, AGENT_BACKEND_SEMANTIC } = await import("../src/agent-execution-backends.mjs");

  // Product default: all pipeline roles default to codex_exec
  for (const role of Object.keys(ROLE_BACKEND_DEFAULTS)) {
    assert.equal(ROLE_BACKEND_DEFAULTS[role].backend, AGENT_BACKEND_IDS.CODEX_EXEC,
      `${role} should default to codex_exec`);
    assert.equal(ROLE_BACKEND_DEFAULTS[role].semantic, AGENT_BACKEND_SEMANTIC.REAL,
      `${role} should have REAL semantic`);
  }
});
// ===========================================================================
// AFC-01: Pipeline backend default semantics alignment tests
// ===========================================================================

test("with product default agentBackend=codex_exec, all roles resolve to codex_exec", async () => {
  const { resolveAgentBackendId, AGENT_BACKEND_IDS } = await import("../src/agent-execution-backends.mjs");

  // Product default config: agentBackend set to codex_exec
  const config = { agentBackend: "codex_exec" };
  const roles = ["builder", "repairer", "verifier", "reviewer", "integrator", "finalizer", "context_curator", "planner"];

  for (const role of roles) {
    const backend = resolveAgentBackendId({ config, role, task: {} });
    assert.equal(backend, AGENT_BACKEND_IDS.CODEX_EXEC,
      `${role} should resolve to codex_exec with default product config`);
  }
});

test("individual role override takes effect before product default", async () => {
  const { resolveAgentBackendId, AGENT_BACKEND_IDS } = await import("../src/agent-execution-backends.mjs");

  // Product default with per-role override
  const config = {
    agentBackend: "codex_exec",
    agentRoleBackends: {
      reviewer: "local_command",
      integrator: "null",
    },
  };

  // Globally overridden role
  assert.equal(resolveAgentBackendId({ config, role: "reviewer", task: {} }), AGENT_BACKEND_IDS.LOCAL_COMMAND,
    "reviewer should use local_command from agentRoleBackends");

  // Role overridden to null
  assert.equal(resolveAgentBackendId({ config, role: "integrator", task: {} }), AGENT_BACKEND_IDS.NULL,
    "integrator should use null from agentRoleBackends");

  // Default role (not in agentRoleBackends)
  assert.equal(resolveAgentBackendId({ config, role: "builder", task: {} }), AGENT_BACKEND_IDS.CODEX_EXEC,
    "builder should use global default codex_exec");

  assert.equal(resolveAgentBackendId({ config, role: "verifier", task: {} }), AGENT_BACKEND_IDS.CODEX_EXEC,
    "verifier should use global default codex_exec (not overridden)");
});

test("task metadata overrides product default and role-specific config", async () => {
  const { resolveAgentBackendId, AGENT_BACKEND_IDS } = await import("../src/agent-execution-backends.mjs");

  const config = {
    agentBackend: "codex_exec",
    agentRoleBackends: { verifier: "local_command" },
  };
  const task = { metadata: { agent_backend: "null" } };

  // Task metadata should override both product default and role-specific config
  assert.equal(resolveAgentBackendId({ config, role: "verifier", task }), AGENT_BACKEND_IDS.NULL,
    "task metadata should override role config and product default");
});

// ===========================================================================
// AFC-P1: Agent Backend Source of Truth tests
// ===========================================================================

test("resolveBackendSource returns product_default when no config or task metadata", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const result = resolveBackendSource({ config: {}, role: "builder", task: {} });
  assert.equal(result.source, "product_default");
  assert.ok(result.label.includes("Product default"));
});

test("resolveBackendSource returns explicit_role_override when agentRoleBackends sets the role", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const result = resolveBackendSource({
    config: { agentRoleBackends: { verifier: "local_command" } },
    role: "verifier",
    task: {},
  });
  assert.equal(result.source, "explicit_role_override");
  assert.ok(result.label.includes("agentRoleBackends"));
});

test("resolveBackendSource returns explicit_global_override when agentBackend is set", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const result = resolveBackendSource({
    config: { agentBackend: "local_command" },
    role: "builder",
    task: {},
  });
  assert.equal(result.source, "explicit_global_override");
  assert.ok(result.label.includes("agentBackend"));
});

test("resolveBackendSource returns explicit_task_override when task metadata specifies backend", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const result = resolveBackendSource({
    config: {},
    role: "builder",
    task: { metadata: { agent_backend: "null" } },
  });
  assert.equal(result.source, "explicit_task_override");
  assert.ok(result.label.includes("task-level"));
});

test("formatBackendChainSummary returns single-line default when all roles use product defaults", async () => {
  const { formatBackendChainSummary } = await import("../src/agent-execution-backends.mjs");

  const result = formatBackendChainSummary({});
  assert.equal(result.text, "All pipeline roles → codex_exec (product default)");
  assert.ok(result.entries.every((e) => e.source === "product_default"));
  assert.ok(result.entries.every((e) => e.backend === "codex_exec"));
});

test("formatBackendChainSummary shows override entries when role config differs from default", async () => {
  const { formatBackendChainSummary } = await import("../src/agent-execution-backends.mjs");

  const result = formatBackendChainSummary({
    agentRoleBackends: { reviewer: "local_command" },
  });

  // Most roles should still show product_default
  const defaultEntries = result.entries.filter((e) => e.source === "product_default");
  assert.ok(defaultEntries.length > 0, "most roles should be product_default");

  // The overridden role should show as explicit_role_override
  const reviewerEntry = result.entries.find((e) => e.role === "reviewer");
  assert.equal(reviewerEntry.source, "explicit_role_override");
  assert.equal(reviewerEntry.backend, "local_command");
  assert.notEqual(result.text, "All pipeline roles → codex_exec (product default)");
});

test("getBackendConfigSummary returns correct default summary", async () => {
  const { getBackendConfigSummary } = await import("../src/agent-execution-backends.mjs");

  const defaultSummary = getBackendConfigSummary({});
  assert.equal(defaultSummary, "All pipeline roles → codex_exec (product default)");

  // With explicit global override
  const overrideSummary = getBackendConfigSummary({ agentBackend: "local_command" });
  assert.ok(overrideSummary.includes("local_command"));
  assert.ok(overrideSummary.includes("Explicit"));
});

test("resolveBackendSource per-role override does not affect other roles", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const config = {
    agentRoleBackends: { reviewer: "local_command" },
  };

  // Overridden role
  const reviewer = resolveBackendSource({ config, role: "reviewer" });
  assert.equal(reviewer.source, "explicit_role_override");

  // Non-overridden roles still product_default
  const builder = resolveBackendSource({ config, role: "builder" });
  assert.equal(builder.source, "product_default");

  const finalizer = resolveBackendSource({ config, role: "finalizer" });
  assert.equal(finalizer.source, "product_default");
});

test("resolveBackendSource with empty config returns product_default for all roles", async () => {
  const { resolveBackendSource } = await import("../src/agent-execution-backends.mjs");

  const roles = ["builder", "repairer", "verifier", "reviewer", "integrator", "finalizer", "context_curator", "planner"];
  for (const role of roles) {
    const result = resolveBackendSource({ config: {}, role });
    assert.equal(result.source, "product_default", `${role} should be product_default`);
  }
});
