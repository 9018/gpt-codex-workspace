export const TUI_AUTOPILOT_STATES = Object.freeze([
  "created", "starting", "waiting_first_frame", "classifying",
  "ready_for_instruction", "executing", "awaiting_confirmation",
  "awaiting_choice", "awaiting_more_input", "collecting_result",
  "verifying_terminal", "recovering", "completed", "failed", "timed_out",
  "unclassified",
]);

export function isTuiAutopilotState(value) {
  return TUI_AUTOPILOT_STATES.includes(String(value || ""));
}
