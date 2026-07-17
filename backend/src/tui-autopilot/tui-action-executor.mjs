export async function executeTuiAction(action = {}, { writeInput, interrupt, resume } = {}) {
  if (action.type === "send_input") {
    await writeInput?.(action.input);
    if (action.followup) await writeInput?.(action.followup);
    return { executed: true, type: action.type };
  }
  if (action.type === "interrupt") { await interrupt?.(); return { executed: true, type: action.type }; }
  if (action.type === "resume") { await resume?.(); return { executed: true, type: action.type }; }
  return { executed: false, type: action.type || "observe" };
}
