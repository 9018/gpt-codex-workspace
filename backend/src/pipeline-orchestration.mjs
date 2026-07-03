/**
 * pipeline-orchestration.mjs — Multi-agent pipeline orchestration lifecycle.
 *
 * P0-MA4: Default multi-agent pipeline orchestration.
 *
 * This module manages the full pipeline lifecycle:
 * - Pipeline creation at task start
 * - Pipeline gate checking before closure
 * - Legacy compatibility for tasks without pipeline fields
 * - Role-specific backend resolution
 * - Artifact gate evaluation
 *
 * Pipeline flow:
 *   context_curator -> planner -> builder -> verifier -> reviewer -> integrator -> finalizer
 *
 * Repairer is a recovery branch, not part of the main pipeline.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_PIPELINE,
  DEFAULT_AGENT_BACKEND_BY_ROLE,
  REPAIRER_ROLE,
  normalizeAgentRole,
  validateAgentRoles,
  resolveDefaultBackendForRole,
  mapLegacyRole,
  ACCEPTED_AGENT_ROLES,
} from "./subagent-policy.mjs";
import {
  evaluateAgentGates,
  buildAgentCompletionArtifact,
  getAgentRunArtifacts,
  runAgentPipeline,
  listAgentRuns,
  createAgentRun,
} from "./agent-run-service.mjs";
import {
  ARTIFACT_SCHEMA,
  AGENT_ROLE_ENUM,
  normalizeContractRole,
  mapLegacyArtifactsToContract,
  artifactRecord,
} from "./agent-artifact-contract.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default review gate after which gate blocking is checked. */
export const DEFAULT_REVIEW_GATE_AFTER = "reviewer";

/** Roles that block completion if unsatisfied. */
export const BLOCKING_GATE_ROLES = Object.freeze(["verifier", "reviewer", "finalizer", "integrator"]);

// ---------------------------------------------------------------------------
// Pipeline creation
// ---------------------------------------------------------------------------

/**
 * Create a default pipeline record for a task.
 * This sets up the pipeline metadata and creates agent_run records for each
 * role in the default pipeline.
 *
 * @param {object} store - State store
 * @param {object} args
 * @param {string} args.goal_id
 * @param {string} args.task_id
 * @param {object} [context] - { eventLogger, hookBus }
 * @returns {Promise<{ pipeline: object, agent_runs: object[] }>}
 */
export async function createDefaultAgentPipeline(store, args = {}, context = {}) {
  const { goal_id, task_id } = args;

  // Create the pipeline via the existing runAgentPipeline service
  const result = await runAgentPipeline(store, {
    goal_id: goal_id || "",
    task_id: task_id || "",
    roles: [...DEFAULT_AGENT_PIPELINE],
    execution_order: [...DEFAULT_AGENT_PIPELINE],
    review_gate_after: DEFAULT_REVIEW_GATE_AFTER,
  }, context);

  return result;
}

/**
 * Ensure pipeline agent_run records exist for a task's roles.
 * Reuses existing runs and creates new ones for missing roles.
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} options.task_id
 * @param {string} options.goal_id
 * @param {string[]} [options.roles] - Roles to create runs for. Defaults to DEFAULT_AGENT_PIPELINE.
 * @param {object} [context]
 * @returns {Promise<{ runs: object[], created: number, skipped: number }>}
 */
