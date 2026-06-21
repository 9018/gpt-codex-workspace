import { createHash } from "node:crypto";
import { join } from "node:path";

export const LOCKS_DIR = ".gptwork/locks/repos";
export const STALL_THRESHOLD_MS = 900_000; // 15 minutes — generous for long Codex runs
export const VALID_STATUSES = ["held", "stale", "released"];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Create a filesystem-safe identifier from a repo path.
 * Replaces non-alphanumeric characters with underscore and SHA-256 prefix.
 *
 * @param {string} repoPath — canonical repo path
 * @returns {string} safe id
 */
export function safeRepoId(repoPath) {
  if (!repoPath) return "__unknown__";
  // Use SHA-256 prefix for uniqueness, plus a cleaned path suffix for readability
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  const clean = String(repoPath)
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9_/-]/g, "_")
    .replace(/[/]/g, "--");
  return `${hash}-${clean}`;
}

/**
 * Get the locks directory for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getLocksDir(workspaceRoot) {
  return join(workspaceRoot, LOCKS_DIR);
}

/**
 * Get lock file path for a repo.
 *
 * @param {string} workspaceRoot
 * @param {string} repoPath — canonical repo path
 * @returns {string}
 */
export function getLockFilePath(workspaceRoot, repoPath) {
  return join(getLocksDir(workspaceRoot), safeRepoId(repoPath) + ".json");
}
