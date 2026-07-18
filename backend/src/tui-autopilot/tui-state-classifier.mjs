export function classifyTuiState(frame = {}, { resultJsonPresent = false } = {}) {
  const normalizedText = String(frame.normalized_text || "");
  if (/sign in with chatgpt|login server error|log in with device code|authentication required/i.test(normalizedText)) {
    return { state: "authentication_required", confidence: 1, reason_code: "codex_authentication_required" };
  }
  if (resultJsonPresent && (frame.prompt_markers || []).length > 0) return { state: "collecting_result", confidence: 1, reason_code: "result_present_prompt_returned" };
  if ((frame.confirmation_markers || []).length > 0) return { state: "awaiting_confirmation", confidence: 1, reason_code: "confirmation_prompt" };
  if ((frame.selectable_options || []).length > 0) return { state: "awaiting_choice", confidence: 1, reason_code: "choice_list" };
  if ((frame.progress_markers || []).length > 0) return { state: "executing", confidence: 0.95, reason_code: "semantic_progress" };
  if ((frame.prompt_markers || []).length > 0) return { state: "ready_for_instruction", confidence: 0.95, reason_code: "prompt_returned" };
  if ((frame.error_markers || []).length > 0) return { state: "awaiting_more_input", confidence: 0.8, reason_code: "recoverable_error" };
  return { state: "unclassified", confidence: 0, reason_code: "deterministic_rules_exhausted" };
}
