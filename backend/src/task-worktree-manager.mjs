/**
 * task-worktree-manager.mjs — Git worktree lifecycle management.
 *
 * Manages creating, removing, and pruning Git worktrees for isolated task execution.
 * Canonical repo dirty state is recorded but does not block by default.
 * Cleanup policy is configurable via GPTWORK_WORKTREE_CLEANUP_POLICY env var.
 */

import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isActiveExecutionStatus, isCompletedStatus, isHumanReviewStatus, isRepairStatus, TASK_STATUSES } from "./task-status-taxonomy.mjs";

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
  return `gptwork/task/${sanitizeWorktreeSegment(taskId)}`;
}

export function getTaskWorktreePath(workspaceRoot, repoId, taskId) {
  const root = resolve(workspaceRoot || process.cwd());
  return join(root, ".gptwork", "worktrees", sanitizeWorktreeSegment(repoId), sanitizeWorktreeSegment(taskId));
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

/**
 * Check the dirty status of the canonical repo.
 * If GPTWORK_REQUIRE_CLEAN_CANONICAL=true, dirtiness is treated as an error.
 * Otherwise, dirty state is recorded and returned but does not block.
 */
async function getCanonicalRepoDirtyStatus(repoPath) {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, timeout: 10_000 });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { ok: false, error: String(inside.stderr || inside.stdout || "not a git repository").trim(), dirty_paths: [] };
  }
  const status = await git(["status", "--porcelain"], { cwd: repoPath, timeout: 10_000 });
  if (!status.ok) {
    return { ok: false, error: String(status.stderr || status.stdout || "git status failed").trim(), dirty_paths: [] };
  }
  const dirtyPaths = status.stdout.trim().split("\n").filter(Boolean);
  if (dirtyPaths.length === 0) return { ok: true, dirty_paths: [] };

  const requireClean = process.env.GPTWORK_REQUIRE_CLEAN_CANONICAL === 'true';
  if (requireClean) {
    return { ok: false, error: `canonical repo is dirty (${dirtyPaths.length} path(s))`, dirty_paths: dirtyPaths };
  }
  // Default: record dirty but don't block
  return { ok: true, dirty_paths: dirtyPaths, dirty: true };
}

export async function ensureTaskWorktree(repoId, taskId, options = {}) {
  const opts = normalizeOptions(repoId, taskId, options);
  if (!opts.canonicalRepoPath) {
    return { ok: false, error: "canonicalRepoPath is required", repo_id: repoId, task_id: taskId };
  }
  await ensureLocalWorktreesIgnore(opts.canonicalRepoPath, opts.worktreePath).catch(() => {});

  // Check canonical repo dirty — default behavior records but doesn't block
  const canonicalStatus = await getCanonicalRepoDirtyStatus(opts.canonicalRepoPath);
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
        dirty_source: canonicalStatus.dirty || false,
        dirty_paths: canonicalStatus.dirty_paths || [],
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
    dirty_source: canonicalStatus.dirty || false,
    dirty_paths: canonicalStatus.dirty_paths || [],
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

function parseWorktreePorcelain(text = "") {
  return String(text || "")
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const item = {};
      for (const line of block.split("\n")) {
        const index = line.indexOf(" ");
        if (index <= 0) continue;
        const key = line.slice(0, index);
        const value = line.slice(index + 1).trim();
        if (key === "worktree") item.path = value;
        else if (key === "branch") item.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "HEAD") item.head = value;
      }
      return item.path ? item : null;
    })
    .filter(Boolean);
}

function parseBranchList(text = "") {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean)
    .filter((branch) => branch.startsWith("gptwork/task/"));
}

function taskWorktreePath(task = {}) {
  return task.worktree_path
    || task.result?.worktree_path
    || task.result?.repo_resolution?.task_worktree_path
    || task.result?.worktree_lifecycle?.worktree_path
    || task.worktree?.path
    || null;
}