export async function ensurePipelineRunsForTask(store, { task_id, goal_id, roles } = {}, context = {}) {
  const pipelineRoles = validateAgentRoles(roles || DEFAULT_AGENT_PIPELINE);

  // Check existing runs for this task
  const existing = await listAgentRuns(store, { task_id, limit: 100 });
  const existingRoles = new Set(
    (existing.agent_runs || []).map(r => normalizeContractRole(r.role))
  );

  const runs = [];
  let created = 0;
  let skipped = 0;

  for (const role of pipelineRoles) {
    if (existingRoles.has(role)) {
      // Reuse existing run
      const match = existing.agent_runs.find(r => normalizeContractRole(r.role) === role);
      if (match) runs.push(match);
      skipped++;
    } else {
      // Create a new queued run
      const result = await createAgentRun(store, {
        goal_id: goal_id || "",
        task_id,
        role,
        status: "queued",
      }, context);
      runs.push(result.agent_run);
      created++;
    }
  }

  return { runs, created, skipped };
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the pipeline gates are satisfied for a task.
 * This is the primary gate check to call before task closure.
 *
 * Wraps evaluateAgentGates with additional legacy compatibility logic.
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} options.task_id
 * @param {boolean} [options.allowMissingGates=false] - If true, missing gates are
 *   treated as satisfied (legacy compatibility).
 * @returns {Promise<{
 *   gates_satisfied: boolean,
 *   gates: Array,
 *   blocking_gates: string[],
 *   blocking_reasons: string[],
 *   last_completed_role: string|null,
 *   has_legacy_task: boolean,
 * }>}
 */
export async function evaluateTaskPipelineGates(store, { task_id, allowMissingGates = false } = {}) {
  const existing = await listAgentRuns(store, { task_id, limit: 100 });
  const agentRuns = existing.agent_runs || [];

  if (agentRuns.length === 0) {
    // No agent runs -- this is a legacy task or hasn't started pipeline yet
    if (allowMissingGates) {
      return {
        gates_satisfied: true,
        gates: [],
        blocking_gates: [],
        blocking_reasons: [],
        last_completed_role: null,
        has_legacy_task: true,
      };
    }
    return {
      gates_satisfied: false,
      gates: [],
      blocking_gates: ["no_agent_runs"],
      blocking_reasons: ["No agent runs found for task; pipeline not initialized"],
      last_completed_role: null,
      has_legacy_task: true,
    };
  }

  const gateResult = evaluateAgentGates(agentRuns);

  // Build human-readable blocking reasons
  const blockingReasons = gateResult.blocking_gates.map((role) => {
    const gate = (gateResult.gates || []).find(g => g.contract_role === role);
    if (!gate) return `${role}: gate not evaluated`;
    if (Array.isArray(gate.missing_artifacts) && gate.missing_artifacts.length > 0) {
      return `${role}: missing required artifacts (${gate.missing_artifacts.join(", ")})`;
    }
    return `${role}: gate not satisfied (status=${gate.status})`;
  });

  return {
    gates_satisfied: gateResult.gates_satisfied,
    gates: gateResult.gates,
    blocking_gates: gateResult.blocking_gates,
    blocking_reasons: blockingReasons,
    last_completed_role: gateResult.last_completed_role,
    has_legacy_task: false,
  };
}

/**
 * Check if pipeline gate blocking prevents task closure.
 * Only checks the blocking roles (verifier, reviewer, finalizer, integrator).
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} options.task_id
 * @param {boolean} [options.allowMissingGates=false]
 * @returns {Promise<{ blocked: boolean, reasons: string[] }>}
 */
export async function checkPipelineGateBlocking(store, { task_id, allowMissingGates = false } = {}) {
  const gateStatus = await evaluateTaskPipelineGates(store, { task_id, allowMissingGates });

  // Only consider blocking roles
  const blockingReasons = [];
  for (const gate of (gateStatus.gates || [])) {
    if (!BLOCKING_GATE_ROLES.includes(gate.contract_role)) continue;
    if (!gate.satisfied) {
      blockingReasons.push(...(Array.isArray(gate.missing_artifacts) ? gate.missing_artifacts : []).map(a => `${gate.contract_role}: missing ${a}`));
    }
  }

  return {
    blocked: blockingReasons.length > 0 && !gateStatus.gates_satisfied,
    reasons: blockingReasons.length > 0 ? blockingReasons : gateStatus.blocking_reasons,
  };
}

// ---------------------------------------------------------------------------
// Pre-closure gate check: adapt pipeline gate into task status decision
// ---------------------------------------------------------------------------

