import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a git repo has uncommitted changes.
 *
 * @param {string|null|undefined} repoPath
 * @returns {boolean}
 */
export function isRepoDirty(repoPath) {
  if (!repoPath) return false;
  try {
    if (!existsSync(join(repoPath, ".git"))) return false;
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}
