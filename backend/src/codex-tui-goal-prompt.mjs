/**
 * codex-tui-goal-prompt.mjs — Goal objective and follow-up prompt builders.
 *
 * Generates the structured prompt that instructs the Codex TUI session
 * about its execution contract, including the subagent pipeline phases,
 * progress write paths, and completion report format.
 *
 * Pipeline (parent TUI fixed order):
 *   context_curator → [explorer|architect|test_analyst parallel] → planner
 *   → builder → verifier → reviewer → repairer (≤2 rounds) → finalizer
 *
 * Progress files (no ANSI parsing needed):
 *   .gptwork/goals/<goal_id>/progress.json
 *   .gptwork/goals/<goal_id>/subagents.json
 */

const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trim()}...`;
}

/**
 * Build the subagent pipeline phase instruction block.
 * Injected into the goal objective so ChatGPT understands the fixed pipeline.
 *
 * @param {string} goalId - Goal identifier
 * @returns {string} Pipeline instructions
 */
export function buildPipelinePhaseInstruction({ goalId } = {}) {
  const id = String(goalId || "").trim() || "<goal_id>";
  return [
    "Subagent pipeline (parent TUI fixed):",
    "  1. context_curator (context bundle preparation)",
    "  2. explorer + architect + test_analyst (parallel analysis phase)",
    "  3. planner (single)",
    "  4. builder (single implementation agent)",
    "  5. verifier (single verification agent)",
    "  6. reviewer (single review agent)",
    "  7. repairer (up to 2 rounds, only on failure)",
    "  8. finalizer (single closure agent)",
    "",
    "Progress is written atomically to:",
    `  .gptwork/goals/${id}/progress.json`,
    `  .gptwork/goals/${id}/subagents.json`,
    "",
    "codex_tui_progress and codex_tui_subagents MCP tools",
    "return structured progress without ANSI screen parsing.",
    "",
    "Each subagent result includes:",
    "  role, status, summary, changed_files, artifacts, blockers, started_at, completed_at.",
  ].join("\n");
}

/**
 * Build the goal objective prompt for a Codex TUI session.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal identifier (required)
 * @param {string} [options.taskTitle] - Task title
 * @param {boolean} [options.includePipeline] - Include subagent pipeline instructions (default: true)
 * @returns {string} Goal objective text
 */
export function buildCodexTuiGoalObjective({ goalId, taskTitle, includePipeline = true } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const title = compactText(taskTitle || "Codex TUI goal", 260);

  const parts = [
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
  ];

  if (includePipeline) {
    parts.push("", buildPipelinePhaseInstruction({ goalId: id }));
  }

  parts.push("",
    "When done, print a concise STATUS/SUMMARY/CHANGED_FILES/TESTS/COMMIT report.",
  );

  return parts.join("\n");
}

/**
 * Build the follow-up instruction for resuming a Codex TUI session.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal identifier (required)
 * @returns {string} Follow-up instruction text
 */
export function buildCodexTuiFollowupInstruction({ goalId } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  return [
    `Continue GPTWork goal_id=${id}.`,
    "Use Superpowers.",
    `The entrypoint remains .gptwork/goals/${id}/codex.entry.md.`,
    `The durable result contract remains .gptwork/goals/${id}/result.json and result.md.`,
    "",
    "Progress tracking:",
    `  .gptwork/goals/${id}/progress.json`,
    `  .gptwork/goals/${id}/subagents.json`,
    "  codex_tui_progress, codex_tui_subagents MCP tools (no ANSI parsing).",
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
    `${buildCodexTuiFollowupInstruction({ goalId })}\r`,
  ];
}