/**
 * Apply pipeline gate check before task closure.
 * Called right before finalizeCodexTaskRun.
 *
 * Rule:
 * - If no agent_runs exist (legacy task) and allowMissingGates=true: passes through.
 * - If blocking gates are NOT satisfied and taskStatus == "completed":
 *   downgrade to "waiting_for_review" with gate findings.
 * - Otherwise: pass through unchanged.
 *
 * @param {object} store - State store
 * @param {object} task - Task object
 * @param {object} taskResult - Mutable task result object
 * @param {string} taskStatus - Current task status
 * @param {object} [options]
 * @param {boolean} [options.allowMissingGates=true] - Legacy compatibility flag
 * @returns {Promise<{ taskStatus: string, taskResult: object, gateChecked: boolean, gatesSatisfied: boolean }>}
 */
export async function applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, options = {}) {
  const { allowMissingGates = true } = options;
  const taskId = task.id || taskResult.task_id || "";

  if (!taskId) {
    return { taskStatus, taskResult, gateChecked: false, gatesSatisfied: true };
  }

  const gateResult = await evaluateTaskPipelineGates(store, { task_id: taskId, allowMissingGates });

  // Legacy task with no agent runs: pass through
  if (gateResult.has_legacy_task && allowMissingGates) {
    return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: true };
  }

  // Gates satisfied: pass through
  if (gateResult.gates_satisfied) {
    return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: true };
  }

  // Gates NOT satisfied: only downgrade if task would be completed
  if (taskStatus === "completed") {
    const downgradedStatus = "waiting_for_review";
    const gateFindings = (gateResult.blocking_reasons || []).map(reason => ({
      severity: "blocker",
      code: "pipeline_gate_blocking",
      message: `Pipeline gate blocking: ${reason}`,
      source: "pipeline_orchestration",
    }));

    // Append findings
    taskResult.acceptance_findings = [
      ...(Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : []),
      ...gateFindings,
    ];
    taskResult.pipeline_gate_blocked = true;
    taskResult.pipeline_gate_reasons = gateResult.blocking_reasons;
    taskResult.pipeline_gate_legacy = gateResult.has_legacy_task;

    return {
      taskStatus: downgradedStatus,
      taskResult,
      gateChecked: true,
      gatesSatisfied: false,
    };
  }

  // Task already not completed, just annotate
  if (gateResult.blocking_reasons.length > 0) {
    taskResult.pipeline_gate_blocked = true;
    taskResult.pipeline_gate_reasons = gateResult.blocking_reasons;
  }

  return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: false };
}

// ---------------------------------------------------------------------------
// Completion artifact building
// ---------------------------------------------------------------------------

/**
 * Build the completion artifact from pipeline agent runs.
 * Falls back to legacy artifact mapping if no agent runs exist.
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} options.task_id
 * @param {string} [options.goal_id]
 * @param {object} [options.taskResult]
 * @param {object} [options.legacyContext] - Context for mapLegacyArtifactsToContract
 * @returns {Promise<object>}
 */
export async function buildPipelineCompletionArtifact(store, { task_id, goal_id, taskResult, legacyContext } = {}) {
  const existing = await listAgentRuns(store, { task_id, limit: 100 });
  const agentRuns = existing.agent_runs || [];

  if (agentRuns.length === 0) {
    // Legacy fallback: map result fields to contract artifacts
    return {
      pipeline_type: "legacy_mapping",
      gates_satisfied: true,
      gates: [],
      artifacts: mapLegacyArtifactsToContract({
        goalId: goal_id,
        taskId: task_id,
        result: taskResult,
        ...legacyContext,
      }),
      last_completed_role: null,
      completed_at: new Date().toISOString(),
      summary: taskResult?.summary || "Pipeline completion (legacy mapping)",
    };
  }

  return buildAgentCompletionArtifact(agentRuns);
}

// ---------------------------------------------------------------------------
// Legacy compatibility helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a task is a "legacy" task that hasn't been pipeline-initialized.
 * Legacy tasks are those without any agent_runs or pipeline metadata.
 *
 * @param {object} task - Task object
 * @returns {boolean}
 */
