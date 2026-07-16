import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_EXECUTION_PROVIDERS = Object.freeze({
  EXEC: "codex_exec",
  TUI_GOAL: "codex_tui_goal",
});

export const AGENT_TUI_PROVIDERS = Object.freeze({
  CODEX: "codex_tui_goal",
  CLAUDE: "claude_tui_goal",
});

export function normalizeCodexExecutionProvider(value) {
  const provider = String(value || "").trim();
  if (provider === CODEX_EXECUTION_PROVIDERS.TUI_GOAL) return CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
  return CODEX_EXECUTION_PROVIDERS.EXEC;
}

export function taskUsesCodexTuiGoal(task) {
  const provider = task?.metadata?.codex_execution_provider;
  return String(provider || "").trim() === CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
}

export function isCodexTuiEnabled(config = {}, env = process.env) {
  const explicit = config.codexTuiEnabled ?? config.codex_tui_enabled ?? env.GPTWORK_CODEX_TUI_ENABLED;
  return String(explicit || "").trim().toLowerCase() === "true";
}

export function isClaudeTuiEnabled(config = {}, env = process.env) {
  const explicit = config.claudeTuiEnabled ?? config.claude_tui_enabled ?? env.GPTWORK_CLAUDE_TUI_ENABLED;
  return String(explicit || "").trim().toLowerCase() === "true";
}

export function getClaudeTuiConfig(config = {}, env = process.env) {
  const command = config.claudeTuiCommand || env.GPTWORK_CLAUDE_TUI_COMMAND || "claude";
  return { command };
}

// ---------------------------------------------------------------------------
// Codex execution provider mode descriptions for diagnostics and docs.
// These make it unambiguous in runtime_status / doctor output which provider
// is the default production path and which is the manual operator fallback.
// ---------------------------------------------------------------------------

/**
 * Describe the execution provider mode in a human-readable form.
 * Explicitly labels codex_exec as the default production path and
 * codex_tui_goal as the manual operator fallback.
 *
 * @param {string} provider - Provider identifier (codex_exec or codex_tui_goal)
 * @returns {{ id: string, label: string, is_default: boolean, is_manual_fallback: boolean, description: string }}
 */
export function describeCodexExecutionProvider(provider) {
  const p = normalizeCodexExecutionProvider(provider);
  if (p === CODEX_EXECUTION_PROVIDERS.TUI_GOAL) {
    return {
      id: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
      label: "codex_tui_goal (manual operator fallback)",
      is_default: false,
      is_manual_fallback: true,
      description: "Codex TUI interactive mode. This is a MANUAL OPERATOR FALLBACK, not an automatic execution path. The operator works interactively in a terminal session and must collect durable evidence (commit, tests, result.md) to enter the acceptance/verification closure loop."
    };
  }
  return {
    id: CODEX_EXECUTION_PROVIDERS.EXEC,
    label: "codex_exec (default automatic production path)",
    is_default: true,
    is_manual_fallback: false,
    description: "Codex exec automatic mode. This is the DEFAULT production execution path. Codex runs autonomously via CLI, produces structured result contracts, verification evidence, and commits. All tasks default to this provider unless explicitly configured to codex_tui_goal."
  };
}

/**
 * Get the execution provider mode for a task, with fallback to the default.
 * This is used by diagnostics to explain why a task is using a particular provider.
 *
 * @param {object} task - Task object with optional metadata.codex_execution_provider
 * @returns {{ provider: string, description: string }}
 */
export function getTaskExecutionProviderMode(task = {}) {
  const raw = task?.metadata?.codex_execution_provider;
  const provider = normalizeCodexExecutionProvider(raw);
  const desc = describeCodexExecutionProvider(provider);
  return {
    provider,
    explicit: raw === CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    is_default: desc.is_default,
    is_manual_fallback: desc.is_manual_fallback,
    description: desc.description,
  };
}


// P0-UA6-G4: Superpowers plugin preflight for TUI fallback.
// When explicit TUI fallback is requested, verify that the Superpowers
// plugin is available.  The check is intentionally simple and synchronous:
// it looks for the superpowers skill directory or MCP tool entry in the
// Codex configuration.  If the plugin is not found, the return object
// includes a clear diagnostic and suggested remediation.

// P0-UA6-G4: Superpowers plugin preflight for TUI fallback.
// When explicit TUI fallback is requested, verify that the Superpowers
// plugin is available.  The check looks for the superpowers skill
// directory.  If the plugin is not found, a clear diagnostic with
// remediation is returned, and the TUI session must not start
// (codex_exec remains the default fallback provider).
export function checkSuperpowersPluginForTuiFallback(config = {}, env = process.env) {
  const requireSuperpowers = config.requireSuperpowersPluginForTuiFallback === true
    || env.GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI === 'true';
  if (!requireSuperpowers) {
    return { available: true, required: false, diagnostic: null };
  }

  // Check for Superpowers plugin by looking for its skill directory
  const codexHomes = [...new Set([
    config.codexHome,
    env.CODEX_HOME,
    join(homedir(), ".codex"),
  ].filter(Boolean))];
  const pluginPaths = codexHomes.flatMap((codexHome) => [
    join(codexHome, "plugins", "superpowers"),
    join(codexHome, "plugins", "cache", "openai-curated", "superpowers"),
    join(codexHome, "plugins", "cache", "openai-api-curated", "superpowers"),
    join(codexHome, "skills", "superpowers"),
  ]);

  let found = false;
  for (const p of pluginPaths) {
    try {
      if (existsSync(p)) { found = true; break; }
    } catch { /* non-blocking */ }
  }

  if (found) {
    return { available: true, required: true, diagnostic: null };
  }

  return {
    available: false,
    required: true,
    diagnostic: {
      code: 'superpowers_plugin_missing',
      message: 'TUI fallback requires the Superpowers plugin but it is not installed.',
      remediation: 'Install the Superpowers plugin via: codex --install-plugin superpowers, or disable the check with GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=false.',
    },
  };
}
