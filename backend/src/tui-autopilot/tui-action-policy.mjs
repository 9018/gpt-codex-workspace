import { decideTuiConfirmation } from "./tui-confirmation-policy.mjs";

export function decideTuiAction({ state, frame = {}, allowedRoots = [], remainingAcceptance = [], actionAttempts = 0, maxActions = 100 } = {}) {
  if (actionAttempts >= maxActions) return { type: "checkpoint_supervisor", reason_code: "autopilot_action_budget_exhausted" };
  if (state === "awaiting_confirmation") {
    const decision = decideTuiConfirmation(frame, { allowedRoots });
    return { type: "send_input", input: decision.input, reason_code: decision.reason_code, followup: decision.alternative_instruction };
  }
  if (state === "awaiting_choice") {
    const option = (frame.selectable_options || []).find((item) => /continue|proceed|yes|allow/i.test(item.label)) || frame.selectable_options?.[0];
    return option
      ? { type: "send_input", input: `${option.index}\r`, reason_code: "policy_choice_continue" }
      : { type: "checkpoint_supervisor", reason_code: "choice_without_options" };
  }
  if (state === "ready_for_instruction" || state === "awaiting_more_input") {
    const missing = remainingAcceptance.length > 0 ? remainingAcceptance.join(", ") : "durable result.json and verification evidence";
    return { type: "send_input", input: `The task is not complete. Missing: ${missing}. Continue autonomously, verify the work, write the required artifacts, and do not wait for human input.\r`, reason_code: "continue_missing_acceptance" };
  }
  if (state === "unclassified") return { type: "observe", reason_code: "await_stable_frame" };
  return { type: "observe", reason_code: "execution_in_progress" };
}
