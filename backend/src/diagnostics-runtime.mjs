import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_DEFAULTS, withCache } from "./diagnostics-cache.mjs";

export function resolveRepoDir() {
  const start = process.cwd();
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      // Handle both regular repos (.git is a directory) and git worktrees
      // (.git is a file containing "gitdir: <path>")
      if (statSync(join(dir, ".git")).isDirectory() || statSync(join(dir, ".git")).isFile()) return dir;
    } catch (e) {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Determine whether runtime env loaded Bark config vars. */
export function determineBarkConfigSource(envLoadResultKeys) {
  const barkVars = ["GPTWORK_BARK_ENABLED", "GPTWORK_BARK_URL", "GPTWORK_BARK_KEY", "GPTWORK_BARK_GROUP", "GPTWORK_BARK_SOUND", "GPTWORK_BARK_LEVEL"];
  const fromEnv = barkVars.filter(v => envLoadResultKeys.includes(v));
  if (fromEnv.length > 0) return "workspace-runtime-env";
  const anySet = barkVars.some(v => process.env[v] !== undefined);
  return anySet ? "process.env" : "disabled";
}

/**
 * Collect git info from a repo directory: HEAD commit, remote HEAD,
 * and worktree dirty state.
 */
export function collectRuntimeGitInfo(repoDir) {
  let repo_head = null, remote_head = null, running_commit = null;
  let worktree_dirty = false, dirty_paths = [];

  if (repoDir) {
    try {
      const out = execSync("git rev-parse HEAD 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
      if (out) repo_head = out;
    } catch (e) {}
    try {
      const line = execSync("git ls-remote origin refs/heads/main 2>/dev/null", { cwd: repoDir, timeout: 2000, encoding: "utf8" }).trim();
      if (line) remote_head = line.split(/\s+/)[0];
    } catch (e) {}
    try {
      const statusOut = execSync("git status --short 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
      if (statusOut.length > 0) {
        worktree_dirty = true;
        dirty_paths = statusOut.split("\n").filter(l => l.trim()).map(l => l.trim());
      }
    } catch (e) {}
    running_commit = repo_head;
  }

  return { repo_head, remote_head, running_commit, worktree_dirty, dirty_paths };
}

export async function collectRuntimeGitInfoCached(repoDir, { ttlMs = CACHE_DEFAULTS.gitStatus } = {}) {
  return withCache("gitStatus:" + (repoDir || "none"), ttlMs, async () => collectRuntimeGitInfo(repoDir));
}

/**
 * Collect restart marker summary from workspace root.
 * Returns total count, active count, per-status counts, and marker dir existence.
 */
