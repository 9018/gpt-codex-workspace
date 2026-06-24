import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function sanitizeWorktreeSegment(value) {
  const raw = String(value || "default");
  const cleaned = raw
    .replace(/\.\./g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 96);
  return cleaned || "default";
}

export function sanitizeTaskBranchName(taskId) {
  return `gptwork/${sanitizeWorktreeSegment(taskId)}`;
}

export function getTaskWorktreePath(workspaceRoot, repoId, taskId) {
  const root = resolve(workspaceRoot || process.cwd());
  return join(root, "worktrees", sanitizeWorktreeSegment(repoId), sanitizeWorktreeSegment(taskId));
}

function normalizeOptions(repoId, taskId, options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || options.defaultWorkspaceRoot || process.cwd());
  const canonicalRepoPath = options.canonicalRepoPath || options.canonical_repo_path || options.defaultRepoPath;
  const worktreePath = options.worktreePath || options.taskWorktreePath || getTaskWorktreePath(workspaceRoot, repoId, taskId);
  return {
    workspaceRoot,
    canonicalRepoPath: canonicalRepoPath ? resolve(canonicalRepoPath) : "",
    worktreePath: resolve(worktreePath),
    baseRef: options.baseRef || options.defaultBranch || "HEAD",
    branchName: options.branchName || sanitizeTaskBranchName(taskId),
    force: options.force === true,
  };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function git(args, opts = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: opts.cwd || undefined,
      encoding: "utf8",
      timeout: opts.timeout || 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "git command failed",
      code: err?.code || null,
    };
  }
}

async function isGitWorktree(path) {
  if (!(await pathExists(path))) return false;
  const result = await git(["rev-parse", "--is-inside-work-tree"], { cwd: path, timeout: 10_000 });
  return result.ok && result.stdout.trim() === "true";
}

export async function ensureTaskWorktree(repoId, taskId, options = {}) {
  const opts = normalizeOptions(repoId, taskId, options);
  if (!opts.canonicalRepoPath) {
    return { ok: false, error: "canonicalRepoPath is required", repo_id: repoId, task_id: taskId };
  }
  if (!opts.worktreePath.startsWith(opts.workspaceRoot + "/") && opts.worktreePath !== opts.workspaceRoot) {
    return { ok: false, error: "worktree path escapes workspace root", worktree_path: opts.worktreePath };
  }

  const existing = await pathExists(opts.worktreePath);
  if (existing) {
    if (await isGitWorktree(opts.worktreePath)) {
      return {
        ok: true,
        existing: true,
        git_worktree_created: false,
        repo_id: repoId,
        task_id: taskId,
        canonical_repo_path: opts.canonicalRepoPath,
        worktree_path: opts.worktreePath,
        branch_name: opts.branchName,
        base_ref: opts.baseRef,
      };
    }
    return { ok: false, error: "worktree path exists but is not a git worktree", worktree_path: opts.worktreePath };
  }

  await mkdir(join(opts.worktreePath, ".."), { recursive: true });
  const args = ["-C", opts.canonicalRepoPath, "worktree", "add", opts.worktreePath, "-b", opts.branchName, opts.baseRef];
  const result = await git(args, { timeout: options.timeout || 60_000 });
  if (!result.ok) {
    await rm(opts.worktreePath, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      error: `worktree add failed: ${String(result.stderr || result.stdout).trim()}`,
      command: `git ${args.join(" ")}`,
      repo_id: repoId,
      task_id: taskId,
      canonical_repo_path: opts.canonicalRepoPath,
      worktree_path: opts.worktreePath,
      branch_name: opts.branchName,
      base_ref: opts.baseRef,
    };
  }

  return {
    ok: true,
    existing: false,
    git_worktree_created: true,
    repo_id: repoId,
    task_id: taskId,
    canonical_repo_path: opts.canonicalRepoPath,
    worktree_path: opts.worktreePath,
    branch_name: opts.branchName,
    base_ref: opts.baseRef,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function removeTaskWorktree(taskId, options = {}) {
  const repoId = options.repoId || options.repo_id || "default";
  const opts = normalizeOptions(repoId, taskId, options);
  if (!opts.canonicalRepoPath) return { ok: false, error: "canonicalRepoPath is required" };

  if (!(await pathExists(opts.worktreePath))) {
    return { ok: true, removed: false, reason: "worktree path not found", worktree_path: opts.worktreePath };
  }

  const args = ["-C", opts.canonicalRepoPath, "worktree", "remove", opts.worktreePath];
  if (opts.force) args.push("--force");
  const result = await git(args, { timeout: options.timeout || 60_000 });
  if (!result.ok) {
    return {
      ok: false,
      removed: false,
      error: `worktree remove failed: ${String(result.stderr || result.stdout).trim()}`,
      command: `git ${args.join(" ")}`,
      worktree_path: opts.worktreePath,
    };
  }
  return { ok: true, removed: true, worktree_path: opts.worktreePath, stdout: result.stdout, stderr: result.stderr };
}

async function collectOrphans(worktreesRoot) {
  const orphans = [];
  if (!existsSync(worktreesRoot)) return orphans;
  const repoDirs = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) continue;
    const repoPath = join(worktreesRoot, repoDir.name);
    const taskDirs = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
    for (const taskDir of taskDirs) {
      if (!taskDir.isDirectory()) continue;
      const candidate = join(repoPath, taskDir.name);
      if (!(await isGitWorktree(candidate))) {
        orphans.push(candidate);
      }
    }
  }
  return orphans;
}

export async function pruneStaleWorktrees(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || options.defaultWorkspaceRoot || process.cwd());
  const canonicalRepoPath = options.canonicalRepoPath || options.canonical_repo_path || options.defaultRepoPath;
  if (!canonicalRepoPath) return { ok: false, error: "canonicalRepoPath is required", pruned: false, orphans: [] };

  const args = ["-C", resolve(canonicalRepoPath), "worktree", "prune"];
  const result = await git(args, { timeout: options.timeout || 60_000 });
  const orphans = await collectOrphans(join(workspaceRoot, "worktrees"));
  if (!result.ok) {
    return { ok: false, error: `worktree prune failed: ${String(result.stderr || result.stdout).trim()}`, command: `git ${args.join(" ")}`, pruned: false, orphans };
  }
  return { ok: true, pruned: true, orphans, stdout: result.stdout, stderr: result.stderr };
}

