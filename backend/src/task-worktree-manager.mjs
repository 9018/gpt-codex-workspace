import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function ensureLocalWorktreesIgnore(canonicalRepoPath, worktreePath) {
  const gitDir = await git(["rev-parse", "--git-dir"], { cwd: canonicalRepoPath, timeout: 10_000 });
  if (!gitDir.ok) return;
  const gitDirPath = resolve(canonicalRepoPath, gitDir.stdout.trim());
  const infoDir = join(gitDirPath, "info");
  const excludePath = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });
  const relativeWorktree = worktreePath.startsWith(canonicalRepoPath + "/")
    ? worktreePath.slice(canonicalRepoPath.length + 1).split("/")[0]
    : "";
  const patterns = [".gptwork/", "worktrees/", relativeWorktree && `${relativeWorktree}/`].filter(Boolean);
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  const missing = patterns.filter((pattern) => !existing.split(/\r?\n/).includes(pattern));
  if (missing.length > 0) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, existing + prefix + missing.join("\n") + "\n", "utf8");
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

async function getGitStatus(repoPath) {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, timeout: 10_000 });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { ok: false, error: String(inside.stderr || inside.stdout || "not a git repository").trim() };
  }
  const status = await git(["status", "--porcelain"], { cwd: repoPath, timeout: 10_000 });
  if (!status.ok) {
    return { ok: false, error: String(status.stderr || status.stdout || "git status failed").trim() };
  }
  const dirtyPaths = status.stdout.trim().split("\n").filter(Boolean);
  if (dirtyPaths.length > 0) {
    return { ok: false, error: `canonical repo is dirty (${dirtyPaths.length} path(s))`, dirty_paths: dirtyPaths };
  }
  return { ok: true, dirty_paths: [] };
}

export async function ensureTaskWorktree(repoId, taskId, options = {}) {
  const opts = normalizeOptions(repoId, taskId, options);
  if (!opts.canonicalRepoPath) {
    return { ok: false, error: "canonicalRepoPath is required", repo_id: repoId, task_id: taskId };
  }
  await ensureLocalWorktreesIgnore(opts.canonicalRepoPath, opts.worktreePath).catch(() => {});
  const canonicalStatus = await getGitStatus(opts.canonicalRepoPath);
  if (!canonicalStatus.ok) {
    return {
      ok: false,
      error: canonicalStatus.error || "canonical repo is not clean",
      dirty_paths: canonicalStatus.dirty_paths || [],
      repo_id: repoId,
      task_id: taskId,
      canonical_repo_path: opts.canonicalRepoPath,
      worktree_path: opts.worktreePath,
    };
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
  const removedOrphans = [];
  const orphanErrors = [];
  for (const orphan of orphans) {
    try {
      await rm(orphan, { recursive: true, force: true });
      removedOrphans.push(orphan);
    } catch (error) {
      orphanErrors.push({ path: orphan, error: error?.message || String(error || "remove orphan failed") });
    }
  }
  if (!result.ok) {
    return { ok: false, error: `worktree prune failed: ${String(result.stderr || result.stdout).trim()}`, command: `git ${args.join(" ")}`, pruned: false, orphans, removed_orphans: removedOrphans, orphan_errors: orphanErrors };
  }
  if (orphanErrors.length > 0) {
    return { ok: false, error: "failed to remove orphan worktree directories", pruned: true, orphans, removed_orphans: removedOrphans, orphan_errors: orphanErrors, stdout: result.stdout, stderr: result.stderr };
  }
  return { ok: true, pruned: true, orphans, removed_orphans: removedOrphans, orphan_errors: [], stdout: result.stdout, stderr: result.stderr };
}
