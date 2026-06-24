import { execFileSync } from "node:child_process";
import { removeTaskWorktree as removeManagedTaskWorktree, ensureTaskWorktree } from "./task-worktree-manager.mjs";

function resolveBaseSha(repoPath, baseRef = "HEAD") {
  try {
    return execFileSync("git", ["rev-parse", baseRef], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function resolveHeadSha(repoPath) {
  return resolveBaseSha(repoPath, "HEAD");
}

function toSpecWorktree(result, { canonicalRepoPath, baseRef }) {
  return {
    enabled: result.ok === true,
    path: result.worktree_path || result.worktreePath || null,
    branch: result.branch_name || null,
    base_ref: baseRef || result.base_ref || "HEAD",
    base_sha: canonicalRepoPath ? resolveBaseSha(canonicalRepoPath, baseRef || result.base_ref || "HEAD") : null,
    head_sha: result.worktree_path ? resolveHeadSha(result.worktree_path) : null,
    status: result.ok ? (result.existing ? "running" : "created") : "cleanup_failed",
  };
}

export async function createTaskWorktree(options = {}) {
  const taskId = options.task_id || options.taskId || options.id;
  const repoId = options.repo_id || options.repoId || "default";
  const baseRef = options.baseRef || options.base_ref || "HEAD";
  const branchName = options.branchName || options.branch || `gptwork/task/${String(taskId || "task").replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  const result = await ensureTaskWorktree(repoId, taskId, {
    ...options,
    baseRef,
    branchName,
  });
  return {
    ...result,
    worktree: toSpecWorktree(result, { canonicalRepoPath: options.canonicalRepoPath || options.canonical_repo_path, baseRef }),
  };
}

export async function removeTaskWorktree(options = {}) {
  const taskId = options.task_id || options.taskId || options.id;
  const result = await removeManagedTaskWorktree(taskId, {
    ...options,
    repoId: options.repoId || options.repo_id || "default",
  });
  return {
    ...result,
    worktree: {
      enabled: true,
      path: result.worktree_path || options.worktreePath || options.worktree_path || null,
      branch: options.branch || options.branchName || null,
      base_ref: options.baseRef || options.base_ref || "HEAD",
      base_sha: null,
      head_sha: null,
      status: result.ok ? "removed" : "cleanup_failed",
    },
  };
}

export async function checkWorktreeDirty(options = {}) {
  const repoPath = options.repoPath || options.worktreePath || options.path;
  if (!repoPath) return { ok: false, dirty: false, dirty_paths: [], error: "repoPath is required" };
  try {
    const stdout = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const dirtyPaths = stdout.trim().split("\n").filter(Boolean);
    return { ok: true, dirty: dirtyPaths.length > 0, dirty_paths: dirtyPaths };
  } catch (err) {
    return { ok: false, dirty: false, dirty_paths: [], error: err?.message || String(err) };
  }
}

export async function checkMergeability(options = {}) {
  const repoPath = options.repoPath || options.canonicalRepoPath || options.canonical_repo_path;
  const baseSha = options.base_sha || options.baseSha || "HEAD";
  const baseRef = options.base_ref || options.baseRef || "HEAD";
  const taskBranch = options.task_branch || options.taskBranch || options.branch;
  if (!repoPath || !taskBranch) return { ok: false, merge_status: "unknown", error: "repoPath and taskBranch are required" };
  try {
    const stdout = execFileSync("git", ["merge-tree", baseSha, baseRef, taskBranch], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const conflict = /^<<<<<<< |^=======|^>>>>>>> /m.test(stdout);
    return {
      ok: true,
      merge_status: conflict ? "conflict" : "clean",
      target_branch: baseRef,
      task_branch: taskBranch,
      stdout_tail: stdout.slice(-4000),
    };
  } catch (err) {
    return {
      ok: false,
      merge_status: "unknown",
      target_branch: baseRef,
      task_branch: taskBranch,
      error: err?.stderr?.toString() || err?.message || String(err),
    };
  }
}
