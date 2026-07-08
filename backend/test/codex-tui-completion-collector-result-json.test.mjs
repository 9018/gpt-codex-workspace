import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectCodexTuiCompletion } from "../src/codex-tui-completion-collector.mjs";
import { runCodexTuiEvidenceCycle } from "../src/codex-tui-evidence-cycle.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo() {
  const repo = track(await mkdtemp(join(tmpdir(), "codex-tui-result-json-")));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

async function createSession(repo, { sessionId = "session_1", taskId = "task_1", goalId = "goal_1" } = {}) {
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId,
    taskId,
    goalId,
    cwd: repo,
    repoLockId: "repo_lock_1",
  });
  return { sessionId, taskId, goalId };
}

test("collect exposes durable result.json evidence for TUI smoke/noop tasks", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "passed",
    smoke: true,
    provider: "codex_tui_goal",
    changed_files: [],
    tests: [{ command: "smoke-noop", status: "passed" }],
    summary: "TUI smoke produced durable evidence.",
  }, null, 2));
  await writeFile(join(goalDir, "result.md"), "Summary: TUI smoke produced durable evidence.\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.result_json_present, true);
  assert.equal(snapshot.result_json_valid, true);
  assert.equal(snapshot.result_json.status, "passed");
  assert.equal(snapshot.result_json.provider, "codex_tui_goal");
  assert.deepEqual(snapshot.changed_files, []);
  assert.equal(snapshot.worktree_clean, true);
  assert.deepEqual(snapshot.tests, [{ command: "smoke-noop", status: "passed" }]);
});

test("evidence cycle becomes ready when result.json exists", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({ status: "passed", changed_files: [], tests: [{ command: "smoke-noop", status: "passed" }] }));
  await writeFile(join(goalDir, "result.md"), "Summary: done\n");

  const cycle = await runCodexTuiEvidenceCycle({
    task: { id: "task_1" },
    goal: { id: "goal_1" },
    sessionId: "session_1",
    workspaceRoot: repo,
    maxWaitMs: 1,
    pollMs: 1,
  });

  assert.equal(cycle.evidence_ready, true);
  assert.equal(cycle.status, "ready");
  assert.equal(cycle.reason, "tui_result_json_collected");
  assert.equal(cycle.collected.result_json.status, "passed");
});
