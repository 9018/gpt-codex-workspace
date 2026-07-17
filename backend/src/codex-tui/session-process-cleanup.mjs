/**
 * session-process-cleanup.mjs — Worktree process cleanup utilities.
 *
 * @module session-process-cleanup
 */

import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Check whether a numeric PID is currently alive on this host.
 * @param {number|string} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deduplicate and filter an array of strings.
 * @param {string[]} [values=[]]
 * @returns {string[]}
 */
export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

/**
 * Build a candidate list of workspace roots, deduplicated.
 * @param {object} [options]
 * @returns {string[]}
 */
export function candidateWorkspaceRoots({ workspaceRoot = null, candidateWorkspaceRoots = [] } = {}) {
  return uniqueStrings([workspaceRoot, ...candidateWorkspaceRoots, process.cwd()]);
}

/**
 * Terminate orphan processes still holding a reference to a worktree cwd.
 *
 * Detection uses /proc/<pid>/cwd on Linux; on non-Linux the guard is a no-op.
 *
 * @param {object} options
 * @returns {Promise<object>} Cleanup report
 */
export async function cleanupIsolatedWorktreeProcesses({
  cwd,
  currentPid = process.pid,
  procRoot = "/proc",
  readdirFn = readdir,
  readlinkFn = readlink,
  killFn = process.kill.bind(process),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = 500,
} = {}) {
  const target = String(cwd || "").trim();
  const guarded = process.platform === "linux" && target.includes("/.gptwork/worktrees/");
  if (!guarded) {
    return { attempted: false, target_cwd: target || null, terminated: [], killed: [], surviving: [] };
  }

  const matchingPids = async () => {
    const entries = await readdirFn(procRoot, { withFileTypes: true }).catch(() => []);
    const matches = [];
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1 || pid === Number(currentPid)) continue;
      const processCwd = await readlinkFn(join(procRoot, name, "cwd")).catch(() => null);
      if (processCwd === target) matches.push(pid);
    }
    return matches;
  };

  const terminated = await matchingPids();
  for (const pid of terminated) {
    try { killFn(pid, "SIGTERM"); } catch { /* process may have exited */ }
  }
  if (terminated.length > 0 && graceMs > 0) await sleepFn(graceMs);
  const survivorsAfterTerm = await matchingPids();
  const killed = [];
  for (const pid of survivorsAfterTerm) {
    try { killFn(pid, "SIGKILL"); killed.push(pid); } catch { /* process may have exited */ }
  }
  if (killed.length > 0) await sleepFn(50);
  const surviving = await matchingPids();
  return { attempted: true, target_cwd: target, terminated, killed, surviving };
}
