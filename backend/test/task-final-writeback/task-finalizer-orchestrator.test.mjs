import test from "node:test";
import assert from "node:assert/strict";

import {
  runTaskCompletionVerification,
  runTaskFinalizerOrchestration,
} from "../../src/task-finalization/task-finalizer-orchestrator.mjs";

test("runTaskFinalizerOrchestration sequences integration finalization before delivery recovery", async () => {
  const result = await runTaskFinalizerOrchestration({
    taskStatus: "waiting_for_integration",
    taskResult: {
      summary: "missing result",
      delivery_result_recovery: {
        canonical_clean: true,
        commit_integrated: true,
        commit: "abc123",
        local_head: "abc123",
        remote_head: "abc123",
        changed_files: ["src/app.mjs"],
        verification: {
          passed: true,
          commands: [{ command: "npm test", exit_code: 0 }],
        },
      },
    },
    summary: "fallback summary",
    task: { id: "task_orchestrator", title: "Orchestrate finalizer" },
    goal: { id: "goal_orchestrator" },
    store: { state: { tasks: [] } },
    config: { defaultBranch: "main" },
    resolvedRepo: {
      repo_id: "github.com/acme/repo",
      canonical_repo_path: "/repo/main",
      task_worktree_path: "/repo/.worktrees/task_orchestrator",
      worktree_lifecycle: { branch_name: "gptwork/task/orchestrator" },
    },
    runIntegrationQueueFn: async () => ({ ok: true, status: "merged", merged: true }),
  });

  assert.equal(result.taskStatus, "completed");
  assert.equal(result.taskResult.kind, "codex_executed");
  assert.equal(result.taskResult.integration.status, "merged");
  assert.equal(result.taskResult.delivery_result_recovery.passed, true);
  assert.equal(result.taskResult.commit, "abc123");
});

test("runTaskCompletionVerification captures verifier errors and merges findings", async () => {
  const result = await runTaskCompletionVerification({
    taskStatus: "completed",
    taskResult: { summary: "done", acceptance_findings: [{ code: "existing", message: "keep" }] },
    summary: "done",
    task: { id: "task_verify" },
    goal: { id: "goal_verify" },
    verifierRepoPath: "/repo/main",
    resultJsonPath: "/tmp/result.json",
    config: {},
    verifyTaskCompletionFn: async () => {
      throw new Error("verifier exploded");
    },
  });

  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.failure_class, "verifier_error");
  assert.equal(result.taskResult.verification.failure_class, "verifier_error");
  assert.equal(result.taskResult.failure_class, "verifier_error");
  assert.equal(result.taskResult.acceptance_findings.length, 2);
  assert.equal(result.taskResult.acceptance_findings[1].code, "verifier_error");
});
