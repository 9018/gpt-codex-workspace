import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveCanonicalRelPath, detectStaleTempClones, isCanonicalPath } from "./repo-registry-paths.mjs";

export function _gitExec(repoDir, args) {
  try {
    const cmd = `git ${args}`;
    return execSync(cmd, {
      cwd: repoDir || process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

export function _detectGitBranch(repoDir) {
  if (!repoDir || !existsSync(join(repoDir, ".git"))) return null;

  const head = _gitExec(repoDir, "symbolic-ref refs/remotes/origin/HEAD 2>/dev/null");
  if (head) {
    const m = head.match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  }

  const branches = _gitExec(repoDir, "branch -r");
  if (branches) {
    if (branches.includes("origin/main")) return "main";
    if (branches.includes("origin/master")) return "master";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repo Status
// ---------------------------------------------------------------------------

/**
 * Get detailed status for a registered repository.
 */
export async function getRepoStatus(repoRecord, workspaceRoot, registryInstance = null) {
  const repoDir = repoRecord.canonical_path;
  const branch = repoRecord.default_branch;

  let localHead = null;
  let remoteHead = null;
  let currentBranch = null;
  let ahead = 0;
  let behind = 0;
  let hasUncommitted = false;

  if (repoDir && existsSync(join(repoDir, ".git"))) {
    localHead = _gitExec(repoDir, "rev-parse HEAD 2>/dev/null") || null;
    currentBranch = _gitExec(repoDir, "rev-parse --abbrev-ref HEAD 2>/dev/null") || null;
    hasUncommitted = (_gitExec(repoDir, "status --porcelain 2>/dev/null") || "").length > 0;

    // Try local remote tracking ref first
    remoteHead = _gitExec(repoDir, `rev-parse refs/remotes/origin/${branch} 2>/dev/null`);
    if (!remoteHead) {
      const remote = _gitExec(repoDir, "remote get-url origin 2>/dev/null");
      if (remote) {
        const ls = _gitExec(null, `ls-remote "${remote}" refs/heads/${branch} 2>/dev/null`);
        if (ls) remoteHead = ls.split(/\s+/)[0] || null;
      }
    }

    if (localHead) {
      const ab = _gitExec(repoDir, `rev-list --left-right --count origin/${branch}...HEAD 2>/dev/null`);
      if (ab) {
        const parts = ab.split(/\s+/);
        behind = parseInt(parts[0], 10) || 0;
        ahead = parseInt(parts[1], 10) || 0;
      }
    }
  }

  let staleTempCopies = [];
  if (registryInstance) {
    staleTempCopies = await registryInstance.detectStaleTempClones();
  } else {
    staleTempCopies = await detectStaleTempClones(workspaceRoot);
  }

  const canonicalRelPath = repoRecord.canonical_path
    ? relative(workspaceRoot, repoRecord.canonical_path)
    : deriveCanonicalRelPath(repoRecord.repo_id);

  const repoDirExists = repoDir && existsSync(join(repoDir, ".git"));
  return {
    repo_id: repoRecord.repo_id,
    remote_url: repoRecord.remote_url,
    default_branch: branch,
    canonical_path: repoRecord.canonical_path,
    canonical_rel_path: canonicalRelPath,
    current_branch: currentBranch,
    local_head: localHead,
    remote_head: remoteHead,
    ahead,
    behind,
    has_uncommitted: hasUncommitted,
    is_canonical: !!repoRecord.canonical_path && repoDirExists,
    canonical_at_standard_location: repoRecord.canonical_path
      ? isCanonicalPath(repoRecord.canonical_path, workspaceRoot)
      : false,
    effective_path: repoDir,
    registry_path: repoRecord.canonical_path,
    repo_dir_exists: repoDirExists,
    stale_temp_copies: staleTempCopies.filter((c) => c.is_repo),
  };
}