function taskBranchName(task = {}) {
  return task.worktree?.branch
    || task.result?.worktree?.branch
    || task.result?.repo_resolution?.worktree_lifecycle?.branch_name
    || task.result?.worktree_lifecycle?.branch_name
    || (task.id ? sanitizeTaskBranchName(task.id) : null);
}

function isProtectedRetainedStatus(status) {
  return isActiveExecutionStatus(status)
    || isHumanReviewStatus(status)
    || isRepairStatus(status)
    || status === TASK_STATUSES.WAITING_FOR_INTEGRATION;
}

function hasIntegratedCompletionEvidence(task = {}) {
  const result = task.result || {};
  return result.commit_integrated === true
    || result.integration?.merged === true
    || result.delivery?.merged === true
    || result.worktree_lifecycle?.cleanup?.ok === true
    || result.verification?.passed === true
    || Boolean(result.commit || result.remote_head);
}

export async function collectRetainedWorktreeDiagnostics(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || options.defaultWorkspaceRoot || process.cwd());
  const canonicalRepoPath = options.canonicalRepoPath || options.canonical_repo_path || options.defaultRepoPath;
  if (!canonicalRepoPath) return { ok: false, error: "canonicalRepoPath is required" };

  let worktreeText = options.gitWorktreeListPorcelain;
  if (worktreeText === undefined) {
    const listResult = await git(["worktree", "list", "--porcelain"], { cwd: resolve(canonicalRepoPath), timeout: 30_000 });
    worktreeText = listResult.ok ? listResult.stdout : "";
  }
  let branchText = options.gitBranchList;
  if (branchText === undefined) {
    const branchResult = await git(["branch", "--list", "gptwork/task/*", "--format=%(refname:short)"], { cwd: resolve(canonicalRepoPath), timeout: 30_000 });
    branchText = branchResult.ok ? branchResult.stdout : "";
  }

  const worktrees = parseWorktreePorcelain(worktreeText)
    .filter((worktree) => worktree.path !== resolve(canonicalRepoPath))
    .filter((worktree) => worktree.path.startsWith(workspaceRoot + "/") || worktree.path.includes("/.gptwork/worktrees/"));
  const taskBranches = parseBranchList(branchText);
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  const tasksByPath = new Map();
  const tasksByBranch = new Map();
  for (const task of tasks) {
    const path = taskWorktreePath(task);
    const branch = taskBranchName(task);
    if (path) tasksByPath.set(resolve(path), task);
    if (branch) tasksByBranch.set(branch, task);
  }

  const retained = worktrees.map((worktree) => {
    const task = tasksByPath.get(resolve(worktree.path)) || tasksByBranch.get(worktree.branch) || null;
    return {
      path: worktree.path,
      branch: worktree.branch || null,
      head: worktree.head || null,
      task_id: task?.id || null,
      task_status: task?.status || null,
      terminal: task ? isCompletedStatus(task.status) : false,
      integrated: task ? hasIntegratedCompletionEvidence(task) : false,
    };
  });
  const protectedRetained = retained.filter((item) => isProtectedRetainedStatus(item.task_status));
  const cleanupCandidates = retained.filter((item) => item.terminal && item.integrated);

  return {
    ok: true,
    retained_worktrees_count: retained.length,
    retained_task_branches_count: taskBranches.length,
    terminal_retained_worktrees_count: retained.filter((item) => item.terminal).length,
    cleanup_candidates_count: cleanupCandidates.length,
    protected_retained_worktrees_count: protectedRetained.length,
    retained_worktrees: retained.slice(0, options.limit || 50),
    protected_retained_worktrees: protectedRetained.slice(0, options.limit || 50),
    cleanup_candidates: cleanupCandidates.slice(0, options.limit || 50),
    safe_cleanup_hint: "dry-run only: review cleanup_candidates, never remove running/assigned/queued/waiting_for_review/waiting_for_repair/waiting_for_integration worktrees.",
  };
}

