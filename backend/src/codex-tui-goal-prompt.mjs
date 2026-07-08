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
  return [
    `goal_id=${id}`,
    `task=${title}`,
    "",
    "Use Superpowers for this task.",
    `Read .gptwork/goals/${id}/codex.entry.md before planning or editing.`,
    "",
    "Execution contract:",
    `- Write .gptwork/goals/${id}/result.json`,
    `- Write .gptwork/goals/${id}/result.md`,
    "- Include changed_files, tests, verification, blockers, and commit if any.",
    "- Do not declare completion until verification-before-completion has been performed.",
    "- For non-trivial implementation, use Superpowers planning/TDD/subagent/review workflows.",
    "",
    "When done, print a concise STATUS/SUMMARY/CHANGED_FILES/TESTS/COMMIT report.",
  ].join("\n");
}

export function buildCodexTuiFollowupInstruction({ goalId } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  return [
    `Continue GPTWork goal_id=${id}.`,
    "Use Superpowers.",
    `The entrypoint remains .gptwork/goals/${id}/codex.entry.md.`,
    `The durable result contract remains .gptwork/goals/${id}/result.json and result.md.`,
    "If context was compacted, re-read the entrypoint and continue from the current repository state.",
  ].join("\n");
}

export function buildCodexTuiBootstrapMessages({ goalId, taskTitle } = {}) {
  return [
    `/goal ${buildCodexTuiGoalObjective({ goalId, taskTitle })}\n`,
    `${buildCodexTuiFollowupInstruction({ goalId })}\n`,
  ];
}
