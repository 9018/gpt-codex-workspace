import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireRepoLock, getLockFilePath } from "../src/repo-lock.mjs";
import { reconcileRuntimeRepoLocks } from "../src/runtime-reconciler-repo-locks.mjs";

test("runtime reconciliation releases a fresh lock owned by a terminal task", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "canary-b3-terminal-lock-"));
  const repoPath = join(workspaceRoot, "repo");
  await mkdir(repoPath, { recursive: true });

  const acquired = await acquireRepoLock(workspaceRoot, repoPath, {
    taskId: "task_terminal",
    pid: process.pid,
    mode: "builder",
  });
  assert.equal(acquired.acquired, true);

  const state = {
    tasks: [{ id: "task_terminal", status: "failed" }],
  };
  const result = await reconcileRuntimeRepoLocks({
    state,
    config: { defaultWorkspaceRoot: workspaceRoot },
  });

  const lock = JSON.parse(await readFile(getLockFilePath(workspaceRoot, repoPath), "utf8"));
  assert.equal(lock.status, "released");
  assert.equal(result.terminal_released, 1);
});
