import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSessionPathContext } from "../src/codex-tui/session-service.mjs";

const execFileAsync = promisify(execFile);

test("session service resolves native session roots when caller omits pathContext", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-path-context-"));
  const project = join(root, "project");
  const worktree = join(root, "worktree");
  const workspace = join(root, "workspace");
  await mkdir(project, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["init", "-q", project]);
  await execFileAsync("git", ["-C", project, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", project, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", project, "commit", "--allow-empty", "-qm", "init"]);
  await execFileAsync("git", ["-C", project, "worktree", "add", "-q", "-b", "test-worktree", worktree]);

  const ctx = await resolveSessionPathContext({
    cwd: worktree,
    workspaceRoot: workspace,
    task: { id: "task_abc", canonical_repo_path: project, worktree_path: worktree },
  });

  assert.equal(ctx.projectRoot, project);
  assert.equal(ctx.executionCwd, worktree);
  assert.match(ctx.nativeSessionsRoot, /sessions$/);
  assert.match(ctx.controlSessionsRoot, /\.gptwork\/codex-sessions$/);
});
