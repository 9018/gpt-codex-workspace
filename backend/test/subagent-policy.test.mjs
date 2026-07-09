import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_BACKEND_BY_ROLE,
  DEFAULT_AGENT_PIPELINE,
  ALL_PIPELINE_ROLES,
  describeRoleBackend,
  resolveDefaultBackendForRole,
  normalizeAgentRole,
  isSupportedAgentRole,
} from "../src/subagent-policy.mjs";

// ===========================================================================
// P0-05: Role backend defaults
// ===========================================================================

test("subagent-policy: DEFAULT_AGENT_BACKEND_BY_ROLE uses canonical codex_exec defaults for all roles", () => {
  for (const role of ALL_PIPELINE_ROLES) {
    assert.equal(DEFAULT_AGENT_BACKEND_BY_ROLE[role], "codex_exec", `${role} should derive codex_exec from ROLE_BACKEND_DEFAULTS`);
  }
});

// ===========================================================================
// P0-05: resolveDefaultBackendForRole
// ===========================================================================

test("subagent-policy: resolveDefaultBackendForRole returns codex_exec for verifier", () => {
  assert.equal(resolveDefaultBackendForRole("verifier"), "codex_exec");
});

test("subagent-policy: resolveDefaultBackendForRole returns codex_exec for reviewer", () => {
  assert.equal(resolveDefaultBackendForRole("reviewer"), "codex_exec");
});

test("subagent-policy: resolveDefaultBackendForRole returns codex_exec for integrator", () => {
  assert.equal(resolveDefaultBackendForRole("integrator"), "codex_exec");
});

test("subagent-policy: resolveDefaultBackendForRole returns codex_exec for finalizer", () => {
  assert.equal(resolveDefaultBackendForRole("finalizer"), "codex_exec");
});

test("subagent-policy: resolveDefaultBackendForRole returns codex_exec for builder", () => {
  assert.equal(resolveDefaultBackendForRole("builder"), "codex_exec");
});

test("subagent-policy: resolveDefaultBackendForRole respects overrides", () => {
  assert.equal(resolveDefaultBackendForRole("verifier", { verifier: "null" }), "null");
  assert.equal(resolveDefaultBackendForRole("reviewer", { reviewer: "codex_exec" }), "codex_exec");
  assert.equal(resolveDefaultBackendForRole("builder", { builder: "local_command" }), "local_command");
});

// ===========================================================================
// P0-05: describeRoleBackend
// ===========================================================================

test("subagent-policy: describeRoleBackend returns real semantic for verifier with codex_exec default", () => {
  const info = describeRoleBackend("verifier", {});
  assert.equal(info.role, "verifier");
  assert.equal(info.backend, "codex_exec");
  assert.equal(info.semantic, "real");
  assert.equal(info.null_reason, null);
  assert.equal(info.evidence_source, "codex_exec (real agent execution)");
  assert.equal(info.overridden, false);
  assert.equal(info.config_source, "default");
});

test("subagent-policy: describeRoleBackend returns real semantic for reviewer with codex_exec default", () => {
  const info = describeRoleBackend("reviewer", {});
  assert.equal(info.role, "reviewer");
  assert.equal(info.backend, "codex_exec");
  assert.equal(info.semantic, "real");
  assert.equal(info.overridden, false);
});

test("subagent-policy: describeRoleBackend returns real semantic for integrator by canonical default", () => {
  const info = describeRoleBackend("integrator", {});
  assert.equal(info.role, "integrator");
  assert.equal(info.backend, "codex_exec");
  assert.equal(info.semantic, "real");
  assert.equal(info.null_reason, null);
  assert.equal(info.evidence_source, "codex_exec (real agent execution)");
});

test("subagent-policy: describeRoleBackend returns real semantic for finalizer by canonical default", () => {
  const info = describeRoleBackend("finalizer", {});
  assert.equal(info.role, "finalizer");
  assert.equal(info.backend, "codex_exec");
  assert.equal(info.semantic, "real");
  assert.equal(info.null_reason, null);
});

test("subagent-policy: describeRoleBackend returns real semantic for builder with codex_exec", () => {
  const info = describeRoleBackend("builder", {});
  assert.equal(info.role, "builder");
  assert.equal(info.backend, "codex_exec");
  assert.equal(info.semantic, "real");
  assert.equal(info.null_reason, null);
  assert.equal(info.evidence_source, "codex_exec (real agent execution)");
});

test("subagent-policy: describeRoleBackend respects config overrides for agentRoleBackends", () => {
  const config = { agentRoleBackends: { verifier: "null" } };
  const info = describeRoleBackend("verifier", config);
  assert.equal(info.backend, "null");
  assert.equal(info.semantic, "auto_artifact");
  assert.equal(info.overridden, true);
  assert.equal(info.config_source, "agentRoleBackends");
});

test("subagent-policy: describeRoleBackend respects global agentBackend config override", () => {
  const config = { agentBackend: "null" };
  const info = describeRoleBackend("verifier", config);
  assert.equal(info.backend, "null");
  assert.equal(info.overridden, true);
  assert.equal(info.config_source, "agentBackend");
});

test("subagent-policy: describeRoleBackend covers all pipeline roles", () => {
  const roles = ALL_PIPELINE_ROLES;
  for (const role of roles) {
    const info = describeRoleBackend(role, {});
    assert.equal(info.role, role, `Role ${role} should have matching description`);
    assert.ok(info.backend, `Role ${role} should have a backend`);
    assert.ok(info.semantic, `Role ${role} should have a semantic`);
    assert.ok(info.doc, `Role ${role} should have documentation`);
    assert.ok(["agentRoleBackends", "agentBackend", "default"].includes(info.config_source),
      `Role ${role} should have valid config_source`);
  }
});

test("subagent-policy: describeRoleBackend context_curator has real codex_exec semantic", () => {
  const info = describeRoleBackend("context_curator", {});
  assert.equal(info.semantic, "real");
  assert.equal(info.backend, "codex_exec");
});

test("subagent-policy: describeRoleBackend planner has real codex_exec semantic", () => {
  const info = describeRoleBackend("planner", {});
  assert.equal(info.semantic, "real");
  assert.equal(info.backend, "codex_exec");
});

// ===========================================================================
// P0-05: Raw default constants
// ===========================================================================

test("subagent-policy: DEFAULT_AGENT_PIPELINE and ALL_PIPELINE_ROLES include all key roles", () => {
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("verifier"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("reviewer"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("integrator"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("finalizer"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("builder"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("planner"));
  assert.ok(DEFAULT_AGENT_PIPELINE.includes("context_curator"));
  assert.ok(ALL_PIPELINE_ROLES.includes("repairer"));
});

test("subagent-policy: all roles are supported", () => {
  for (const role of ALL_PIPELINE_ROLES) {
    assert.ok(isSupportedAgentRole(role), `Role ${role} should be supported`);
  }
});

console.log("subagent-policy tests loaded");
