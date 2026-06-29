import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectCodexTuiCompletion } from "../src/codex-tui-completion-collector.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo(prefix = "codex-tui-collector-repo-") {
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
    sessionId: overrides.sessionId || "session_1",
    taskId: overrides.taskId || "task_1",
    goalId: overrides.goalId || "goal_1",
    cwd: repo,
    repoLockId: "repo_lock_1",
    ...overrides.session,
  });
}

test("collect returns not ready when result.md is missing", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.kind, "codex_tui_completion_snapshot");
  assert.equal(snapshot.session_id, "session_1");
  assert.equal(snapshot.goal_id, "goal_1");
  assert.equal(snapshot.task_id, "task_1");
  assert.equal(snapshot.result_md_present, false);
  assert.equal(snapshot.ready_for_review, false);
  assert.ok(snapshot.findings.some((finding) => finding.code === "result_md_missing"));
});

test("collect reports dirty_worktree and commit_missing when dirty work has no commit evidence", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  await mkdir(join(repo, ".gptwork", "goals", "goal_1"), { recursive: true });
  await writeFile(join(repo, ".gptwork", "goals", "goal_1", "result.md"), "Summary\n\nTests: npm test\n");
  await writeFile(join(repo, "changed.txt"), "dirty\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.result_md_present, true);
  assert.equal(snapshot.worktree_clean, false);
  assert.deepEqual(snapshot.changed_files, ["changed.txt"]);
  assert.equal(snapshot.commit, null);
  assert.equal(snapshot.ready_for_review, false);
  assert.ok(snapshot.findings.some((finding) => finding.code === "dirty_worktree"));
  assert.ok(snapshot.findings.some((finding) => finding.code === "commit_missing"));
  assert.equal(snapshot.tests, "npm test");
});

test("collect can return ready_for_review when durable evidence is present", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  await mkdir(join(repo, ".gptwork", "goals", "goal_1"), { recursive: true });
  await writeFile(join(repo, ".gptwork", "goals", "goal_1", "result.md"), "Summary\n\nTests: node --test backend/test/example.test.mjs\nCommit: abcdef1234567890\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.result_md_present, true);
  assert.equal(snapshot.worktree_clean, true);
  assert.deepEqual(snapshot.changed_files, []);
  assert.equal(snapshot.commit, "abcdef1234567890");
  assert.equal(snapshot.tests, "node --test backend/test/example.test.mjs");
  assert.equal(snapshot.ready_for_review, true);
  assert.deepEqual(snapshot.findings, []);
});
