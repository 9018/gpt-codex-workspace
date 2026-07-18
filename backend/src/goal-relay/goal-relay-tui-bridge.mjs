/**
 * goal-relay-tui-bridge.mjs — Bridge between Goal Relay and TUI /goal submission.
 *
 * When a repair cycle is started, this module:
 *   1. Creates a new goal via createGoal with repair_of_goal_id
 *   2. Enqueues the goal for execution
 *   3. Submits /goal to a running TUI session via the goal command driver
 *   4. Tracks the successor goal/task/session IDs for evidence
 *
 * @module goal-relay/tui-bridge
 */

import { randomUUID } from "node:crypto";

/**
 * Create the goal relay TUI bridge.
 *
 * @param {object} deps
 * @param {Function} deps.createGoal - Async function to create a goal
 * @param {Function} deps.enqueueGoal - Async function to enqueue a goal
 * @param {Function} [deps.tuiGoalDriver] - TUI goal command driver (submitGoal)
 * @param {Function} [deps.getActiveTuiSession] - Get active TUI session if available
 * @param {Function} [deps.idempotencyStore] - { has(key), mark(key) }
 * @returns {object} { submitSuccessorGoal }
 */
export function createGoalRelayTuiBridge(deps) {
  if (!deps.createGoal) throw new Error("createGoal is required");
  if (!deps.enqueueGoal) throw new Error("enqueueGoal is required");

  /**
   * Submit a successor goal for a repair cycle.
   *
   * This creates a new goal, enqueues it, and optionally submits /goal
   * to a running TUI session.
   *
   * @param {object} options
   * @param {object} options.run - The current execution run
   * @param {object} options.next_goal - The next_goal metadata from relay decision
   * @param {object} options.repair_artifact - The repair artifact for context
   * @param {string} [options.goalPrompt] - Goal prompt text for the successor
   * @returns {Promise<{ goal_id: string, task_id: string|null, tui_session_id: string|null, submitted: boolean, artfact_path: string|null }>}
   */
  async function submitSuccessorGoal({
    run,
    next_goal,
    repair_artifact,
    goalPrompt = "",
  } = {}) {
    if (!next_goal?.idempotency_key) {
      throw new Error("next_goal.idempotency_key is required for idempotency");
    }

    // Check idempotency: was this goal already submitted?
    if (deps.idempotencyStore) {
      const alreadyStarted = await deps.idempotencyStore.has(next_goal.idempotency_key);
      if (alreadyStarted) {
        return {
          goal_id: null,
          task_id: null,
          tui_session_id: null,
          submitted: false,
          artifact_path: repair_artifact?.path || null,
          idempotent: true,
        };
      }
    }

    // Create the goal text from the repair artifact summary
    const artifactSummary = repair_artifact?.summary || goalPrompt || "Continue remaining work from previous iteration.";
    const goalNumber = next_goal?.goal_number || "?";
    const goalText = goalPrompt || `[Repair Cycle ${goalNumber}] ${artifactSummary}`;

    // Build the createGoal payload with repair context
    const createGoalArgs = {
      title: `Repair Cycle ${String(goalNumber).padStart(2, "0")}`,
      goal_prompt: goalText,
      user_request: artifactSummary,
      assign_to_codex: true,
      mode: "full",
      idempotency_key: next_goal.idempotency_key,
      repair_of_goal_id: next_goal.repair_of_goal_id || run?.goal_id || null,
      parent_goal_id: next_goal.parent_goal_id || run?.goal_id || null,
      root_goal_id: next_goal.root_goal_id || run?.supervision?.goal_relay?.root_goal_id || run?.goal_id || null,
    };

    // Create the goal
    const { goal } = await deps.createGoal(createGoalArgs);

    // Enqueue the goal for execution
    let enqueueResult = { ok: false, item: null, warnings: [] };
    try {
      enqueueResult = await deps.enqueueGoal(goal.id, {
        auto_start: true,
        depends_on_goal_id: next_goal.repair_of_goal_id || run?.goal_id || null,
      });
    } catch (err) {
      // Non-fatal: goal is created even if enqueue fails
      enqueueResult = { ok: false, item: null, warnings: [`Enqueue failed: ${err.message}`] };
    }

    // Mark idempotency
    if (deps.idempotencyStore) {
      await deps.idempotencyStore.mark(next_goal.idempotency_key);
    }

    // Submit /goal via TUI if a session is active
    let tuiSessionId = null;
    let submitted = false;

    if (deps.tuiGoalDriver && deps.getActiveTuiSession) {
      try {
        const activeSession = await deps.getActiveTuiSession(run);
        if (activeSession?.sessionId) {
          tuiSessionId = activeSession.sessionId;
          const result = await deps.tuiGoalDriver.submitGoal({
            goalText,
            idempotencyKey: next_goal.idempotency_key,
          });
          submitted = result.ok || result.idempotent === true;
        }
      } catch (err) {
        // TUI submission is non-fatal (the goal is already created)
        console.warn(`[goal-relay-tui-bridge] TUI goal submission failed: ${err.message}`);
      }
    }

    return {
      goal_id: goal.id,
      task_id: enqueueResult.item?.task_id || goal.task_id || null,
      tui_session_id: tuiSessionId,
      submitted,
      artifact_path: repair_artifact?.path || null,
      idempotent: false,
    };
  }

  return { submitSuccessorGoal };
}

/**
 * Build a human-readable /goal prompt from a repair artifact.
 *
 * @param {object} options
 * @param {object} options.repair_artifact
 * @param {number} options.goal_number
 * @param {string} options.summary
 * @returns {string} Goal prompt text
 */
export function buildGoalPromptFromRepairArtifact({ repair_artifact, goal_number, summary } = {}) {
  const lines = [
    `# Repair Cycle ${goal_number}: Remaining Work`,
    "",
    summary || repair_artifact?.summary || "Continue remaining work.",
    "",
    "## Context",
    "",
    `Previous goal completed with remaining work.`,
    repair_artifact?.path ? `See ${repair_artifact.path} for the full repair plan.` : "",
    "",
    "## Requirements",
    "",
    "- Complete the objectives documented in the repair artifact.",
    "- Verify all changes work correctly.",
    "- No regression to already-completed functionality.",
    "",
  ];

  return lines.filter(Boolean).join("\n");
}
