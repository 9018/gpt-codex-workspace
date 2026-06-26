/**
 * acceptance-agent.test.mjs
 * Tests for acceptance-agent.mjs — evidence-based acceptance verification.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hasCodeOrConfigOrRuntimeChanges } from "../src/acceptance-agent.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  assert.equal(result, true, "config-only changes now require integration");
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

// ===========================================================================
// P0: Issue 2 — Config-only changes should enter integration (regression)
// ===========================================================================

test("hasCodeOrConfigOrRuntimeChanges: config-only changes return true for integration (Issue 2)", async () => {
  // Before the fix, this returned false. Config-only changes should require integration.
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["config.json", "deploy.yaml"] },
    },
  });
  assert.equal(result, true, "config-only changes must NOT skip integration");
});

test("hasCodeOrConfigOrRuntimeChanges: docs-only changes still skip integration (Issue 2)", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["docs/readme.md", "CHANGELOG.md"] },
    },
  });
  assert.equal(result, false, "docs-only changes should still skip integration");
});

// ===========================================================================
// P0: Issue 3 — commit_exists=false without baseSha causes commit_or_patch finding
// ===========================================================================

test("runAcceptanceAgent: commit_or_patch fails when commit_exists=false and no result.commit (Issue 3)", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_issue3", mode: "code_change" },
    result: {
      status: "completed",
      summary: "Task with no commit evidence",
      changed_files: ["src/app.mjs"],
      verification: { commands: ["true"], passed: true },
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with no commit evidence",
      changed_files: ["src/app.mjs"],
      git_changed_files: ["src/app.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: false,
    },
  });
  const commitFindings = result.findings.filter(f => f.code === "commit_or_patch_missing");
  assert.ok(commitFindings.length > 0, "Expected commit_or_patch_missing when commit_exists=false and no result.commit");
});

test("buildEvidence: commit_exists is false when baseSha is not provided (Issue 3 regression)", async () => {
  // This test verifies that buildEvidence no longer uses `git log -1` which
  // would return true for any repo with historical commits.
  const dir = await mkdtemp(join(tmpdir(), "be-issue3-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

  const mod = await import("../src/acceptance-agent.mjs");

  // Without baseSha, commit_exists must be false (repo has commits but not task-specific)
  const evidence = await mod.buildEvidence({ repoPath: repo });
  assert.equal(evidence.commit_exists, false, "without baseSha, commit_exists should be false");

  // With baseSha=HEAD (no new commits since HEAD), commit_exists should be false
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const evidence2 = await mod.buildEvidence({ repoPath: repo, baseSha: headSha });
  assert.equal(evidence2.commit_exists, false, "baseSha===HEAD means no new commits");

  rmSync(dir, { recursive: true, force: true });
});

test("buildEvidence: git_changed_files uses baseSha..HEAD when baseSha is provided (P0 regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "be-baseSha-changed-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  const firstSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // Second commit — this is the task scope
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "app.mjs"), "// code", "utf8");
  await writeFile(join(repo, "src", "lib.mjs"), "// lib", "utf8");
  execFileSync("git", ["add", "src/"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "task changes"], { cwd: repo, stdio: "ignore" });

  const mod = await import("../src/acceptance-agent.mjs");

  // Without baseSha, git_changed_files uses HEAD~1..HEAD (last commit only)
  const evidenceNoBase = await mod.buildEvidence({ repoPath: repo });
  assert.ok(evidenceNoBase.git_changed_files.length > 0, "should have git_changed_files without baseSha");

  // With baseSha=firstSha, git_changed_files should use firstSha..HEAD
  const evidenceWithBase = await mod.buildEvidence({ repoPath: repo, baseSha: firstSha });
  assert.ok(evidenceWithBase.git_changed_files.length >= 2, "baseSha..HEAD should find at least 2 files from both commits");
  assert.ok(evidenceWithBase.git_changed_files.some(f => f.includes("app.mjs")), "should include app.mjs from second commit");
  assert.ok(evidenceWithBase.git_changed_files.some(f => f.includes("lib.mjs")), "should include lib.mjs from second commit");
  // README.md is from the first commit, not in firstSha..HEAD diff range
  assert.equal(evidenceWithBase.git_changed_files.length, 2, "baseSha..HEAD should find exactly 2 files from second commit");
  assert.ok(evidenceWithBase.git_changed_files.some(f => f.includes("app.mjs")), "should include app.mjs from second commit");
  assert.ok(evidenceWithBase.git_changed_files.some(f => f.includes("lib.mjs")), "should include lib.mjs from second commit");

  // With baseSha=HEAD (no new commits), git_changed_files should be empty
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const evidenceNoChanges = await mod.buildEvidence({ repoPath: repo, baseSha: headSha });
  assert.equal(evidenceNoChanges.git_changed_files.length, 0, "baseSha===HEAD means no changed files");

  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// P0: Issue 4 — changed_files_match_git uses git_changed_files (not result_changed_files)
// ===========================================================================

test("runAcceptanceAgent: changed_files_match_git detects mismatch via git_changed_files (Issue 4)", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_issue4" },
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
      git_changed_files: ["src/claimed.mjs"],
      changed_files: ["src/claimed.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.ok(mismatchFindings.length > 0, "Expected changed_files_mismatch when result files not in git diff");
  assert.ok(mismatchFindings.some(f => f.severity === "major"), "Expected major severity");
});

// ===========================================================================
// P0: Issue 5 — Resolved findings should not block acceptance
// ===========================================================================

test("runAcceptanceAgent: resolved findings are not counted as blockers in no_blocker_or_major_findings", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_resolved" },
    result: {
      status: "completed",
      summary: "Task with resolved findings",
      changed_files: ["src/fixed.mjs"],
      verification: { commands: ["npm test"], passed: true },
      commit: "abc123",
      acceptance_findings: [
        { severity: "blocker", code: "summary_missing", message: "Summary missing", resolved: true, explanation: "Fixed in repair" },
        { severity: "major", code: "verification_missing", message: "Verification missing", resolved: true, explanation: "Added in repair" },
        { severity: "major", code: "changed_files_mismatch", message: "Files mismatch", resolved: true, explanation: "Resolved in repair" },
      ],
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with resolved findings",
      changed_files: ["src/fixed.mjs"],
      git_changed_files: ["src/fixed.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  // Should NOT generate existing_blocking_findings
  const blockingFindings = result.findings.filter(f => f.code === "existing_blocking_findings");
  assert.equal(blockingFindings.length, 0,
    "Should not produce existing_blocking_findings when all previous findings are resolved");
  assert.equal(result.passed, true,
    "Acceptance should pass when all previous findings are resolved and no new issues");
});

test("runAcceptanceAgent: unresolved findings still block acceptance", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_unresolved" },
    result: {
      status: "completed",
      summary: "Task with unresolved findings",
      changed_files: ["src/broken.mjs"],
      verification: { commands: ["npm test"], passed: true },
      commit: "abc123",
      acceptance_findings: [
        { severity: "blocker", code: "summary_missing", message: "Summary still missing", resolved: false },
        { severity: "major", code: "still_broken", message: "Still broken", resolved: false },
      ],
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with unresolved findings",
      changed_files: ["src/broken.mjs"],
      git_changed_files: ["src/broken.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  // SHOULD generate existing_blocking_findings
  const blockingFindings = result.findings.filter(f => f.code === "existing_blocking_findings");
  assert.ok(blockingFindings.length > 0,
    "Should produce existing_blocking_findings when unresolved findings remain");
  assert.ok(blockingFindings.some(f => f.severity === "blocker"),
    "existing_blocking_findings should be severity blocker");
  assert.equal(result.passed, false,
    "Acceptance should fail when unresolved blockers exist");
});

test("runAcceptanceAgent: mixed resolved and unresolved findings only count unresolved", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_mixed" },
    result: {
      status: "completed",
      summary: "Task with mixed findings",
      changed_files: ["src/mixed.mjs"],
      verification: { commands: ["npm test"], passed: true },
      commit: "abc123",
      acceptance_findings: [
        { severity: "blocker", code: "summary_missing", message: "Summary missing", resolved: true },
        { severity: "blocker", code: "real_blocker", message: "Real blocking issue", resolved: false },
        { severity: "major", code: "real_major", message: "Real major issue", resolved: false },
        { severity: "major", code: "verification_missing", message: "Verification missing", resolved: true },
      ],
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with mixed findings",
      changed_files: ["src/mixed.mjs"],
      git_changed_files: ["src/mixed.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  // Should produce existing_blocking_findings with count=2 (not 4)
  const blockingFindings = result.findings.filter(f => f.code === "existing_blocking_findings");
  assert.ok(blockingFindings.length > 0,
    "Should produce existing_blocking_findings when unresolved findings remain");
  assert.match(blockingFindings[0].message, /has 2 existing/,
    "Should count only unresolved findings, not resolved ones");
  assert.equal(result.passed, false,
    "Acceptance should fail when unresolved blockers exist");
});
