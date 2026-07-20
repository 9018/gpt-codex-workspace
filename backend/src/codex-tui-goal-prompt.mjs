/**
 * codex-tui-goal-prompt.mjs — Goal objective and follow-up prompt builders.
 *
 * The bootstrap prompt is intentionally entry-first and minimal. Detailed task
 * context and execution constraints belong in codex.entry.md. Subagents are
 * optional and should only be used when they materially help the task.
 */

const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trim()}...`;
}

function buildIncrementalResultInstructions(dir) {
  const partial = `${dir}/result.partial.json`;
  const final = `${dir}/result.json`;
  return [
    `Maintain ${partial} at key stages: started -> code_changed -> testing -> finished.`,
    "Update only after a meaningful stage transition; do not rewrite it for every command.",
    "Each update must include status, phase, summary, updated_at, changed_files, and known command results.",
    `When finished, write the complete final payload to ${partial}, then atomically rename it to ${final}.`,
    "Do not treat the partial file as completion; only the final result is a completion candidate and GPTWork will independently verify it.",
  ];
}

/**
 * Build the goal objective prompt for a Codex TUI session.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal identifier (required)
 * @param {string} [options.taskTitle] - Task title
 * @param {string} [options.goalDir] - Durable goal directory
 * @returns {string} Goal objective text
 */
export function buildCodexTuiGoalObjective({ goalId, taskTitle, goalDir = null } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const title = compactText(taskTitle || "Codex TUI goal", 260);
  const dir = String(goalDir || `.gptwork/goals/${id}`).replace(/\/$/, "");

  return [
    `task=${title}`,
    `goal_id=${id}`,
    "",
    "Use Superpowers.",
    `Read ${dir}/codex.entry.md and execute it autonomously.`,
    "Decide whether subagents materially help. Handle simple work directly; for complex work you may start subagents, while this parent TUI session remains responsible for integration, verification, and the final result.",
    "Verify before completion.",
    ...buildIncrementalResultInstructions(dir),
    `Write ${dir}/result.md when finished.`,
    "",
    "When done, print a concise STATUS/SUMMARY/CHANGED_FILES/TESTS/COMMIT report.",
  ].join("\n");
}

/**
 * Build the follow-up instruction for resuming a Codex TUI session.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal identifier (required)
 * @returns {string} Follow-up instruction text
 */
export function buildCodexTuiFollowupInstruction({ goalId, goalDir = null } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const dir = String(goalDir || `.gptwork/goals/${id}`).replace(/\/$/, "");
  return [
    `Continue GPTWork goal_id=${id}.`,
    "Use Superpowers.",
    `The entrypoint remains ${dir}/codex.entry.md.`,
    ...buildIncrementalResultInstructions(dir),
    `The durable final result contract remains ${dir}/result.json and result.md.`,
    "Decide whether subagents materially help. Handle simple work directly; for complex work you may start subagents, while this parent TUI session remains responsible for integration, verification, and the final result.",
    "Verify before completion.",
    "",
    "If context was compacted, re-read the entrypoint and continue from the current repository state.",
  ].join("\n");
}

/**
 * Build the two bootstrap messages (goal + follow-up) for a new Codex TUI session.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal identifier (required)
 * @param {string} [options.taskTitle] - Task title
 * @returns {string[]} Array of two message strings
 */
export function buildCodexTuiBootstrapMessages({ goalId, taskTitle } = {}) {
  return [
    `/goal ${buildCodexTuiGoalObjective({ goalId, taskTitle })}\r`,
  ];
}
