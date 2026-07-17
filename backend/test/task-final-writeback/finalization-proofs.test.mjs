import test from "node:test";
import assert from "node:assert/strict";

import {
  attachAlreadyIntegratedCommitEvidence,
  attachResolvedWorktreeEvidence,
  buildExecutionCwdProof,
  buildFallbackResultJson,
  buildWorktreeLifecycleProof,
  normalizeCompletedDeliveryState,
} from "../../src/task-finalization/finalization-proofs.mjs";

test("buildFallbackResultJson includes worktree and execution cwd proofs", () => {
  const result = buildFallbackResultJson({
    taskStatus: "completed",
    taskResult: {
      summary: "done",
      changed_files: [],
      verification: { passed: true },
      repo_resolution: {
        canonical_repo_path: "/repo/main",
        task_worktree_path: "/repo/.worktrees/task_1",
        worktree_lifecycle: {
          mode: "git_worktree",
          ok: true,
          git_worktree_created: true,
          cleanup_supported: true,
        },
      },
      execution_cwd: "/repo/.worktrees/task_1",
    },
  });

  assert.equal(result.noop, true);
  assert.equal(result.worktree_lifecycle_proof.mode, "git_worktree");
  assert.equal(result.worktree_lifecycle_proof.task_worktree_path, "/repo/.worktrees/task_1");
  assert.equal(result.execution_cwd_proof.used_task_worktree_path, true);
});

test("attachResolvedWorktreeEvidence preserves explicit task evidence and fills repo resolution", () => {
  const taskResult = {
    worktree_lifecycle: { mode: "git_worktree", ok: true, worktree_path: "/existing" },
    repo_resolution: { repo_id: "existing" },
  };

  const result = attachResolvedWorktreeEvidence(taskResult, {
    repo_id: "repo-1",
    canonical_repo_path: "/repo/main",
    task_worktree_path: "/repo/.worktrees/task_2",
    worktree_lifecycle: { mode: "git_worktree", cleanup_supported: true },
  });

  assert.equal(result.worktree_lifecycle.worktree_path, "/existing");
  assert.equal(result.worktree_lifecycle.cleanup_supported, true);
  assert.equal(result.repo_resolution.repo_id, "existing");
  assert.equal(result.repo_resolution.canonical_repo_path, "/repo/main");
  assert.equal(result.repo_resolution.task_worktree_path, "/repo/.worktrees/task_2");
});

test("proof builders return null without path evidence", () => {
  assert.equal(buildWorktreeLifecycleProof({}), null);
  assert.equal(buildExecutionCwdProof({}), null);
});

test("normalizeCompletedDeliveryState clears stale integration blockers only with converged evidence", () => {
  const normalized = normalizeCompletedDeliveryState({
    taskStatus: "completed",
    taskResult: {
      warnings: ["Worktree retained: old", "keep me"],
      commit: "abc",
      local_head: "abc",
      remote_head: "abc",
      running_commit: "abc",
      restart_state: "verified",
      integration: { status: "merged", merged: true },
      needs_integration: true,
      needs_restart_check: true,
      closure_path: "integrate",
      closure_summary: "Closure path: integrate\nRestart check: required",
    },
  });

  assert.deepEqual(normalized.warnings, ["keep me"]);
  assert.equal(normalized.needs_integration, false);
  assert.equal(normalized.needs_restart_check, false);
  assert.equal(normalized.delivery_state_normalized, true);
  assert.equal(normalized.closure_path, "complete");
  assert.match(normalized.closure_summary, /Closure path: complete/);
});

test("attachAlreadyIntegratedCommitEvidence records canonical integration proof", () => {
  const calls = [];
  const result = attachAlreadyIntegratedCommitEvidence({
    taskStatus: "completed",
    taskResult: { commit: "abc123" },
    candidatePaths: ["/repo/task", "/repo/main"],
    execFileSyncFn: (_cmd, args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (options.cwd === "/repo/task") throw new Error("stale worktree");
      if (args[0] === "rev-parse") return "def456\n";
      if (args[0] === "merge-base") return "";
      throw new Error("unexpected command");
    },
  });

  assert.equal(result.integration.status, "already_integrated");
  assert.equal(result.integration.merged, true);
  assert.equal(result.integration.commit, "abc123");
  assert.equal(calls.some((call) => call.cwd === "/repo/main" && call.args[0] === "merge-base"), true);
});
