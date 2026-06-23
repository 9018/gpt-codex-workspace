import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_NAME } from "./safe-restart-marker-store.mjs";
import { getRestartStrategy, getRestartInstruction } from "./restart-strategy.mjs";

// ---------------------------------------------------------------------------
// scheduleDetachedRestart — schedule a detached restart via configured strategy
// ---------------------------------------------------------------------------

/**
 * Schedule a detached GPTWork restart using the configured restart strategy.
 *
 * Supported modes (from restart mode config):
 *   npm       – spawn detached npm run start (default)
 *   command   – spawn a custom restart command
 *   systemd   – legacy systemd user service restart (only when explicitly set)
 *   none      – return manual restart instructions only
 *
 * @param {object} options
 * @param {string} [options.serviceName=SERVICE_NAME]
 * @param {string} [options.taskId=""]
 * @param {boolean} [options.dryRun=false]
 * @param {object|null} [options.strategy=null] - explicit restart strategy override
 * @returns {{ method: string, command: string, scheduled: boolean, output?: string, error?: string, restart_mode?: string }}
 */
export function scheduleDetachedRestart(options = {}) {
  const {
    serviceName = SERVICE_NAME,
    taskId = "",
    dryRun = false,
    strategy = null,
  } = options;

  // Resolve restart strategy: explicit override or from config/env
  const restartStrategy = strategy || getRestartStrategy();
  const { mode, command, cwd } = restartStrategy;

  if (dryRun) {
    return {
      method: "dry-run",
      command: getRestartInstruction(restartStrategy),
      scheduled: true,
      output: `dry run: would use ${mode} restart strategy`,
      restart_mode: mode,
    };
  }

  switch (mode) {

    // -----------------------------------------------------------------------
    // npm mode – detached npm run start via script or nohup
    // -----------------------------------------------------------------------
    case "npm": {
      // Try restart script first, fall back to inline nohup
      const scriptPath = join(cwd || "", "scripts/restart-npm-gptwork.sh");
      const parentDir = cwd ? join(cwd, "..") : "/home/a9017/mcp/workspace/gpt-codex-workspace";
      const logDir = join(parentDir, ".gptwork/logs");
      mkdirSync(logDir, { recursive: true });

      const logFile = join(logDir, "gptwork-npm-restart.log");
      const oldPid = process.pid;

      let cmd;
      if (existsSync(scriptPath)) {
        cmd = `nohup bash "${scriptPath}" --cwd "${cwd}" --pid ${oldPid} --log "${logFile}" >/dev/null 2>&1 &`;
      } else {
        cmd = `(sleep 3 && kill ${oldPid} 2>/dev/null; sleep 1; cd "${cwd}" && nohup ${command} >> "${logFile}" 2>&1 &) >/dev/null 2>&1 &`;
      }

      try {
        execSync(cmd, {
          timeout: 5000,
          encoding: "utf8",
          shell: "/bin/bash",
          stdio: ["ignore", "pipe", "pipe"]
        });
        return {
          method: "npm-detached",
          command: getRestartInstruction(restartStrategy),
          scheduled: true,
          output: `npm restart scheduled (cwd: ${cwd}, log: ${logFile})`,
          restart_mode: mode,
          old_pid: oldPid,
        };
      } catch (e) {
        return {
          method: "npm-failed",
          command: getRestartInstruction(restartStrategy),
          scheduled: false,
          error: `Cannot schedule npm restart: ${e.message}`,
          restart_mode: mode,
          old_pid: oldPid,
        };
      }
    }

    // -----------------------------------------------------------------------
    // command mode – custom restart command
    // -----------------------------------------------------------------------
    case "command": {
      try {
        const cmd = `nohup ${command} >/dev/null 2>&1 &`;
        execSync(cmd, {
          timeout: 5000,
          encoding: "utf8",
          shell: "/bin/bash",
          stdio: ["ignore", "pipe", "pipe"]
        });
        return {
          method: "command-detached",
          command: getRestartInstruction(restartStrategy),
          scheduled: true,
          output: "Custom restart command scheduled",
          restart_mode: mode,
        };
      } catch (e) {
        return {
          method: "command-failed",
          command: getRestartInstruction(restartStrategy),
          scheduled: false,
          error: `Cannot schedule custom restart: ${e.message}`,
          restart_mode: mode,
        };
      }
    }

    // -----------------------------------------------------------------------
    // systemd mode – legacy systemd user service restart
    // -----------------------------------------------------------------------
    case "systemd": {
      const unitName = taskId
        ? `gptwork-restart-${String(taskId).replace(/[^a-zA-Z0-9_-]/g, "_")}`
        : `gptwork-restart-${Date.now()}`;
      const systemctlCmd = `systemctl --user restart ${serviceName}`;

      // Strategy 1: systemd-run --user (preferred, fully detached)
      const systemdRunCmd = `systemd-run --user --on-active=2s --unit=${unitName} ${systemctlCmd}`;
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
          output: out.trim(),
          restart_mode: mode,
        };
      } catch (e) {
        // systemd-run not available, try fallback
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
          command: systemctlCmd,
          scheduled: true,
          output: out.trim(),
          restart_mode: mode,
        };
      } catch (e2) {
        return {
          method: "failed",
          command: systemctlCmd,
          scheduled: false,
          error: `Cannot schedule detached restart: ${e2.message}`,
          restart_mode: mode,
        };
      }
    }

    // -----------------------------------------------------------------------
    // none mode – manual restart only
    // -----------------------------------------------------------------------
    case "none":
    default:
      return {
        method: "manual-restart-required",
        command: getRestartInstruction(restartStrategy),
        scheduled: false,
        manual_restart_required: true,
        restart_mode: mode,
        instruction: "cd /home/a9017/mcp/workspace/gpt-codex-workspace/backend && npm run start",
      };
  }
}
