const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trim()}...`;
}

export function buildCodexTuiGoalObjective({ goalId, taskTitle } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const title = compactText(taskTitle || "Codex TUI goal", 260);
  const objective = [
    `goal_id=${id}`,
    `task=${title}`,
    `Read .gptwork/goals/${id}/codex.entry.md first. Execute that bounded entrypoint exactly, write result.json/result.md, and print the legacy STATUS/SUMMARY/CHANGED_FILES/TESTS/COMMIT/REMOTE_HEAD report.`,
  ].join(" | ");
  return objective.length < MAX_GOAL_OBJECTIVE_CHARS ? objective : objective.slice(0, MAX_GOAL_OBJECTIVE_CHARS - 1);
}

export function buildCodexTuiFollowupInstruction({ goalId } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  return [
    `Continue goal_id=${id}.`,
    `Before planning or editing, read .gptwork/goals/${id}/codex.entry.md and follow its execution contract.`,
    `Write .gptwork/goals/${id}/result.json and result.md when complete.`,
  ].join(" ");
}

export function buildCodexTuiBootstrapMessages({ goalId, taskTitle } = {}) {
  return [
    `/goal ${buildCodexTuiGoalObjective({ goalId, taskTitle })}\n`,
    `${buildCodexTuiFollowupInstruction({ goalId })}\n`,
  ];
}
