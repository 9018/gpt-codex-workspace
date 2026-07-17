export function detectTuiTerminalState(input = {}) {
  const missing = [];
  if (!input.resultValid) missing.push("result.json");
  if (!input.testsPresent) missing.push("tests");
  if (!input.gitCollected) missing.push("git");
  if (!input.acceptancePassed) missing.push("acceptance");
  if (input.pendingInteraction) missing.push("pending_interaction");
  return { terminal: missing.length === 0, state: missing.length === 0 ? "completed" : "verifying_terminal", missing };
}