/**
 * Prune stale worktrees.
 * Only removes worktrees that are:
 *  - Terminal (completed, failed, cancelled, timed_out)
 *  - Beyond the TTL (default: 24 hours)
 *  - Have no active lock
 *  - Have no pending repair or integration
 */
export async function pruneStaleWorktrees(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || options.defaultWorkspaceRoot || process.cwd());
  const canonicalRepoPath = options.canonicalRepoPath || options.canonical_repo_path || options.defaultRepoPath;
  if (!canonicalRepoPath) return { ok: false, error: "canonicalRepoPath is required", pruned: false, orphans: [] };

  // Only prune worktrees that are beyond TTL
  const ttlMs = options.ttlMs || (24 * 60 * 60 * 1000); // default 24h
  const now = Date.now();

  // Get git worktree list
  const listResult = await git(["worktree", "list", "--porcelain"], {
    cwd: resolve(canonicalRepoPath),
    timeout: 30_000,
  });

  const pruned = [];
  const skipped = [];
  const errors = [];

  if (listResult.ok) {
    // Parse porcelain output: worktree blocks separated by blank lines
    const blocks = listResult.stdout.trim().split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const pathLine = lines.find(l => l.startsWith('worktree '));
      const branchLine = lines.find(l => l.startsWith('branch '));
      const headLine = lines.find(l => l.startsWith('HEAD '));

      if (!pathLine) continue;
      const wtPath = pathLine.slice('worktree '.length).trim();

      // Skip the main worktree
      if (wtPath === resolve(canonicalRepoPath)) continue;

      // Check if it's likely a gptwork worktree
      if (!wtPath.includes('/worktrees/')) {
        skipped.push({ path: wtPath, reason: 'not a gptwork worktree' });
        continue;
      }

      // Check if worktree is within our workspace
      if (!wtPath.startsWith(workspaceRoot + '/')) {
        skipped.push({ path: wtPath, reason: 'outside workspace' });
        continue;
      }

      // Check age
      try {
        const st = await stat(wtPath);
        const age = now - st.ctimeMs;
        if (age < ttlMs) {
          skipped.push({ path: wtPath, reason: `within TTL (age=${Math.round(age / 1000 / 60)}m)` });
          continue;
        }
      } catch {
        // can't stat, skip
        skipped.push({ path: wtPath, reason: 'cannot stat' });
        continue;
      }

      // Check if there's an active lock file
      const lockPath = join(wtPath, '.gptwork', 'lock');
      if (await pathExists(lockPath)) {
        skipped.push({ path: wtPath, reason: 'has active lock' });
        continue;
      }

      // Check for pending repair marker
      const repairMarker = join(wtPath, '.gptwork', 'pending_repair');
      if (await pathExists(repairMarker)) {
        skipped.push({ path: wtPath, reason: 'has pending repair' });
        continue;
      }

      // Check for pending integration marker
      const integrationMarker = join(wtPath, '.gptwork', 'pending_integration');
      if (await pathExists(integrationMarker)) {
        skipped.push({ path: wtPath, reason: 'has pending integration' });
        continue;
      }

      // Remove the worktree
      const args = ["-C", resolve(canonicalRepoPath), "worktree", "remove", wtPath, "--force"];
      const removeResult = await git(args, { timeout: 60_000 });
      if (removeResult.ok) {
        pruned.push(wtPath);
      } else {
        errors.push({ path: wtPath, error: removeResult.stderr });
      }
    }
  }

  // Also run git worktree prune for cleanup
  const pruneArgs = ["-C", resolve(canonicalRepoPath), "worktree", "prune"];
  await git(pruneArgs, { timeout: 60_000 });

  // Collect and clean orphans
  const orphans = await collectOrphans(join(workspaceRoot, ".gptwork", "worktrees"));
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

  return {
    ok: true,
    pruned_count: pruned.length,
    pruned,
    skipped,
    orphans_removed: removedOrphans.length,
    removed_orphans: removedOrphans,
    orphan_errors: orphanErrors,
    errors,
  };
}
