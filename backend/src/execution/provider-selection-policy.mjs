const PROVIDERS = ["codex_exec", "codex_tui"];

export async function selectExecutionProvider({ policy = {}, task = {}, availability = {}, history = {} } = {}) {
  const requested = policy.provider || "auto";
  if (requested !== "auto") {
    if (!PROVIDERS.includes(requested)) throw new Error(`unknown execution provider: ${requested}`);
    if (!availability[requested]) throw new Error(`execution provider unavailable: ${requested}`);
    return { provider: requested, reason_code: "explicit_provider", scores: null };
  }

  if (availability.codex_tui) {
    return { provider: "codex_tui", reason_code: "auto_tui_first", scores: null };
  }
  if (availability.codex_exec) {
    return { provider: "codex_exec", reason_code: "auto_tui_unavailable", scores: null };
  }
  throw new Error("no execution provider available");
}
