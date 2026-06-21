import { execSync } from "node:child_process";
import { SERVICE_NAME } from "./safe-restart-marker-store.mjs";

export function scheduleDetachedRestart(options = {}) {
  const serviceName = options.serviceName || SERVICE_NAME;
  const taskId = options.taskId || "";
  const dryRun = Boolean(options.dryRun);
  const unitName = taskId
    ? `gptwork-restart-${String(taskId).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : `gptwork-restart-${Date.now()}`;
  const systemctlCmd = `systemctl --user restart ${serviceName}`;

  // Strategy 1: systemd-run --user (preferred, fully detached)
  const systemdRunCmd = `systemd-run --user --on-active=2s --unit=${unitName} ${systemctlCmd}`;
  if (dryRun) {
    return {
      method: "dry-run",
      command: systemdRunCmd,
      scheduled: true,
      output: "dry run: restart not scheduled"
    };
  }
  try {
    const out = execSync(systemdRunCmd, {
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      method: "systemd-run",
      command: systemdRunCmd,
      scheduled: true,
      output: out.trim()
    };
  } catch (e) {
    // systemd-run may not be available, try fallback
  }

  // Strategy 2: disowned background subshell
  const bgCmd = `(sleep 2 && ${systemctlCmd}) >/dev/null 2>&1 &`;
  try {
    const out = execSync(bgCmd, {
      timeout: 5000,
      encoding: "utf8",
      shell: "/bin/sh",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      method: "background-shell",
      command: bgCmd,
      scheduled: true,
      output: out.trim()
    };
  } catch (e2) {
    return {
      method: "failed",
      command: systemctlCmd,
      scheduled: false,
      error: `Cannot schedule detached restart: ${e2.message}`
    };
  }
}

// ---------------------------------------------------------------------------
// High-level schedule_service_restart
// ---------------------------------------------------------------------------

/**
 * Schedule a safe two-phase service restart.
 *
 * Phase A:
 *   1. Writes pending restart marker with expected commit/repo state
 *   2. Appends a task log entry if task state is available
 * Phase B:
 *   3. Schedules detached restart using systemd-run or background shell
 *   4. Returns structured info about the scheduled restart
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} options.taskId
 * @param {string} [options.requestedBy="codex"]
 * @param {string} [options.serviceName="gptwork-mcp.service"]
 * @param {string|null} [options.expectedCommit=null]
 * @param {string|null} [options.expectedRemoteHead=null]
 * @param {string|null} [options.repoPath=null]
 * @param {object} [options.store=null] - optional StateStore to append task log
 * @returns {Promise<object>} structured result
 */
