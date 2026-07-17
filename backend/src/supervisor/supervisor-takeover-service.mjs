/**
 * supervisor-takeover-service.mjs — ChatGPT takeover orchestration.
 *
 * Manages the lifecycle of a ChatGPT takeover of an ExecutionRun:
 * transition run state, update controller ownership, prepare context
 * for the ChatGPT session, and (later) restore Codex control.
 *
 * @module supervisor-takeover-service
 */

import { SupervisorTakeoverError } from "./supervisor-errors.mjs";
import { buildSupervisorContextPacket } from "./supervisor-context-packet.mjs";

/**
 * Create the takeover service.
 *
 * @param {object} deps
 * @param {object} deps.runStore
 * @param {object} [deps.checkpointStore]
 * @param {object} [deps.planStore]
 * @returns {object} Takeover service API
 */
export function createSupervisorTakeoverService(deps) {
  if (!deps.runStore) throw new Error("runStore is required");

  /**
   * Take over a run on behalf of ChatGPT.
   * Transitions run to chatgpt_direct state and updates controller ownership.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} [options.reason] - Why takeover is happening
   * @returns {Promise<{ run: object, context_packet: object }>}
   */
  async function takeover({ runId, reason = "ChatGPT supervisor intervention" } = {}) {
    let run = await deps.runStore.readRun(runId);
    const allowedStates = ["waiting_for_supervisor", "waiting_for_repair", "waiting_for_review", "running"];
    if (!allowedStates.includes(run.state)) {
      throw new SupervisorTakeoverError(
        `Cannot takeover run "${runId}" in state "${run.state}"`,
        { runId, currentState: run.state, allowedStates }
      );
    }

    // Build context packet for handoff
    let plan = null;
    if (deps.planStore && run.supervisor_plan_id) {
      try { plan = await deps.planStore.readPlan(run.supervisor_plan_id); } catch { /* plan optional */ }
    }

    let checkpoints = [];
    if (deps.checkpointStore && run.checkpoint_ids?.length) {
      try { checkpoints = await deps.checkpointStore.listCheckpoints(runId, 20); } catch { /* checkpoints optional */ }
    }

    const contextPacket = buildSupervisorContextPacket({
      run,
      plan,
      checkpoints,
      latestCheckpoint: checkpoints[0] || null,
    });

    // Update run state and supervision
    const targetState = run.state === "waiting_for_supervisor" ? "waiting_for_supervisor_direct" : "chatgpt_direct";
    run = await deps.runStore.compareAndSetState({
      runId,
      expectedState: run.state,
      nextState: targetState,
      patch: {
        supervision: {
          ...run.supervision,
          controller_owner: "chatgpt_supervising",
          chatgpt_takeover_count: (run.supervision?.chatgpt_takeover_count || 0) + 1,
          takeover_reason: reason,
          waiting_reason: null,
        },
      },
    });

    // Transition from waiting_for_supervisor_direct to chatgpt_direct
    if (run.state === "waiting_for_supervisor_direct") {
      run = await deps.runStore.compareAndSetState({
        runId,
        expectedState: "waiting_for_supervisor_direct",
        nextState: "chatgpt_direct",
        patch: {
          supervision: {
            ...run.supervision,
            controller_owner: "chatgpt_direct",
          },
        },
      });
    }

    return { run, context_packet: contextPacket };
  }

  /**
   * Return control from ChatGPT back to Codex autopilot.
   *
   * @param {object} options
   * @param {string} options.runId
   * @returns {Promise<{ run: object }>}
   */
  async function relinquishControl({ runId } = {}) {
    let run = await deps.runStore.readRun(runId);
    if (!["chatgpt_direct", "waiting_for_supervisor_direct"].includes(run.state)) {
      throw new SupervisorTakeoverError(
        `Cannot relinquish control for run "${runId}" in state "${run.state}"`,
        { runId, currentState: run.state, allowedStates: ["chatgpt_direct", "waiting_for_supervisor_direct"] }
      );
    }

    run = await deps.runStore.compareAndSetState({
      runId,
      expectedState: run.state,
      nextState: "ready",
      patch: {
        supervision: {
          ...run.supervision,
          controller_owner: "workmcp_autopilot",
          takeover_reason: null,
        },
      },
    });

    return { run };
  }

  return { takeover, relinquishControl };
}
