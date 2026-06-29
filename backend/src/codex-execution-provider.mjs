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
  return normalizeCodexExecutionProvider(provider) === CODEX_EXECUTION_PROVIDERS.TUI_GOAL;
}
