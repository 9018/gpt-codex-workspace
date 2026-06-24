/**
 * acceptance-agent.test.mjs
 * Tests for acceptance-agent.mjs — evidence-based acceptance verification.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hasCodeOrConfigOrRuntimeChanges } from "../src/acceptance-agent.mjs";

// ===========================================================================
// Tests for hasCodeOrConfigOrRuntimeChanges
// ===========================================================================

test("hasCodeOrConfigOrRuntimeChanges: code change files returns true", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "code_change",
      evidence: { changed_files: ["src/server.mjs", "src/worker.mjs"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: noop profile returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "noop",
      evidence: { changed_files: [] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: docs_only profile returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "docs_only",
      evidence: { changed_files: ["docs/readme.md"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: no changed_files returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: [] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: only md files returns false for code_change profile", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "code_change",
      evidence: { changed_files: ["README.md", "CHANGELOG.md"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: config-only files returns false for default profile", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["config.json", "deploy.yaml"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: mixed code+docs returns true", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["src/app.mjs", "docs/guide.md"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: falls back to task.result.changed_files", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    task: {
      result: { changed_files: ["src/app.mjs"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: no acceptanceResult nor task returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({});
  assert.equal(result, false);
});

// ===========================================================================
// Test: exports are present
// ===========================================================================

test("acceptance-agent exports expected symbols", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  assert.equal(typeof mod.runAcceptanceAgent, "function");
  assert.equal(typeof mod.buildEvidence, "function");
  assert.equal(typeof mod.hasCodeOrConfigOrRuntimeChanges, "function");
  assert.ok(mod.ACCEPTANCE_PROFILES);
  assert.equal(mod.ACCEPTANCE_PROFILES.CODE_CHANGE, "code_change");
  assert.equal(mod.ACCEPTANCE_PROFILES.DOCS_ONLY, "docs_only");
  assert.equal(mod.ACCEPTANCE_PROFILES.NOOP, "noop");
});



// ===========================================================================
// Tests for runAcceptanceAgent
// ===========================================================================

test("runAcceptanceAgent: happy path with pre-built evidence returns passed", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t1" },
    result: {
      status: "completed",
      summary: "Test task",
      changed_files: ["src/test.mjs"],
      verification: { commands: ["node --check src/test.mjs"], passed: true },
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Test task",
      changed_files: ["src/test.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  assert.equal(result.passed, true);
  assert.equal(typeof result.status, "string");
  assert.ok(Array.isArray(result.findings));
  assert.equal(typeof result.evidence, "object");
  assert.equal(typeof result.reviewer_decision, "object");
});

test("runAcceptanceAgent: verification missing produces major finding", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t2" },
    result: {
      status: "completed",
      summary: "Test task without verification",
      changed_files: ["src/app.mjs"],
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Test task without verification",
      changed_files: ["src/app.mjs"],
      git_status: "clean",
      verification_log_exists: false,
      commit_exists: true,
    },
  });
  // Should find at least a major-level verification_missing finding
  const missingFindings = result.findings.filter(f => f.code === "verification_missing");
  assert.ok(missingFindings.length > 0, "Expected verification_missing finding");
  assert.ok(missingFindings.some(f => f.severity === "major"), "Expected major severity");
});

test("runAcceptanceAgent: dirty worktree produces finding", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const dirtyFiles = ["dirty_file.js", "another_dirty.py"];
  const result = await mod.runAcceptanceAgent({
    task: { id: "t3" },
    result: {
      status: "completed",
      summary: "Task with dirty worktree",
      changed_files: ["src/clean.mjs"],
      verification: { commands: ["true"], passed: true },
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with dirty worktree",
      changed_files: ["src/clean.mjs"],
      git_status: "dirty",
      git_status_dirty_files: dirtyFiles,
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  const dirtyFindings = result.findings.filter(f => f.code === "worktree_dirty");
  assert.ok(dirtyFindings.length > 0, "Expected worktree_dirty finding");
  // Should still pass since dirty worktree is major not blocker
  // (no_blocker_or_major_findings check may escalate if there are existing findings)
  assert.ok(Array.isArray(result.findings));
});

test("runAcceptanceAgent: changed_files mismatch produces finding", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t4" },
    result: {
      status: "completed",
      summary: "Task with file mismatch",
      changed_files: ["src/claimed.mjs", "src/missing.mjs"],
      verification: { commands: ["true"], passed: true },
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with file mismatch",
      changed_files: ["src/claimed.mjs"], // git has fewer files
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.ok(mismatchFindings.length > 0, "Expected changed_files_mismatch finding");
  assert.ok(mismatchFindings.some(f => f.severity === "major"), "Expected major severity");
});

test("runAcceptanceAgent: code_change profile with all pass", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t5" },
    result: {
      status: "completed",
      summary: "Full code change task",
      changed_files: ["src/app.mjs", "src/lib.mjs"],
      verification: { commands: ["npm test"], passed: true },
      tests: "npm test: passed 10/10",
      commit: "abc123",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Full code change task",
      changed_files: ["src/app.mjs", "src/lib.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.profile, "code_change");
});

test("runAcceptanceAgent: noop profile passes without verification", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t6", noop: true },
    result: {
      status: "completed",
      summary: "noop task with no changes",
      noop: true,
      noop_reason: "No changes needed",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "noop task with no changes",
      changed_files: [],
      git_status: "clean",
      verification_log_exists: false,
      commit_exists: true,
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.profile, "noop");
});

console.log("acceptance-agent tests loaded");