export function isLegacyTask(task = {}) {
  if (task.legacy === true) return true;
  if (task.agent_pipeline === false) return true;
  if (task.pipeline === false) return true;
  if (task.skip_pipeline === true) return true;
  if (Array.isArray(task.agent_runs) && task.agent_runs.length > 0) return false;
  if (task.pipeline_id) return false;
  return true; // Default: treat as legacy until pipeline is initialized
}

/**
 * Get the effective pipeline roles for a task, supporting legacy role names.
 * For tasks with explicit role lists, maps legacy names to canonical ones.
 * For legacy tasks, returns the default pipeline.
 *
 * @param {object} task - Task object
 * @returns {string[]} Canonical pipeline roles
 */
export function getEffectivePipelineRoles(task = {}) {
  const roles = task.agent_roles || task.pipeline_roles || task.roles;
  if (Array.isArray(roles) && roles.length > 0) {
    return roles.map(role => mapLegacyRole(role));
  }
  return [...DEFAULT_AGENT_PIPELINE];
}

/**
 * Resolve the execution backend for a task's role.
 * Falls through: task-specific override -> role default -> null.
 *
 * @param {object} task - Task object
 * @param {object} [config] - Optional config with agentBackendByRole overrides
 * @param {string} [role] - Specific role. Defaults to task.role or "builder".
 * @returns {string} Backend identifier
 */
export function resolveRoleBackend(task = {}, config = {}, role) {
  const effectiveRole = role || normalizeContractRole(task.role || task.agent_role || "builder");

  // Check task-level override
  const taskBackend = task.agent_backend_by_role?.[effectiveRole]
    || task.backend_by_role?.[effectiveRole]
    || task.agent_backends?.[effectiveRole];
  if (taskBackend) return taskBackend;

  // Check config-level override
  const configBackend = config.agentBackendByRole?.[effectiveRole]
    || config.agentRoleBackends?.[effectiveRole];
  if (configBackend) return configBackend;

  // Use default
  return resolveDefaultBackendForRole(effectiveRole);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Build a pipeline diagnostics snapshot for runtime_status / doctor.
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} [options.task_id] - Optional task_id filter
 * @returns {Promise<{
 *   pipeline_enabled: boolean,
 *   default_pipeline: string[],
 *   backends: object,
 *   agent_runs_count: number,
 *   recent_agent_runs: object[],
 *   gate_status: object|null,
 * }>}
 */
export async function getPipelineDiagnostics(store, { task_id } = {}) {
  const diagnostics = {
    pipeline_enabled: true,
    default_pipeline: [...DEFAULT_AGENT_PIPELINE],
    backends: { ...DEFAULT_AGENT_BACKEND_BY_ROLE },
    agent_runs_count: 0,
    recent_agent_runs: [],
    gate_status: null,
  };

  if (task_id) {
    // Get agent runs for this specific task
    const existing = await listAgentRuns(store, { task_id, limit: 10 });
    const agentRuns = existing.agent_runs || [];
    diagnostics.recent_agent_runs = agentRuns.map(r => ({
      id: r.id,
      role: r.role,
      contract_role: r.contract_role,
      status: r.status,
      summary: (r.summary || "").slice(0, 200),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    diagnostics.agent_runs_count = diagnostics.recent_agent_runs.length;

    // Get gate status
    const gateResult = await evaluateTaskPipelineGates(store, { task_id, allowMissingGates: true });
    diagnostics.gate_status = {
      gates_satisfied: gateResult.gates_satisfied,
      blocking_gates: gateResult.blocking_gates,
      blocking_reasons: gateResult.blocking_reasons,
      gates: gateResult.gates,
    };
  } else {
    // Count all agent runs across all tasks
    const existing = await listAgentRuns(store, { limit: 50 });
    const agentRuns = existing.agent_runs || [];
    diagnostics.agent_runs_count = agentRuns.length;
    diagnostics.recent_agent_runs = agentRuns.slice(0, 10).map(r => ({
      id: r.id,
      role: r.role,
      contract_role: r.contract_role,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  return diagnostics;
}
