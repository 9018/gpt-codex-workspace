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

// ===========================================================================
// P0: Issue 1 — git_changed_files must use baseSha..HEAD (multi-commit task)
// ===========================================================================

test("buildEvidence: git_changed_files covers all commits in baseSha..HEAD (multi-commit task)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "be-multi-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

  // Initial commit
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // Commit 1: file A
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/a.mjs"), "a", "utf8");
  execFileSync("git", ["add", "src/a.mjs"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add a.mjs"], { cwd: repo, stdio: "ignore" });

  // Commit 2: file B
  await writeFile(join(repo, "src/b.mjs"), "b", "utf8");
  execFileSync("git", ["add", "src/b.mjs"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add b.mjs"], { cwd: repo, stdio: "ignore" });

  // Commit 3: file C
  await writeFile(join(repo, "src/c.mjs"), "c", "utf8");
  execFileSync("git", ["add", "src/c.mjs"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add c.mjs"], { cwd: repo, stdio: "ignore" });

  const mod = await import("../src/acceptance-agent.mjs");
  const evidence = await mod.buildEvidence({ repoPath: repo, baseSha });

  // Verify all three files are in git_changed_files
  assert.ok(evidence.git_changed_files.includes("src/a.mjs"), "Should include a.mjs from commit 1");
  assert.ok(evidence.git_changed_files.includes("src/b.mjs"), "Should include b.mjs from commit 2");
  assert.ok(evidence.git_changed_files.includes("src/c.mjs"), "Should include c.mjs from commit 3");

  // With baseSha, commit_exists should also be true
  assert.equal(evidence.commit_exists, true, "commit_exists should be true with 3 new commits after baseSha");

  // Verify old behavior (HEAD~1..HEAD) would only capture the last commit's files
  const oldStdout = execFileSync("git", ["diff", "--name-only", "HEAD~1..HEAD", "--relative"], {
    cwd: repo, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  const oldFiles = oldStdout.trim().split("\n").filter(Boolean);
  assert.equal(oldFiles.length, 1, "OLD behavior (HEAD~1) only shows last commit's files");
  assert.equal(oldFiles[0], "src/c.mjs", "OLD behavior only shows c.mjs");

  rmSync(dir, { recursive: true, force: true });
});

test("buildEvidence: git_changed_files falls back to HEAD~1..HEAD when no baseSha", async () => {
  const dir = await mkdtemp(join(tmpdir(), "be-fallback-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

  // Initial commit
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

  // A change: add a file in a subdirectory
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "new.mjs"), "content", "utf8");
  execFileSync("git", ["add", "src/new.mjs"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add new.mjs"], { cwd: repo, stdio: "ignore" });

  const mod = await import("../src/acceptance-agent.mjs");
  const evidence = await mod.buildEvidence({ repoPath: repo });

  // Without baseSha, should fallback to HEAD~1..HEAD
  assert.ok(evidence.git_changed_files.includes("src/new.mjs"), "Should find new.mjs via HEAD~1..HEAD fallback");

  // commit_exists should be false without baseSha
  assert.equal(evidence.commit_exists, false, "commit_exists false without baseSha");

  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// P0: Issue #177 — changed_files_match_git false positive fix
// When result.json doesn't claim any changed_files, don't flag mismatch
// even if git shows changes (repair/noop tasks with shared worktree)
// ===========================================================================

test("runAcceptanceAgent: changed_files_match_git skips when result has no changed_files but git shows changes (Issue 177)", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_issue177_noop_repair" },
    result: {
      status: "completed",
      summary: "Repair task with no changed_files field",
      verification: { commands: ["true"], passed: true },
      commit: "abc123",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Repair task with no changed_files field",
      git_changed_files: ["src/parent-task.mjs", "src/lib.mjs"],
      changed_files: ["src/parent-task.mjs", "src/lib.mjs"],
      result_changed_files: [],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch" || f.code === "changed_files_extra_in_git");
  assert.equal(mismatchFindings.length, 0,
    "Should NOT produce changed_files_mismatch when result doesn't claim changed_files");
});

test("runAcceptanceAgent: changed_files_match_git still flags when result explicitly claims files that disagree with git (Issue 177)", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_issue177_real_mismatch" },
    result: {
      status: "completed",
      summary: "Task with real changed_files mismatch",
      changed_files: ["src/claimed.mjs", "src/not-in-git.mjs"],
      verification: { commands: ["true"], passed: true },
      commit: "abc123",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with real changed_files mismatch",
      git_changed_files: ["src/claimed.mjs"],
      changed_files: ["src/claimed.mjs"],
      result_changed_files: ["src/claimed.mjs", "src/not-in-git.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.ok(mismatchFindings.length > 0,
    "Should STILL produce changed_files_mismatch when result explicitly claims files that disagree with git");
});

// ===========================================================================
// P0: Issue #177 — buildEvidence result_changed_files flows
// ===========================================================================

test("buildEvidence: result_changed_files captures result.json changed_files when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "be-issue177-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "new.mjs"), "content", "utf8");
  execFileSync("git", ["add", "src/new.mjs"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add new.mjs"], { cwd: repo, stdio: "ignore" });

  const goalDir = join(dir, "goal");
  await mkdir(goalDir, { recursive: true });
  const resultJsonPath = join(goalDir, "result.json");
  await writeFile(resultJsonPath, JSON.stringify({
    status: "completed",
    summary: "test",
    changed_files: ["src/new.mjs"],
    verification: { passed: true },
  }), "utf8");

  const mod = await import("../src/acceptance-agent.mjs");
  const evidence = await mod.buildEvidence({ repoPath: repo, resultJsonPath, baseSha });

  assert.ok(Array.isArray(evidence.result_changed_files), "result_changed_files should be an array");
  assert.equal(evidence.result_changed_files.length, 1, "should have 1 changed file from result.json");
  assert.equal(evidence.result_changed_files[0], "src/new.mjs", "should match the result.json changed_files");

  rmSync(dir, { recursive: true, force: true });
});

test("buildEvidence: result_changed_files is empty when result.json has no changed_files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "be-issue177-nocf-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });

  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const goalDir = join(dir, "goal");
  await mkdir(goalDir, { recursive: true });
  const resultJsonPath = join(goalDir, "result.json");
  await writeFile(resultJsonPath, JSON.stringify({
    status: "completed",
    summary: "test - no changed files reported",
    verification: { passed: true },
  }), "utf8");

  const mod = await import("../src/acceptance-agent.mjs");
  const evidence = await mod.buildEvidence({ repoPath: repo, resultJsonPath, baseSha });

  assert.ok(Array.isArray(evidence.result_changed_files), "result_changed_files should be an array");
  assert.equal(evidence.result_changed_files.length, 0, "should be empty when result.json has no changed_files");

  rmSync(dir, { recursive: true, force: true });
});


// ===========================================================================
// P0: Post-integration changed_files acceptance (clean-diff after merge)
// When a task is committed/merged, the worktree diff may be clean. The
// acceptance agent should verify against the commit diff, not reject.
// ===========================================================================

test("changed_files_match_git: passes when result has commit and all files match commit diff (post-merge clean diff)", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  // Simulate post-integration: git diff is clean but result has commit
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_postmerge_clean" },
    result: {
      status: "completed",
      summary: "Post-merge task with clean diff",
      changed_files: ["backend/src/subagent-policy.mjs", "backend/src/pipeline-orchestration.mjs",
                       "backend/src/task-general-processor.mjs", "backend/src/diagnostics-service.mjs",
                       "backend/test/pipeline-orchestration.test.mjs"],
      verification: { commands: ["true"], passed: true },
      tests: "none",
      commit: "87e5d99b37179ba46889dff42010532f95467036",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Post-merge task with clean diff",
      changed_files: [],       // git shows no uncommitted files
      git_changed_files: [],   // current worktree diff is clean
      result_changed_files: ["backend/src/subagent-policy.mjs", "backend/src/pipeline-orchestration.mjs",
                              "backend/src/task-general-processor.mjs", "backend/src/diagnostics-service.mjs",
                              "backend/test/pipeline-orchestration.test.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  // Should pass because all result files are in commit 87e5d99
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.equal(mismatchFindings.length, 0,
    "Should NOT produce changed_files_mismatch when result files match commit diff");
  assert.equal(result.passed, true,
    "Acceptance should pass for post-merge task with clean diff");
});

test("changed_files_match_git: still blocks when result claims files but no commit and no integration evidence", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_nocommit_mismatch" },
    result: {
      status: "completed",
      summary: "Task with changed_files but no commit evidence",
      changed_files: ["src/claimed.mjs", "src/not-in-diff.mjs"],
      verification: { commands: ["true"], passed: true },
      // No commit and no integration evidence
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with changed_files but no commit evidence",
      changed_files: [],
      git_changed_files: [],
      result_changed_files: ["src/claimed.mjs", "src/not-in-diff.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: false,
    },
  });
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.ok(mismatchFindings.length > 0,
    "Should STILL produce changed_files_mismatch when no commit/integration evidence");
});

test("getCommitChangedFiles: returns files for existing commit", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  // Use getCommitChangedFilesSet via the exports - it's not exported, so test via buildEvidence
  // Instead, test by calling runAcceptanceAgent with a known commit
  const result = await mod.runAcceptanceAgent({
    task: { id: "t_commitfiles_known" },
    result: {
      status: "completed",
      summary: "Task with known commit",
      changed_files: ["backend/src/subagent-policy.mjs"],
      verification: { commands: ["true"], passed: true },
      commit: "87e5d99b37179ba46889dff42010532f95467036",
    },
    repoPath: process.cwd(),
    evidence: {
      result_json_valid: true,
      result_summary: "Task with known commit",
      changed_files: [],
      git_changed_files: [],
      result_changed_files: ["backend/src/subagent-policy.mjs"],
      git_status: "clean",
      verification_log_exists: true,
      commit_exists: true,
    },
  });
  // Should pass because "backend/src/subagent-policy.mjs" is in commit 87e5d99
  const mismatchFindings = result.findings.filter(f => f.code === "changed_files_mismatch");
  assert.equal(mismatchFindings.length, 0,
    "Should pass for known commit with matched files");
  assert.equal(result.passed, true);
});
