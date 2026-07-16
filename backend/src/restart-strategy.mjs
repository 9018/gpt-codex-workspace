/**
 * restart-strategy.mjs — Unified restart strategy abstraction for GPTWork.
 *
 * Defines how GPTWork schedules and performs restarts.
 * Supported modes:
 *   npm       – npm-managed restart (default for this project)
 *   command   – custom restart command
 *   systemd   – systemd user service restart (legacy, only when explicitly set)
 *   none      – manual restart only; no automatic restart
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESTART_MODES = ["npm", "command", "systemd", "none"];

// Defaults for this workspace
export const DEFAULT_RESTART_MODE = "npm";
export const RESTART_SCRIPTS_DIR = "scripts";
export const RESTART_SCRIPT_NAME = "restart-npm-gptwork.sh";
export const DEFAULT_RESTART_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Get the configured restart strategy from runtime config or env.
 *
 * @param {object} [config={}] - Runtime config object with restartMode etc.
 * @returns {{ mode: string, command: string, cwd: string, markerKind: string }}
 */
export function getRestartStrategy(config = {}) {
  const mode = _resolveMode(config);
  const cwd = _resolveCwd(config);
  const command = _resolveCommand(config, mode, cwd);
  const markerKind = _resolveMarkerKind(config);

  const restartModeSource = _source("GPTWORK_RESTART_MODE", config && config.restartMode, DEFAULT_RESTART_MODE);
  const restartCwdSource = _source("GPTWORK_RESTART_CWD", config?.restartCwd, DEFAULT_RESTART_CWD);
  const restartCommandSource = _source("GPTWORK_RESTART_COMMAND", config?.restartCommand, null);
  const restartMarkerKindSource = _source("GPTWORK_RESTART_MARKER_KIND", config?.restartMarkerKind, "npm");

  return { mode, command, cwd, markerKind, sources: {
    restart_mode: restartModeSource,
    restart_cwd: restartCwdSource,
    restart_command: restartCommandSource,
    restart_marker_kind: restartMarkerKindSource,
  }};
}

/**
 * Validate a restart strategy object.
 *
 * @param {{ mode: string, command?: string }} strategy
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRestartStrategy(strategy) {
  if (!strategy || !strategy.mode) {
    return { valid: false, error: "No restart strategy provided" };
  }
  if (!RESTART_MODES.includes(strategy.mode)) {
    return {
      valid: false,
      error: `Invalid restart mode: "${strategy.mode}". Must be one of: ${RESTART_MODES.join(", ")}`
    };
  }
  if (strategy.mode === "command" && !strategy.command) {
    return { valid: false, error: 'Command mode requires a restart command (GPTWORK_RESTART_COMMAND)' };
  }
  return { valid: true };
}

/**
 * Get a human-readable restart instruction for the given strategy.
 *
 * @param {{ mode: string, command?: string, cwd?: string }} strategy
 * @returns {string}
 */
export function getRestartInstruction(strategy) {
  switch (strategy.mode) {
    case "npm":
      return `npm-managed restart: cd "${strategy.cwd}" && npm run start`;
    case "command":
      return `Custom restart command: ${strategy.command}`;
    case "systemd":
      return "systemd user service restart (legacy mode)";
    case "none":
      return `Manual restart required. Start GPTWork with: cd "${strategy.cwd}" && npm run start`;
    default:
      return `Restart mode: ${strategy.mode}`;
  }
}

/**
 * Get a redact-safe summary string for diagnostics (no secrets).
 *
 * @param {{ mode: string, command?: string, cwd?: string }} strategy
 * @returns {object}
 */
export function getRestartSummary(strategy) {
  const summary = {
    restart_mode: strategy.mode,
    restart_marker_kind: strategy.markerKind || "npm",
    restart_cwd: strategy.cwd || "",
    restart_command_summary: "",
    restart_instruction: "",
    restart_strategy_source: (() => {
      const srcs = strategy.sources || {};
      if (srcs.restart_mode === "explicit_config") return "runtime_config";
      if (srcs.restart_mode === "process.env") return "process.env";
      return "default";
    })(),
    restart_mode_source: (strategy.sources && strategy.sources.restart_mode) || "default",
  };

  switch (strategy.mode) {
    case "npm":
      summary.restart_command_summary = "npm run start";
      summary.restart_instruction = `cd "${strategy.cwd}" && npm run start`;
      break;
    case "command":
      summary.restart_command_summary = "<custom> (see GPTWORK_RESTART_COMMAND)";
      summary.restart_instruction = "See GPTWORK_RESTART_COMMAND";
      break;
    case "systemd":
      summary.restart_command_summary = "systemctl --user restart <service>";
      summary.restart_instruction = "systemctl --user restart gptwork-mcp.service";
      break;
    case "none":
      summary.restart_command_summary = "manual";
      summary.restart_instruction = `cd "${strategy.cwd}" && npm run start`;
      break;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Internal resolvers (each reads config -> process.env -> default)
// ---------------------------------------------------------------------------

function _resolveMode(config) {
  const raw = (config && config.restartMode) || process.env.GPTWORK_RESTART_MODE || DEFAULT_RESTART_MODE;
  const mode = String(raw).toLowerCase();
  if (!RESTART_MODES.includes(mode)) {
    console.warn(`[restart-strategy] Unknown restart mode "${mode}", falling back to "${DEFAULT_RESTART_MODE}"`);
    return DEFAULT_RESTART_MODE;
  }
  return mode;
}

function _resolveCwd(config) {
  return (config && config.restartCwd) ||
    process.env.GPTWORK_RESTART_CWD ||
    DEFAULT_RESTART_CWD;
}

function _resolveCommand(config, mode, cwd) {
  if (config && config.restartCommand) return config.restartCommand;
  if (process.env.GPTWORK_RESTART_COMMAND) return process.env.GPTWORK_RESTART_COMMAND;
  // Default npm restart command
  if (mode === "npm") return `npm --prefix "${cwd}" run start`;
  if (mode === "systemd") return `systemctl --user restart gptwork-mcp.service`;
  return "";
}

function _resolveMarkerKind(config) {
  return (config && config.restartMarkerKind) ||
    process.env.GPTWORK_RESTART_MARKER_KIND ||
    "npm";
}

/**
 * Determine the source of a config value.
 * Returns "explicit_config" if set via config object, "process.env" if set via env var, or "default".
 */
function _source(envVar, configValue, defaultValue) {
  if (configValue !== undefined && configValue !== null) {
    return "explicit_config";
  }
  if (process.env[envVar] !== undefined) {
    return "process.env";
  }
  return "default";
}
