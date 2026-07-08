/**
 * claude-tui-goal-prompt.mjs — Claude Code TUI goal bootstrap prompt builders.
 *
 * Claude Code does not have a built-in `/goal` slash command like Codex does.
 * Instead, this module preserves /goal-style semantics by constructing an
 * explicit goal-mode instruction that:
 *   - Starts with an explicit `goal_id=` and `task=` line (like Codex's /goal)
 *   - Instructs Claude to read a provider-specific entry file
 *   - Follows the exact execution contract: bounded entrypoint → result.json/result.md
 *
 * The product behavior is: goal_id + bounded entrypoint + exact execution contract.
 */

const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trim()}...`;
}

/**
 * Build the initial goal-mode objective string for Claude Code.
 * This replaces the `/goal ...` command that Codex uses; Claude receives
 * the same structured goal information as the first message.
 *
 * Claude is instructed to read `.gptwork/goals/<goalId>/claude.entry.md`
 * (with fallback to codex.entry.md if claude.entry.md does not exist).
 *
 * @param {object} options
 * @param {string} options.goalId - Goal ID
 * @param {string} [options.taskTitle] - Task title
 * @param {string} [options.entryFile] - Optional override for the entry file name
 * @returns {string} Goal objective text
 */
export function buildClaudeTuiGoalObjective({ goalId, taskTitle, entryFile } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const title = compactText(taskTitle || "Claude Code TUI goal", 260);
  const entry = entryFile || `claude.entry.md (or codex.entry.md as fallback)`;
  const objective = [
    `goal_mode active | goal_id=${id}`,
    `task=${title}`,
    `Read .gptwork/goals/${id}/${entry} first.`,
    `Execute that bounded entrypoint exactly, then write .gptwork/goals/${id}/result.json and result.md.`,
    `Report the final STATUS, SUMMARY, CHANGED_FILES, TESTS, COMMIT, and REMOTE_HEAD.`,
  ].join(" | ");
  return objective.length < MAX_GOAL_OBJECTIVE_CHARS ? objective : objective.slice(0, MAX_GOAL_OBJECTIVE_CHARS - 1);
}

/**
 * Build the follow-up instruction sent after the initial goal objective.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal ID
 * @param {string} [options.entryFile] - Optional override for entry file name
 * @returns {string} Follow-up instruction text
 */
export function buildClaudeTuiFollowupInstruction({ goalId, entryFile } = {}) {
  const id = String(goalId || "").trim();
  if (!id) throw new Error("goalId is required");
  const entry = entryFile || "claude.entry.md (or codex.entry.md)";
  return [
    `Continue goal_id=${id}.`,
    `Before planning or editing, read .gptwork/goals/${id}/${entry} and follow its execution contract.`,
    `Write .gptwork/goals/${id}/result.json and result.md when complete.`,
    `Commit all changes, verify tests pass, and report the commit hash.`,
  ].join(" ");
}

/**
 * Build the two bootstrap messages for a Claude TUI goal session.
 *
 * Unlike Codex's /goal command, Claude does not have a built-in /goal handler.
 * The first message is the structured goal objective (goal_id + task + execution contract).
 * The second message is the follow-up instruction.
 *
 * @param {object} options
 * @param {string} options.goalId - Goal ID
 * @param {string} [options.taskTitle] - Task title
 * @param {string} [options.entryFile] - Optional override for entry file name
 * @returns {string[]} Array of two message strings to send to the PTY
 */
export function buildClaudeTuiBootstrapMessages({ goalId, taskTitle, entryFile } = {}) {
  return [
    `${buildClaudeTuiGoalObjective({ goalId, taskTitle, entryFile })}\n`,
    `${buildClaudeTuiFollowupInstruction({ goalId, entryFile })}\n`,
  ];
}
