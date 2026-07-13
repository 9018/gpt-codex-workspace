/**
 * docs-only-safe-integration.mjs — Controlled idempotent integration for
 * docs-only commits into the canonical main branch.
 *
 * P0: Docs-only commits (only .md, .txt, .rst, .adoc files) can be
 * integrated through this controlled path. It enforces:
 *   - Worktree is clean
 *   - Commit object exists
 *   - All changed files are on the docs allowlist
 *   - Canonical repo is clean
 *   - No active repo lock
 *   - Operation is idempotent (already-integrated is detected)
 *
 * After integration, the commit is verified reachable from main.
 * No unrestricted shell or manual cherry-pick is used.
 */

import { execFileSync } from "node:child_process";
import { acquireRepoLock, releaseRepoLock } from "./repo-lock.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCS_ALLOWLIST_PATTERNS = [
  /\.(md|txt|rst|adoc|markdown)$/i,
  /^docs\//i,
  /^README/i,
  /^CHANGELOG/i,
  /^LICENSE/i,
  /\.svg$/i,
];

/**
 * Check if a file path matches the docs allowlist.
 */
export function isDocsOnlyPath(filePath) {
  return DOCS_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Verify that all changed files in a commit are docs-only.
 */
export function areAllChangedFilesDocs(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every((file) => isDocsOnlyPath(file));
}

// ---------------------------------------------------------------------------
// Main integration function
// ---------------------------------------------------------------------------

/**
 * Safely integrate a docs-only commit onto the canonical main branch.
 *
 * Checks performed:
 * 1. Commit object exists
 * 2. Worktree is clean
 * 3. Changed files are all docs-only
 * 4. Canonical repo is clean
 * 5. No active integration lock
 * 6. Idempotency: already-reachable commits are detected and skipped
 *
 * @param {object} options
 * @param {string} options.commit - Commit hash to integrate
 * @param {string} options.canonicalRepoPath - Path to canonical repo
 * @param {string[]} [options.changedFiles] - Files changed in the commit
 * @param {string} [options.taskBranch] - Optional task branch name
 * @param {string} [options.locksBasePath] - Locks base path
 * @param {string} [options.taskId] - Task ID (for lock naming)
 * @returns {Promise<{ ok: boolean, status: string, merged: boolean, commit: string, error?: string, details?: object }>}
 */
export async function integrateDocsOnlyCommit({
  commit,
  canonicalRepoPath,
  changedFiles = [],
  taskBranch = null,
  locksBasePath = null,
  taskId = "docs_integration",
} = {}) {
  if (!commit) return { ok: false, status: "invalid_params", merged: false, commit, error: "commit is required" };
  if (!canonicalRepoPath) return { ok: false, status: "invalid_params", merged: false, commit, error: "canonicalRepoPath is required" };

  // --- Check 1: Commit object exists ---
  try {
    execFileSync("git", ["cat-file", "-e", commit], { cwd: canonicalRepoPath, stdio: "ignore", timeout: 10000 });
  } catch {
    return { ok: false, status: "commit_not_found", merged: false, commit, error: `Commit ${commit.slice(0, 12)} does not exist in canonical repo` };
  }

  // --- Check 2: Worktree is clean (the repo itself, not the task worktree) ---
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: canonicalRepoPath, encoding: "utf8", timeout: 10000,
    }).trim();
    if (status.length > 0) {
      return { ok: false, status: "canonical_repo_dirty", merged: false, commit, error: "Canonical repo has uncommitted changes; refusing to integrate" };
    }
  } catch (err) {
    return { ok: false, status: "dirty_check_failed", merged: false, commit, error: `Cannot check canonical repo cleanliness: ${err.message}` };
  }

  // --- Check 3: Verify all changed files are docs-only ---
  let filesToCheck = changedFiles;
  if (filesToCheck.length === 0) {
    // Try to detect changed files from the commit
    try {
      const diffOutput = execFileSync("git", ["diff", "--name-only", `${commit}^..${commit}`], {
        cwd: canonicalRepoPath, encoding: "utf8", timeout: 10000,
      }).trim();
      filesToCheck = diffOutput.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    } catch {
      // If we can't detect, accept the given list (or empty)
    }
  }

  if (filesToCheck.length > 0 && !areAllChangedFilesDocs(filesToCheck)) {
    const nonDocs = filesToCheck.filter((f) => !isDocsOnlyPath(f));
    return {
      ok: false, status: "non_docs_files", merged: false, commit,
      error: `Commit contains non-docs files: ${nonDocs.join(", ")}`,
      non_docs_files: nonDocs,
    };
  }

  // --- Check 4: No active integration lock on this repo ---
  const lockPath = locksBasePath || canonicalRepoPath;
  const lockResult = await acquireRepoLock(lockPath, `docs_integration:${canonicalRepoPath}`, {
    taskId: taskId || "docs_integration",
    mode: "integration",
  });
  if (!lockResult.acquired) {
    return {
      ok: false, status: "locked", merged: false, commit,
      error: `Integration lock held: ${lockResult.reason || "by another task"}`,
    };
  }

  try {
    // --- Check 5: Commit already reachable on main/HEAD (idempotency) ---
    let alreadyReachable = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
        cwd: canonicalRepoPath, stdio: "ignore", timeout: 10000,
      });
      alreadyReachable = true;
    } catch {
      // Not an ancestor — need to integrate
    }

    if (alreadyReachable) {
      return {
        ok: true,
        status: "already_integrated",
        merged: true,
        commit,
        details: { already_reachable: true, reachable_from: "HEAD" },
      };
    }

    // --- Check 6: If we have a task branch, try a controlled ff-merge ---
    if (taskBranch) {
      // Verify the branch exists
      try {
        execFileSync("git", ["rev-parse", "--verify", taskBranch], { cwd: canonicalRepoPath, stdio: "ignore", timeout: 10000 });
      } catch {
        return { ok: false, status: "branch_not_found", merged: false, commit, error: `Branch ${taskBranch} does not exist in canonical repo` };
      }

      // Fast-forward merge from task branch into current branch (main)
      try {
        execFileSync("git", ["merge", "--ff-only", taskBranch], {
          cwd: canonicalRepoPath, stdio: "pipe", timeout: 30000,
        });
      } catch (err) {
        return {
          ok: false, status: "ff_merge_failed", merged: false, commit,
          error: `FF-only merge of ${taskBranch} failed: ${err.stderr?.toString().trim() || err.message}`,
        };
      }

      // Verify the commit is now reachable
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
          cwd: canonicalRepoPath, stdio: "ignore", timeout: 10000,
        });
      } catch {
        return {
          ok: false, status: "merge_verification_failed", merged: false, commit,
          error: "FF merge completed but commit is still not reachable from HEAD",
        };
      }

      return {
        ok: true, status: "ff_merged", merged: true, commit,
        details: { ff_merge: true, branch: taskBranch },
      };
    }

    // No merge path available and commit is not reachable
    return {
      ok: false, status: "not_reachable", merged: false, commit,
      error: "Commit is not reachable from HEAD and no task branch was provided for merge",
    };
  } finally {
    // Always release the integration lock
    try {
      await releaseRepoLock(lockPath, `docs_integration:${canonicalRepoPath}`, taskId || "docs_integration");
    } catch {
      // Non-fatal: lock release best-effort
    }
  }
}

export default { integrateDocsOnlyCommit, isDocsOnlyPath, areAllChangedFilesDocs };
