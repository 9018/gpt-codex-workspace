import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

function gitOutput(repoPath, args) {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
}

async function isDirectory(path) {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function verifyRealTaskWorktree({ resolvedRepo, plan }) {
  const worktreePath = resolvedRepo?.task_worktree_path || resolvedRepo?.worktree_lifecycle?.worktree_path;
  const canonicalRepoPath = resolvedRepo?.canonical_repo_path || plan?.canonical_repo_path;
  const lifecycle = resolvedRepo?.worktree_lifecycle;
  if (lifecycle?.ok !== true || lifecycle?.mode !== "git_worktree") {
    return { valid: false, error: lifecycle?.error || "task worktree lifecycle is not verified git_worktree" };
  }
  if (!(await isDirectory(worktreePath))) {
    return { valid: false, error: `expected task worktree is unavailable: ${worktreePath || "missing task_worktree_path"}` };
  }
  if (!canonicalRepoPath) return { valid: false, error: "canonical repository path is unavailable for worktree verification" };

  try {
    const worktreeTop = await realpath(gitOutput(worktreePath, ["rev-parse", "--show-toplevel"]));
    const canonicalTop = await realpath(gitOutput(canonicalRepoPath, ["rev-parse", "--show-toplevel"]));
    const worktreeGitDir = await realpath(resolve(worktreeTop, gitOutput(worktreePath, ["rev-parse", "--git-dir"])));
    const worktreeCommonDir = await realpath(resolve(worktreeTop, gitOutput(worktreePath, ["rev-parse", "--git-common-dir"])));
    const canonicalCommonDir = await realpath(resolve(canonicalTop, gitOutput(canonicalRepoPath, ["rev-parse", "--git-common-dir"])));
    if (worktreeTop === canonicalTop) return { valid: false, error: "task worktree resolves to the canonical repository" };
    if (worktreeGitDir === worktreeCommonDir || worktreeCommonDir !== canonicalCommonDir) {
      return { valid: false, error: "task path is not a linked worktree of the canonical repository" };
    }
    return { valid: true, worktree_top: worktreeTop, canonical_top: canonicalTop, common_git_dir: worktreeCommonDir };
  } catch (err) {
    return { valid: false, error: `task worktree git verification failed: ${err?.message || String(err)}` };
  }
}
