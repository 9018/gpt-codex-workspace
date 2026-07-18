/**
 * codex-tui-evidence-writeback.test.mjs — Tests for TUI evidence writeback.
 *
 * Tests:
 * - writebackTuiEvidence produces a valid unified decision when evidence is complete
 * - Missing evidence generates structured blockers (not silent)
 * - Evidence enters the same normalized format as codex_exec
 * - Integration evidence is properly set when commit is reachable
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writebackTuiEvidence, hasMinimumTuiEvidence } from "../src/codex-tui-evidence-writeback.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo(prefix = "codex-tui-writeback-repo-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

async function createSession(repo, overrides = {}) {
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  return store.createSession({
    sessionId: overrides.sessionId || "session_wb_1",
    taskId: overrides.taskId || "task_wb_1",
    goalId: overrides.goalId || "goal_wb_1",
    cwd: repo,
    repoLockId: "repo_lock_1",
    ...overrides.session,
  });
}

// ===========================================================================
// Tests
// ===========================================================================

test("writebackTuiEvidence produces valid result when evidence is complete", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create goal dir with result.md containing tests and commit
  await mkdir(join(repo, ".gptwork", "goals", "goal_wb_1"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await writeFile(
    join(repo, ".gptwork", "goals", "goal_wb_1", "result.md"),
    `Summary: TUI task complete\n\nTests: npm run check:syntax\nCommit: ${head}\n`
  );

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_wb_1",
  });

  // Should have a unified decision
  assert.ok(result.unified_decision, "Should produce unified_decision");
  assert.ok(result.finalizer_decision, "Should produce finalizer_decision");
  assert.ok(result.normalized, "Should produce normalized evidence");

  // Check unified decision structure
  const ud = result.unified_decision;
  assert.equal(ud.status, "completed", "Unified decision should be completed when terminal evidence satisfied");
  assert.ok(typeof ud.blocking_passed === "boolean", "blocking_passed should be boolean");
  assert.ok(typeof ud.safe_to_auto_advance === "boolean", "safe_to_auto_advance should be boolean");

  // Check taskResult has expected evidence
  const tr = result.taskResult;
  assert.ok(tr.changed_files !== undefined, "Should have changed_files");
  assert.equal(tr.commit, head, "Commit should match git HEAD");
  assert.equal(tr.tests, "npm run check:syntax", "Tests should be present");

  // Should have no blockers when evidence is complete
  assert.equal(result.blockers.length, 0, "Should have no blockers when evidence complete");
  assert.equal(result.evidence_complete, true, "evidence_complete should be true");
});

test("writebackTuiCompletion on dirty worktree generates proper completion snapshot", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create goal dir with result.md
  await mkdir(join(repo, ".gptwork", "goals", "goal_wb_1"), { recursive: true });
  await writeFile(
    join(repo, ".gptwork", "goals", "goal_wb_1", "result.md"),
    "Summary: TUI task\n\nTests: npm test\n"
  );

  // Make dirty changes
  await writeFile(join(repo, "changed.txt"), "dirty content\n");

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_wb_1",
  });

  // Should have structured findings, not silently fail
  assert.ok(result.unified_decision, "Should still produce unified_decision");
  assert.ok(result.completion, "Should have completion snapshot");
  assert.equal(result.completion.worktree_clean, false, "Should detect dirty worktree");
  assert.equal(result.completion.changed_files.length, 1, "Should detect changed file");
  assert.equal(result.completion.changed_files[0], "changed.txt");

  // Should have blockers for missing commit
  const commitBlockers = result.blockers.filter(b => b.code === "commit_missing" || b.code === "uncommitted_changes");
  assert.ok(commitBlockers.length > 0, "Should have structured blockers for dirty worktree without commit");

  // Check that the unified decision was still produced (not silent fail)
  assert.equal(typeof result.unified_decision.status, "string");
});

test("hasMinimumTuiEvidence returns true only when at least one evidence field is present", () => {
  assert.equal(hasMinimumTuiEvidence({ summary: "complete" }), true);
  assert.equal(hasMinimumTuiEvidence({ changed_files: ["file.txt"] }), true);
  assert.equal(hasMinimumTuiEvidence({ commit: "abc123" }), true);
  assert.equal(hasMinimumTuiEvidence({ tests: "npm test" }), true);
  assert.equal(hasMinimumTuiEvidence({}), false);
  assert.equal(hasMinimumTuiEvidence({ changed_files: [] }), false);
  assert.equal(hasMinimumTuiEvidence(null), false);
});

test("writebackTuiEvidence produces blockers for missing result.md", async () => {
  const repo = await makeGitRepo();
  await createSession(repo, { sessionId: "session_no_md" });

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_no_md",
  });

  // Should have blockers
  assert.ok(result.blockers.length > 0, "Should have blockers");
  const mdBlocker = result.blockers.find(b => b.code === "result_md_missing");
  assert.ok(mdBlocker, "Should have structured blocker for result_md_missing");
  assert.equal(mdBlocker.severity, "blocker");
  assert.equal(mdBlocker.source, "codex_tui_evidence_writeback");
});

test("writebackTuiEvidence sets integration not_required when no changed files", async () => {
  const repo = await makeGitRepo();
  await createSession(repo, { sessionId: "session_no_changes" });

  await mkdir(join(repo, ".gptwork", "goals", "goal_wb_1"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await writeFile(
    join(repo, ".gptwork", "goals", "goal_wb_1", "result.md"),
    `Summary: Read-only task\n\nTests: echo ok\nCommit: ${head}\n`
  );

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_no_changes",
  });

  // Integration should be not_required since no files changed
  assert.ok(result.taskResult.integration_not_required !== false, "Integration should be not required for no-changes task");
  assert.ok(result.taskResult.integration.satisfied, "Integration should be satisfied");
});

test("writebackTuiEvidence produces normalized evidence compatible with codex_exec format", async () => {
  const repo = await makeGitRepo();
  await createSession(repo, { sessionId: "session_fmt" });

  await mkdir(join(repo, ".gptwork", "goals", "goal_wb_1"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await writeFile(
    join(repo, ".gptwork", "goals", "goal_wb_1", "result.md"),
    `Summary: Format test\n\nTests: npm run check\nCommit: ${head}\n`
  );

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_fmt",
  });

  const normalized = result.normalized;

  // Check evidence normalizer output has expected fields
  assert.ok(normalized, "Should have normalized evidence");
  assert.ok(normalized.operation_kind === "diagnostic" || normalized.operation_kind === "code_change", "Should infer operation_kind, got: " + normalized.operation_kind);
  assert.equal(normalized.commit, head, "Should propagate commit");
  assert.ok(normalized.verification, "Should have verification");
  assert.ok(normalized.hasOwnProperty("needs_repair"), "Should have needs_repair field from normalizer");
  assert.ok(normalized.hasOwnProperty("needs_review"), "Should have needs_review field from normalizer");

  // Verify compatibility with codex_exec format
  // codex_exec produces: status, summary, changed_files, commit, tests, verification
  assert.equal(normalized.status, "completed");
  assert.ok(typeof normalized.summary === "string");
  assert.ok(Array.isArray(normalized.changed_files));
  assert.ok(normalized.verification.commands === undefined || Array.isArray(normalized.verification.commands));
});

test("writebackTuiEvidence enters unified_decision path with correct fields", async () => {
  const repo = await makeGitRepo();
  await createSession(repo, { sessionId: "session_ud" });

  await mkdir(join(repo, ".gptwork", "goals", "goal_wb_1"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await writeFile(
    join(repo, ".gptwork", "goals", "goal_wb_1", "result.md"),
    `Summary: UD test\n\nTests: npm test\nCommit: ${head}\n`
  );

  const result = await writebackTuiEvidence({
    workspaceRoot: repo,
    sessionId: "session_ud",
  });

  const ud = result.unified_decision;

  // Unified decision should have all required fields
  assert.ok(ud.status);
  assert.ok(ud.normalized_at);
  assert.ok(typeof ud.blocking_passed === "boolean");
  assert.ok(typeof ud.requires_review === "boolean");
  assert.ok(typeof ud.requires_repair === "boolean");
  assert.ok(typeof ud.requires_integration === "boolean");
  assert.ok(typeof ud.safe_to_auto_advance === "boolean");
  assert.ok(Array.isArray(ud.blockers));
  assert.ok(Array.isArray(ud.repairable_blockers));
  assert.ok(Array.isArray(ud.non_blocking_followups));

  // Integration effect should be present
  assert.ok(ud.integration_effect);
  assert.ok(typeof ud.integration_effect.required === "boolean");
  assert.ok(typeof ud.integration_effect.satisfied === "boolean");
  assert.ok(typeof ud.integration_effect.terminal === "boolean");

  // Goal and queue effects
  assert.ok(ud.goal_effect);
  assert.ok(ud.queue_effect);
});

test("persistTuiTerminalState converges task goal and queue to unified terminal status", async () => {
  const { persistTuiTerminalState } = await import("../src/codex-tui-evidence-writeback.mjs");
  const state = {
    tasks: [{ id: "task_terminal", goal_id: "goal_terminal", status: "waiting_for_review", result: {} }],
    goals: [{ id: "goal_terminal", task_id: "task_terminal", status: "running" }],
    goal_queue: [{ queue_id: "queue_terminal", task_id: "task_terminal", goal_id: "goal_terminal", status: "running" }],
  };
  const store = { mutate: async (fn) => fn(state) };
  const unifiedDecision = {
    status: "completed",
    reason: "all_evidence_satisfied",
    blocking_passed: true,
    requires_review: false,
    safe_to_auto_advance: true,
    goal_effect: { status: "completed" },
    queue_effect: { status: "completed" },
  };
  const taskResult = { status: "completed", summary: "done", unified_decision: unifiedDecision };

  const persisted = await persistTuiTerminalState({
    store,
    task: state.tasks[0],
    taskResult,
    unifiedDecision,
  });

  assert.equal(persisted.persisted, true);
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(state.tasks[0].result.unified_decision.status, "completed");
  assert.equal(state.goals[0].status, "completed");
  assert.equal(state.goal_queue[0].status, "completed");
  assert.match(state.tasks[0].logs.at(-1).message, /canonical terminal state/i);
});
