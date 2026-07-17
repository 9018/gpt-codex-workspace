/**
 * execution-projection-service.mjs — ExecutionRun state projection.
 *
 * Projects ExecutionRun state onto downstream entities (Task, Goal,
 * Workstream).  This projection is the ONLY place where Run state
 * influences Task/goal status — providers and workers must NOT
 * transition Task state directly.
 *
 * Projection failures create durable pending effects and events
 * so they can be reconciled later.
 *
 * @module execution-projection-service
 */

/**
 * Map an ExecutionRun state to Task status.
 *
 * @param {object} run
 * @returns {string|null} Task status or null if unknown
 */
export function mapRunStateToTaskState(run) {
  if (!run) return null;

  switch (run.state) {
    case "created":
    case "planning":
    case "ready":
      return "starting";
    case "running":
    case "correcting":
    case "resuming":
      return "running";
    case "collecting":
    case "evaluating":
      return "collecting";
    case "checkpointing":
    case "waiting_for_repair":
      return "waiting_for_repair";
    case "waiting_for_review":
      return "waiting_for_review";
    case "waiting_for_supervisor":
    case "waiting_for_supervisor_direct":
    case "chatgpt_direct":
      return "waiting_for_supervisor";
    case "waiting_for_integration":
      return "waiting_for_integration";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Create the projection service.
 *
 * @param {object} deps
 * @param {object} [deps.taskTransitionService] - For projecting Run state to Task
 * @param {object} [deps.goalLifecycleService] - For projecting Run state to Goal
 * @param {object} [deps.workstreamService] - For projecting Run state to Workstream
 * @param {object} [deps.runStore] - For creating pending effects
 * @param {object} [deps.eventStore] - For writing projection failure events
 * @returns {object} { project }
 */
export function createProjectionService(deps = {}) {
  /**
   * Project a run's state onto downstream entities.
   * Idempotent: repeated projections with the same state are safe.
   *
   * @param {object} run - The ExecutionRun
   * @returns {Promise<{ task_projected: boolean, goal_projected: boolean, workstream_projected: boolean }>}
   */
  async function project(run) {
    const result = {
      task_projected: false,
      goal_projected: false,
      workstream_projected: false,
    };

    try {
      if (run.task_id && deps.taskTransitionService) {
        const taskStatus = mapRunStateToTaskState(run);
        if (taskStatus) {
          await deps.taskTransitionService.projectState({
            task_id: run.task_id,
            execution_run_id: run.id,
            target_status: taskStatus,
            reason: `Run ${run.id} transitioned to "${run.state}"`,
            idempotency_key: `run:${run.id}:version:${run.version}`,
          });
          result.task_projected = true;
        }
      }
    } catch (error) {
      await handleProjectionError(run, error, "task");
    }

    try {
      if (run.goal_id && deps.goalLifecycleService) {
        await deps.goalLifecycleService.projectExecutionRun(run);
        result.goal_projected = true;
      }
    } catch (error) {
      await handleProjectionError(run, error, "goal");
    }

    try {
      if (run.workstream_id && deps.workstreamService) {
        await deps.workstreamService.projectExecutionRun(run);
        result.workstream_projected = true;
      }
    } catch (error) {
      await handleProjectionError(run, error, "workstream");
    }

    return result;
  }

  /**
   * Handle projection errors with durable pending effects and events.
   */
  async function handleProjectionError(run, error, target) {
    const pendingEffect = {
      action: "reconcile_projection",
      target,
      run_id: run.id,
      run_version: run.version,
      error: error.message,
      idempotency_key: `projection:${run.id}:${run.version}:${target}`,
    };

    if (deps.runStore) {
      try {
        await deps.runStore.updateRun(run.id, {
          pending_effects: [...(run.pending_effects || []), pendingEffect],
        });
      } catch {
        // Best-effort
      }
    }

    if (deps.eventStore) {
      try {
        await deps.eventStore.appendEvent({
          run_id: run.id,
          type: "projection_failed",
          severity: "warning",
          data: { error: error.message, run_version: run.version, target },
        });
      } catch {
        // Best-effort
      }
    }
  }

  return { project, mapRunStateToTaskState };
}
