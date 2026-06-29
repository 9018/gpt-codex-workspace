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
