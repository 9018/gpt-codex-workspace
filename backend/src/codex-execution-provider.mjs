export const CODEX_EXECUTION_PROVIDERS = Object.freeze({
  EXEC: "codex_exec",
  TUI_GOAL: "codex_tui_goal",
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


// P0-UA6-G4: Superpowers plugin preflight for TUI fallback.
// When explicit TUI fallback is requested, verify that the Superpowers
// plugin is available.  The check is intentionally simple and synchronous:
// it looks for the superpowers skill directory or MCP tool entry in the
// Codex configuration.  If the plugin is not found, the return object
// includes a clear diagnostic and suggested remediation.

import { existsSync } from 'node:fs';

// P0-UA6-G4: Superpowers plugin preflight for TUI fallback.
// When explicit TUI fallback is requested, verify that the Superpowers
// plugin is available.  The check looks for the superpowers skill
// directory.  If the plugin is not found, a clear diagnostic with
// remediation is returned, and the TUI session must not start
// (codex_exec remains the default fallback provider).
export function checkSuperpowersPluginForTuiFallback(config = {}) {
  const env = process.env || {};
  const codexHome = env.CODEX_HOME || '';
  const requireSuperpowers = config.requireSuperpowersPluginForTuiFallback === true
    || env.GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI === 'true';
  if (!requireSuperpowers) {
    return { available: true, required: false, diagnostic: null };
  }

  // Check for Superpowers plugin by looking for its skill directory
  const pluginPaths = [
    codexHome ? codexHome + '/plugins/superpowers' : null,
    codexHome ? codexHome + '/plugins/cache/openai-curated/superpowers' : null,
    codexHome ? codexHome + '/plugins/cache/openai-api-curated/superpowers' : null,
    '/home/a9017/.codex/plugins/cache/openai-curated/superpowers',
    '/home/a9017/.codex/plugins/cache/openai-api-curated/superpowers',
    '/home/a9017/.codex/skills/superpowers',
  ].filter(Boolean);

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

