/**
 * execution-run-bridge.mjs — Bridge from old task-processing to new ExecutionRun.
 *
 * Provides a drop-in compatible path for `dispatchTaskProvider` that routes
 * through the new ExecutionRun pipeline instead of the old `execution-orchestrator`.
 *
 * The bridge ensures:
 *   1. An ExecutionRun is created from task + intent
 *   2. The pipeline adapter executes the full provider cycle
 *   3. Results are projected back to the old attempt evidence format
 *
 * @module execution-run-bridge
 */

import { createExecutionRunService } from "../execution-core/execution-run-service.mjs";
import { createExecutionPipelineAdapter } from "../execution-core/execution-pipeline-adapter.mjs";

/**
 * Execute a task through the new ExecutionRun pipeline.
 *
 * @param {object} options
 * @param {string} options.taskId
 * @param {string} [options.goalId]
 * @param {string} options.provider - Provider name (codex_tui or codex_exec)
 * @param {object} options.context - Execution context
 * @param {object} options.deps - Dependencies (runStore, providerRegistry, etc.)
 * @returns {Promise<{ attempt: object, evidence: object|null, error?: string }>}
 */
export async function executeTaskViaExecutionRun({ taskId, goalId = null, provider = "codex_tui", context = {}, deps = {} } = {}) {
  // Build dependencies
  const runStore = deps.runStore || (await import("../execution-core/execution-run-store.mjs")).createExecutionRunStore();
  const providerRegistry = deps.providerRegistry;
  if (!providerRegistry) throw new Error("providerRegistry is required");

  // Create the pipeline
  const pipelineAdapter = createExecutionPipelineAdapter({
    runStore,
    providerRegistry,
    acceptanceService: deps.acceptanceService || null,
    evidenceService: deps.evidenceService || null,
    projectionService: deps.projectionService || null,
  });

  // Create the run service
  const runService = createExecutionRunService({
    runStore,
    projectionService: deps.projectionService || null,
    attemptStore: deps.attemptStore || null,
    acceptanceService: deps.acceptanceService || null,
    attemptOrchestrator: { execute: (args) => pipelineAdapter.executeProviderCycle({ ...args, context }) },
  });

  // Step 1: Start the run
  const { run } = await runService.start({
    intent_id: `intent_${taskId}`,
    task_id: taskId,
    goal_id: goalId,
  });

  // Update the run's supervision mode to match the selected provider
  const executionMode = provider === "codex_tui" ? "native_tui" : "codex_exec";
  await runStore.updateRun(run.id, {
    supervision: { ...run.supervision, execution_mode: executionMode },
  });

  // Step 2: Advance the run (executes provider cycle + acceptance)
  const { run: advancedRun } = await runService.advanceRun(run.id);

  // Step 3: Project results
  if (deps.taskTransitionService && advancedRun.task_id) {
    try {
      const { mapRunStateToTaskState } = await import("../execution-core/execution-projection-service.mjs");
      const taskStatus = mapRunStateToTaskState(advancedRun);
      if (taskStatus) {
        await deps.taskTransitionService.projectState({
          task_id: advancedRun.task_id,
          execution_run_id: advancedRun.id,
          target_status: taskStatus,
          reason: `Run ${advancedRun.id} completed via ExecutionRun bridge`,
        });
      }
    } catch (projErr) {
      // Record projection failure as a pending effect on the run
      try {
        const { runStore } = await import("../execution-core/execution-run-store.mjs");
        const current = await runStore().readRun(advancedRun.id).catch(() => null);
        if (current) {
          const pendingEffect = {
            action: "reconcile_projection",
            target: "task",
            run_id: advancedRun.id,
            run_version: advancedRun.version,
            error: projErr.message,
            idempotency_key: `projection:${advancedRun.id}:${advancedRun.version}:task`,
          };
          await runStore().updateRun(advancedRun.id, {
            pending_effects: [...(current.pending_effects || []), pendingEffect],
          });
        }
      } catch {
        // Best-effort to record projection failure
      }
    }
  }

  // Step 4: Build legacy-format result
  const attempt = {
    id: advancedRun.active_attempt_id || `attempt_${advancedRun.id}`,
    task_id: advancedRun.task_id,
    goal_id: advancedRun.goal_id,
    provider,
    state: mapRunState(advancedRun.state),
  };

  const evidence = advancedRun.evidence_bundle_id
    ? { evidence_bundle_id: advancedRun.evidence_bundle_id, status: advancedRun.outcome?.status }
    : null;

  return { attempt, evidence, error: advancedRun.failure?.message || null };
}

/**
 * Map ExecutionRun states to legacy bridge-compatible states.
 * @param {string} runState
 * @returns {string}
 */
function mapRunState(runState) {
  switch (runState) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "waiting_for_repair":
    case "waiting_for_review":
    case "waiting_for_supervisor":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}
