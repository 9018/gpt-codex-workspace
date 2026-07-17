export const TUI_SCREEN_SEQUENCES = Object.freeze({
  confirmationThenCompletion: Object.freeze([
    "Run npm test in /workspace/repo? (y/n)",
    "Running tests...",
    "STATUS=completed\nSUMMARY=All acceptance checks passed",
  ]),
  repeatedConfirmationLoop: Object.freeze([
    "Run command? (y/n)",
    "Run command? (y/n)",
    "Run command? (y/n)",
  ]),
  promptWithoutCompletion: Object.freeze([
    "Working...",
    "› ",
  ]),
  resumableDisconnect: Object.freeze([
    "Working in native session session_1...",
    "[PTY disconnected]",
    "Resume session session_1?",
  ]),
});

export function fakeTuiScreenSequence(name) {
  const sequence = TUI_SCREEN_SEQUENCES[name];
  if (!sequence) throw new Error(`unknown fake TUI screen sequence: ${name}`);
  return [...sequence];
}
