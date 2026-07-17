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
  if (!provider) return CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
  if (provider === CODEX_EXECUTION_PROVIDERS.EXEC) return CODEX_EXECUTION_PROVIDERS.EXEC;
  if (provider === CODEX_EXECUTION_PROVIDERS.TUI_GOAL) return CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
  if (provider === "codex_tui") return CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
  return CODEX_EXECUTION_PROVIDERS.EXEC;
}

export function taskUsesCodexTuiGoal(task) {
  return normalizeCodexExecutionProvider(task?.metadata?.codex_execution_provider) === CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
}

export function taskExplicitlyUsesCodexTuiGoal(task) {
  const provider = String(task?.metadata?.codex_execution_provider || "").trim();
  return provider === CODEX_EXECUTION_PROVIDERS.TUI_GOAL || provider === "codex_tui";
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
// is the default autonomous path and which is the typed availability fallback.
// ---------------------------------------------------------------------------

/**
 * Describe the execution provider mode in a human-readable form.
 * @param {string} provider - Provider identifier (codex_exec or codex_tui_goal)
 * @returns {{ id: string, label: string, is_default: boolean, is_manual_fallback: boolean, description: string }}
 */
export function describeCodexExecutionProvider(provider) {
  const p = normalizeCodexExecutionProvider(provider);
  if (p === CODEX_EXECUTION_PROVIDERS.TUI_GOAL) {
    return {
      id: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
      label: "codex_tui_goal (default autonomous provider)",
      is_default: true,
      is_manual_fallback: false,
      is_availability_fallback: false,
      description: "Codex TUI autonomous mode. This is the default execution path: WorkMCP drives instructions, confirmations, choices, continuation, evidence collection, repair, and resume without routine human input."
    };
  }
  return {
    id: CODEX_EXECUTION_PROVIDERS.EXEC,
    label: "codex_exec (typed availability fallback)",
    is_default: false,
    is_manual_fallback: false,
    is_availability_fallback: true,
    description: "Codex exec automatic mode. It is selected explicitly or used only when the native TUI provider is typed as unavailable; prompt loops, missing evidence, and ordinary execution failures do not authorize this fallback."
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
    explicit: typeof raw === "string" && raw.trim().length > 0,
    is_default: desc.is_default,
    is_manual_fallback: desc.is_manual_fallback,
    is_availability_fallback: desc.is_availability_fallback === true,
    description: desc.description,
  };
}


// Compatibility-named preflight for the autonomous TUI provider.
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
