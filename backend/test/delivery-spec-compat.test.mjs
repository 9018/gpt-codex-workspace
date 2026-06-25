import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

test("delivery spec file-level API modules exist and expose required functions", async () => {
  const worktree = await import("../src/worktree-service.mjs");
  const acceptance = await import("../src/task-acceptance.mjs");
  const verifier = await import("../src/task-verifier.mjs");
  const retry = await import("../src/task-retry.mjs");
  const classifier = await import("../src/failure-classifier.mjs");
  const agentService = await import("../src/agent-service.mjs");
  const agentTools = await import("../src/agent-tools.mjs");
  const subagentPolicy = await import("../src/subagent-policy.mjs");

  assert.equal(typeof worktree.createTaskWorktree, "function");
  assert.equal(typeof worktree.removeTaskWorktree, "function");
  assert.equal(typeof worktree.checkWorktreeDirty, "function");
  assert.equal(typeof worktree.checkMergeability, "function");
  assert.equal(typeof acceptance.verifyTaskCompletion, "function");
  assert.equal(verifier.verifyTaskCompletion, acceptance.verifyTaskCompletion);
  assert.equal(typeof retry.shouldAttemptRepair, "function");
  assert.equal(typeof retry.createRepairGoalFromFindings, "function");
  assert.equal(typeof classifier.classifyFailure, "function");
  assert.equal(typeof agentService.runAgentPipeline, "function");
  assert.equal(typeof agentTools.createAgentRunToolsGroup, "function");
  assert.ok(subagentPolicy.AGENT_ROLES.includes("planner"));
  assert.ok(subagentPolicy.AGENT_ROLES.includes("repairer"));
});

test("worktree-service creates spec-shaped worktree records", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-spec-wt-"));
  const repo = join(root, "repo");
  await initGitRepo(repo);

  const { createTaskWorktree, removeTaskWorktree } = await import("../src/worktree-service.mjs");
  const result = await createTaskWorktree({
    task_id: "task_001",
    repo_id: "repo",
    workspaceRoot: root,
    canonicalRepoPath: repo,
    baseRef: "main",
  });

  assert.equal(result.ok, true);
  assert.equal(result.worktree.enabled, true);
  assert.equal(result.worktree.branch, "gptwork/task/task_001");
  assert.equal(result.worktree.base_ref, "main");
  assert.match(result.worktree.base_sha, /^[0-9a-f]{40}$/);
  assert.equal(result.worktree.status, "created");
  assert.ok(existsSync(result.worktree.path));

  const removed = await removeTaskWorktree({
    task_id: "task_001",
    repo_id: "repo",
    workspaceRoot: root,
    canonicalRepoPath: repo,
    worktreePath: result.worktree.path,
  });
  assert.equal(removed.ok, true);
});

test("verifyTaskCompletion rejects completed result without passed verification", async () => {
  const { verifyTaskCompletion } = await import("../src/task-acceptance.mjs");
  const result = await verifyTaskCompletion({
    task: { id: "task_bad" },
    resultJson: {
      status: "completed",
      summary: "claimed complete",
      changed_files: ["src/app.mjs"],
      verification: { passed: false, commands: ["npm test"] },
    },
    repoPath: process.cwd(),
    config: { discoverVerificationCommands: false },
  });

  assert.equal(result.passed, false);
  assert.equal(result.status, "waiting_for_review");
  assert.equal(result.failure_class, "test_failed");
});

test("unknown agent roles are rejected instead of silently becoming implementer", async () => {
  const { createAgentRun } = await import("../src/agent-service.mjs");
  const store = {
    state: { agent_runs: [] },
    async mutate(fn) { return fn(this.state); },
  };

  await assert.rejects(
    () => createAgentRun(store, { role: "analyst" }),
    /unsupported agent role/i,
  );
});
