/**
 * legacy-task-adapter.mjs — Adapter between old Task/Goal shapes and new ExecutionRun.
 *
 * During the transition period (Waves 0–7), existing Task-processing code
 * speaks in terms of { status, goal_id, metadata, ... } while the new kernel
 * speaks in terms of ExecutionIntent and ExecutionRun.  This adapter bridges
 * the two without requiring callers to know the new shapes.
 *
 * @module legacy-task-adapter
 */

import { classifyExecutionIntent, classifyAndNormalize } from "./execution-intent-classifier.mjs";

/**
 * Convert a legacy Task + optional Goal into an ExecutionIntent.
 *
 * @param {object} options
 * @param {object} options.task - Legacy task object
 * @param {string} options.task.id
 * @param {string} [options.task.request] - User request text
 * @param {string} [options.task.goal_id]
 * @param {string} [options.task.workstream_id]
 * @param {string} [options.task.operation_kind] - Optional explicit kind
 * @param {object} [options.task.metadata] - Catch-all metadata bag
 * @param {object} [options.task.metadata.execution_provider]
 * @param {object} [options.task.metadata.codex_execution_provider]
 * @param {object} [options.task.metadata.acceptance_profile]
 * @param {object} [options.goal] - Optional legacy goal object
 * @param {string} [options.goal.id]
 * @returns {object} An ExecutionIntent
 */
export function taskToExecutionIntent({ task, goal } = {}) {
  if (!task) {
    throw new Error("task is required");
  }

  const requestText =
    task.request_text ||
    task.request ||
    task.description ||
    task.title ||
    (typeof task.metadata?.request_text === "string" ? task.metadata.request_text : "");

  // Extract execution provider info from legacy metadata bags
  const legacyProvider =
    task.execution_policy?.provider ||
    task.metadata?.execution_provider ||
    task.metadata?.codex_execution_provider ||
    null;

  const legacyAcceptanceProfile =
    task.acceptance_profile ||
    task.metadata?.acceptance_profile ||
    task.operation_kind ||
    null;

  // Build the intent using the classifier
  return classifyAndNormalize({
    request_text: requestText,
    operation_kind: task.operation_kind || legacyAcceptanceProfile || undefined,
    task_id: task.id,
    goal_id: goal?.id || task.goal_id || null,
    workstream_id: task.workstream_id || null,
    acceptance_profile: legacyAcceptanceProfile || undefined,
    execution_policy: {
      preferred_provider: legacyProvider || "codex_tui",
      fallback_allowed: task.execution_policy?.fallback_allowed === true,
      interaction_mode: task.interaction_mode || "automatic",
      max_attempts: task.execution_policy?.max_attempts ?? 3,
    },
    constraints: {
      ...(task.metadata?.constraints || {}),
    },
  });
}

/**
 * Normalize a legacy provider name to the canonical form.
 *
 * @param {string|null} provider
 * @returns {string}
 */
export function normalizeLegacyProvider(provider) {
  if (!provider || provider === "auto") return "auto";
  if (["codex_exec", "codex_tui"].includes(provider)) return provider;
  // Legacy aliases
  if (provider === "codex" || provider === "exec") return "codex_exec";
  if (provider === "tui" || provider === "claude_tui") return "codex_tui";
  return "auto";
}

/**
 * Map an ExecutionRun's outcome to a legacy provider dispatch result
 * that existing Task processing code understands.
 *
 * @param {object} runResult - Result from ExecutionRunService.start()
 * @returns {object} A legacy dispatch result
 */
export function runResultToLegacyDispatchResult(runResult) {
  return {
    execution_id: runResult.run?.id || runResult.execution_id,
    run: runResult.run,
    provider: runResult.run?.supervision?.execution_mode === "codex_exec" ? "codex_exec" : "codex_tui",
    started: true,
    status: "running",
  };
}

/**
 * Map an ExecutionRun's final outcome to a legacy collection/evidence result.
 *
 * @param {object} options
 * @param {object} options.run
 * @param {object} [options.evidence]
 * @returns {object} Legacy-format result
 */
export function runToLegacyResult({ run, evidence } = {}) {
  if (!run) throw new Error("run is required");

  return {
    run_id: run.id,
    task_id: run.task_id,
    outcome: run.state === "completed" ? "succeeded" : run.state === "failed" ? "failed" : run.state,
    evidence: evidence || null,
    attempt_ids: run.attempt_ids,
    failure: run.failure,
    changed_file_count: run.outcome?.changed_file_count || 0,
  };
}

/**
 * Project an ExecutionRun state onto legacy Task status.
 * Must be kept in sync with execution-projection-service.mjs mapRunStateToTaskState.
 *
 * @param {object} run
 * @returns {string|null} The projected task status
 */
export function mapRunStateToTaskState(run) {
  if (!run) return null;

  const state = run.state;

  switch (state) {
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
