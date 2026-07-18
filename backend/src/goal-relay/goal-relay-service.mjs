/**
 * goal-relay-service.mjs — Goal relay decision and orchestration.
 *
 * Core service that decides what to do when a goal completes:
 *   1. If remaining_work=false → terminal evaluation
 *   2. If remaining_work=true  → create repair artifact + start new goal cycle
 *
 * Prevents duplicate cycles via idempotency keys tied to the review revision.
 * Embedding: ExecutionRun.supervision.goal_relay (no separate run store).
 *
 * @module goal-relay/service
 */

import crypto from "node:crypto";
import {
  GOAL_RELAY_PHASES,
  RELAY_DECISIONS,
  GOAL_CYCLE_IDEMPOTENCY_PREFIX,
  createGoalRelayState,
} from "./goal-relay-schema.mjs";

/**
 * Create the goal relay service.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store (readRun, updateRun)
 * @param {object} [deps.goalQueueService] - Goal queue service (enqueueGoal)
 * @param {object} [deps.repairArtifactWriter] - { write({ run, summary }) → path }
 * @param {object} [deps.cycleIdempotencyStore] - { has(key), mark(key) }
 * @returns {object} Goal relay service API
 */
export function createGoalRelayService(deps) {
  if (!deps.runStore) throw new Error("runStore is required");

  /**
   * Ensure the run has a goal_relay state initialized.
   *
   * @param {object} run
   * @returns {object} run with goal_relay state
   */
  function ensureRelayState(run) {
    if (!run.supervision) {
      run.supervision = {};
    }
    if (!run.supervision.goal_relay) {
      run.supervision.goal_relay = createGoalRelayState({
        root_goal_id: run.goal_id,
      });
    }
    return run;
  }

  /**
   * Evaluate goal completion and decide next action.
   *
   * @param {object} options
   * @param {object} options.run - ExecutionRun
   * @param {object} options.evidence - Collected evidence
   * @param {boolean} [options.remaining_work] - Whether remaining work exists
   *   (in production, this comes from ChatGPT's terminal evaluation).
   *   Default: false.
   * @param {string} [options.failure_summary] - Summary of what remains
   * @returns {Promise<{ decision: string, repair_artifact?: object, next_goal?: object }>}
   */
  async function evaluateGoalCompletion({
    run,
    evidence = {},
    remaining_work = false,
    failure_summary = "",
  } = {}) {
    run = ensureRelayState(run);
    const relay = run.supervision.goal_relay;

    const now = new Date().toISOString();

    // Check cycle budget
    if (relay.cycles_completed >= relay.max_cycles) {
      return {
        decision: RELAY_DECISIONS.TERMINAL,
        reason: `Max cycles (${relay.max_cycles}) reached, forcing terminal evaluation`,
      };
    }

    if (remaining_work) {
      // Create repair artifact and prepare new cycle
      const cycleNumber = relay.cycles_completed + 2; // Goal 01 is cycle 0
      const slug = `goal-${run.goal_id || "unknown"}-repair`;
      const repairArtifact = {
        id: crypto.randomUUID(),
        slug,
        goal_number: cycleNumber,
        previous_goal_id: relay.active_goal_id || run.goal_id,
        summary: failure_summary || "Remaining work detected after goal completion",
        created_at: now,
        path: `gptplan/${slug}-repair.md`,
        content: `# Repair Plan: Goal ${String(cycleNumber).padStart(2, "0")}\n\n${failure_summary || "Continue remaining work from previous iteration."}\n`,
      };

      return {
        decision: RELAY_DECISIONS.START_REPAIR_CYCLE,
        reason: `Goal completed with remaining work (cycle ${relay.cycles_completed + 1}/${relay.max_cycles})`,
        repair_artifact: repairArtifact,
        next_goal: {
          goal_number: cycleNumber,
          idempotency_key: `${GOAL_CYCLE_IDEMPOTENCY_PREFIX}:${run.id}:${relay.cycles_completed + 1}`,
          repair_of_goal_id: relay.active_goal_id || run.goal_id,
          parent_goal_id: relay.root_goal_id || run.goal_id,
        },
      };
    }

    return {
      decision: RELAY_DECISIONS.TERMINAL,
      reason: "Goal completed, no remaining work detected",
    };
  }

  /**
   * Apply the goal relay decision to update run state.
   * Called after a decision has been executed (repair cycle started or terminal reached).
   *
   * @param {object} options
   * @param {object} options.run - ExecutionRun
   * @param {object} options.decision - Result from evaluateGoalCompletion
   * @param {object} [options.executionResult] - Result from command execution
   * @returns {Promise<object>} Updated run
   */
  async function applyRelayDecision({
    run,
    decision,
    executionResult = null,
  } = {}) {
    run = ensureRelayState(run);
    const relay = { ...run.supervision.goal_relay };

    if (decision.decision === RELAY_DECISIONS.START_REPAIR_CYCLE) {
      relay.phase = "repair_cycle";
      relay.current_goal_number = decision.next_goal?.goal_number || relay.current_goal_number + 1;
      relay.cycles_completed += 1;

      if (decision.repair_artifact) {
        relay.repair_artifacts = [
          ...(relay.repair_artifacts || []),
          decision.repair_artifact.id,
        ];
      }

      if (decision.next_goal?.id) {
        relay.active_goal_id = decision.next_goal.id;
      }

      // Clear terminal state since we're continuing
      relay.terminal_decision = null;
    } else if (decision.decision === RELAY_DECISIONS.TERMINAL) {
      relay.phase = "terminal_evaluation";
      relay.terminal_decision = {
        action: "evaluate_terminal",
        reason: decision.reason,
        decided_at: new Date().toISOString(),
      };
    }

    // Persist updated relay state
    await deps.runStore.updateRun(run.id, {
      supervision: {
        ...run.supervision,
        goal_relay: relay,
      },
    });

    return await deps.runStore.readRun(run.id);
  }

  /**
   * Check whether a goal cycle has already been started for a given revision.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.revisionId - Review revision ID
   * @returns {Promise<boolean>}
   */
  async function hasCycleBeenStarted({ runId, revisionId } = {}) {
    if (deps.cycleIdempotencyStore) {
      const key = `${GOAL_CYCLE_IDEMPOTENCY_PREFIX}:${runId}:${revisionId}`;
      return deps.cycleIdempotencyStore.has(key);
    }

    // Fallback: check run relay state
    try {
      const run = await deps.runStore.readRun(runId);
      const relay = run.supervision?.goal_relay;
      if (!relay) return false;

      // A cycle has been started if we're past the idle phase
      return !["idle", "active_goal"].includes(relay.phase);
    } catch {
      return false;
    }
  }

  /**
   * Mark a cycle as started for idempotency.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} options.revisionId
   * @returns {Promise<void>}
   */
  async function markCycleStarted({ runId, revisionId } = {}) {
    if (deps.cycleIdempotencyStore) {
      const key = `${GOAL_CYCLE_IDEMPOTENCY_PREFIX}:${runId}:${revisionId}`;
      await deps.cycleIdempotencyStore.mark(key);
    }
  }

  /**
   * Serialize goal relay state for persistence/restart recovery.
   *
   * @param {object} run
   * @returns {object} Serializable relay state
   */
  function serializeRelayState(run) {
    return {
      schema_version: 1,
      goal_relay: run.supervision?.goal_relay || createGoalRelayState(),
      controller_owner: run.supervision?.controller_owner || "workmcp_autopilot",
    };
  }

  /**
   * Restore goal relay state from serialized data.
   *
   * @param {object} serialized - Output of serializeRelayState
   * @returns {object} goalRelay state
   */
  function deserializeRelayState(serialized) {
    if (!serialized?.goal_relay) return createGoalRelayState();
    return { ...createGoalRelayState(), ...serialized.goal_relay };
  }


  async function startRepairCycle({ run, revisionId, failure_summary = "", evidence = {} } = {}) {
    if (!run?.id) throw new Error("run is required");
    if (!revisionId) throw new Error("revisionId is required");
    if (await hasCycleBeenStarted({ runId: run.id, revisionId })) {
      return { idempotent: true, decision: RELAY_DECISIONS.START_REPAIR_CYCLE };
    }
    const decision = await evaluateGoalCompletion({ run, evidence, remaining_work: true, failure_summary });
    if (decision.decision !== RELAY_DECISIONS.START_REPAIR_CYCLE) return decision;
    if (!deps.repairArtifactWriter) throw new Error("repairArtifactWriter not configured");
    if (!deps.tuiBridge) throw new Error("tuiBridge not configured");
    const artifactPath = await deps.repairArtifactWriter.write({ run, summary: failure_summary, repair_artifact: decision.repair_artifact, decision });
    const successor = await deps.tuiBridge.submitSuccessorGoal({ run, next_goal: decision.next_goal, repair_artifact: { ...decision.repair_artifact, path: artifactPath } });
    decision.repair_artifact.path = artifactPath;
    decision.next_goal = { ...decision.next_goal, id: successor.goal_id, task_id: successor.task_id, tui_session_id: successor.tui_session_id };
    await applyRelayDecision({ run, decision, executionResult: successor });
    await markCycleStarted({ runId: run.id, revisionId });
    return { ...decision, successor, idempotent: false };
  }

  return {
    ensureRelayState,
    evaluateGoalCompletion,
    applyRelayDecision,
    hasCycleBeenStarted,
    markCycleStarted,
    serializeRelayState,
    deserializeRelayState,
    startRepairCycle,
  };
}
