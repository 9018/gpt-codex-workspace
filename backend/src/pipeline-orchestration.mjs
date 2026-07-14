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
import { prepareTaskAgentContext } from "./subagents/task-agent-context.mjs";
import {
  DEFAULT_AGENT_PIPELINE,
  TASK_ISOLATED_AGENT_PIPELINE,
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

  const state = await store.load();
  const task = (state.tasks || []).find((item) => item.id === task_id) || {};
  const effectiveRoles = getEffectivePipelineRoles(task);
  let prepared = null;
  if (task.pipeline_version === "task_pipeline_v2") {
    prepared = await prepareTaskAgentContext(store, { task_id, goal_id });
  }
  // Create the task-local pipeline. task_pipeline_v2 excludes Workstream integrator.
  const result = await runAgentPipeline(store, {
    goal_id: goal_id || "",
    task_id: task_id || "",
    workstream_id: task.workstream_id || null,
    roles: effectiveRoles,
    execution_order: effectiveRoles,
    review_gate_after: DEFAULT_REVIEW_GATE_AFTER,
    input_context_digest: prepared?.task_context_digest || task.task_context_digest || null,
    workstream_context_revision: prepared?.workstream_context_revision || null,
    role_view_paths: prepared?.role_views || {},
    require_fresh_artifacts: task.pipeline_version === "task_pipeline_v2",
  }, context);
  result.advisory_runs = prepared?.advisory_runs || [];
  result.role_views = prepared?.role_views || {};

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
  const state = await store.load();
  const task = (state.tasks || []).find((item) => item.id === task_id) || {};
  const pipelineRoles = validateAgentRoles(roles || getEffectivePipelineRoles(task));

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

  const state = await store.load();
  const task = (state.tasks || []).find((item) => item.id === task_id) || {};
  const blockingRoles = task.pipeline_version === "task_pipeline_v2"
    ? ["verifier", "reviewer", "finalizer"]
    : [...BLOCKING_GATE_ROLES];

  // Only consider blocking roles for this pipeline version.
  const blockingReasons = [];
  for (const gate of (gateStatus.gates || [])) {
    if (!blockingRoles.includes(gate.contract_role)) continue;
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
 * @param {boolean} [options.allowMissingGates=false] - When true, missing gates are treated as satisfied (legacy compatibility)
 * @returns {Promise<{ taskStatus: string, taskResult: object, gateChecked: boolean, gatesSatisfied: boolean }>}
 */
export async function applyPipelineGateBeforeClosure(store, task, taskResult, taskStatus, options = {}) {
  const { allowMissingGates = false } = options;
  const taskId = task.id || taskResult.task_id || "";

  if (!taskId) {
    return { taskStatus, taskResult, gateChecked: false, gatesSatisfied: true };
  }

  // Legacy tasks may have synthetic verifier/reviewer/finalizer writeback runs
  // created during finalization. Those runs are evidence, not an initialized
  // multi-agent pipeline, so they must not turn legacy tasks into gate-blocked
  // pipeline tasks.
  if (allowMissingGates && isLegacyTask(task)) {
    return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: true };
  }

  const gateResult = await evaluateTaskPipelineGates(store, { task_id: taskId, allowMissingGates });

  // Legacy task with no agent runs: pass through
  if (gateResult.has_legacy_task && allowMissingGates) {
    return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: true };
  }

  // P0-MA12-G1: Reconcile stale pipeline_gate_blocking finalizer-result findings.
  // Before P0-MA12-G1, writeFinalizerAgentRun was called after applyPipelineGateBeforeClosure,
  // so the finalizer gate was evaluated without the result artifact.
  // If a finalizer gate was previously blocked but is now satisfied (because we now write
  // the finalizer agent_run before gate evaluation), clear any stale findings.
  const finalizerGate = (gateResult.gates || []).find(g => g.contract_role === "finalizer");
  if (finalizerGate && finalizerGate.satisfied && Array.isArray(taskResult.acceptance_findings)) {
    taskResult.acceptance_findings = taskResult.acceptance_findings.filter(f =>
      !(f && f.code === "pipeline_gate_blocking" && f.message && f.message.startsWith("finalizer:"))
    );
  }

  // P0-MA11: Only check BLOCKING_GATE_ROLES (verifier, reviewer, finalizer, integrator)
  // context_curator and planner are informational, not blocking
  // If no agent runs exist and allowMissingGates=false, always block
  const blockingUnsatisfied = (gateResult.gates || []).filter(
    g => BLOCKING_GATE_ROLES.includes(g.contract_role) && !g.satisfied
  );
  const gatesSatisfied = blockingUnsatisfied.length === 0 && !gateResult.has_legacy_task;

  // Gates satisfied: pass through
  if (gatesSatisfied) {
    return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: true };
  }

  // Gates NOT satisfied: only downgrade if task would be completed
  if (taskStatus === "completed") {
    const downgradedStatus = "waiting_for_review";
    const gateFindings = blockingUnsatisfied.map(g => {
      // P0-04: Build detailed gate blocking message including missing artifacts
      const missingInfo = g.missing_artifacts?.length > 0
        ? `missing required artifacts: ${g.missing_artifacts.join(', ')}`
        : g.missing_fields?.length > 0
          ? `missing fields: ${g.missing_fields.join(', ')}`
          : g.summary || `gate not satisfied (status=${g.status || 'unknown'})`;
      return {
        severity: "blocker",
        code: "pipeline_gate_blocking",
        message: `Pipeline gate blocking: ${g.contract_role} - ${missingInfo}`,
        source: "pipeline_orchestration",
      };
    });

    // Append findings
    taskResult.acceptance_findings = [
      ...(Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : []),
      ...gateFindings,
    ];
    taskResult.pipeline_gate_blocked = true;
    taskResult.pipeline_gate_reasons = (gateResult.blocking_reasons || []).filter(
      r => blockingUnsatisfied.some(g => r.startsWith(g.contract_role))
    );
    taskResult.pipeline_gate_legacy = gateResult.has_legacy_task;

    return {
      taskStatus: downgradedStatus,
      taskResult,
      gateChecked: true,
      gatesSatisfied: false,
    };
  }

  // Task already not completed, just annotate
  if (blockingUnsatisfied.length > 0) {
    taskResult.pipeline_gate_blocked = true;
    taskResult.pipeline_gate_reasons = gateResult.blocking_reasons.filter(
      r => blockingUnsatisfied.some(g => r.startsWith(g.contract_role))
    );
  }

  return { taskStatus, taskResult, gateChecked: true, gatesSatisfied: blockingUnsatisfied.length === 0 };
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
  // P0-04: New builder-mode tasks explicitly require pipeline gate enforcement.
  // This flag is set during task creation for all new builder-mode tasks.
  if (task.require_pipeline_gates === true) return false;
  if (task.legacy === true) return true;
  if (task.agent_pipeline === false) return true;
  if (task.pipeline === false) return true;
  if (task.skip_pipeline === true) return true;
  if (Array.isArray(task.agent_runs) && task.agent_runs.length > 0) return false;
  if (task.pipeline_id) return false;
  return true; // Default: treat as legacy until pipeline is initialized
}
/**
 * Determine whether pipeline gates should be strictly enforced for this task.
 * Non-legacy tasks (new builder-mode tasks) require strict gate enforcement.
 * Legacy tasks bypass gate enforcement via allowMissingGates.
 *
 * @param {object} task - Task object
 * @returns {boolean}
 */
export function shouldEnforcePipelineGates(task = {}) {
  if (task.require_pipeline_gates === true) return true;
  if (task.legacy === true) return false;
  if (task.pipeline === false || task.skip_pipeline === true) return false;
  return !isLegacyTask(task);
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
  if (task.pipeline_version === "task_pipeline_v2") {
    return [...TASK_ISOLATED_AGENT_PIPELINE];
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

/**
 * convergeBacklog — Scan the current store state and classify/converge
 * all backlogged tasks into typed states.
 *
 * P0-MA11: This function ONLY produces typed convergence decisions.
 * It does NOT mutate task state.  The results can be consumed by a
 * convergence agent or runtime reconciler for actual state transitions.
 *
 * @param {object} store - State store
 * @param {object} [config] - Config object
 * @returns {Promise<{
 *   scanned_at: string,
 *   total_backlog: number,
 *   convergence: Array<{ task_id: string, status: string, classification: string, proposed_action: string, evidence: object }>,
 *   typing_summary: object,
 * }>}
 */

// ---------------------------------------------------------------------------
// Pipeline gate detail: per-role provenance and legacy bypass status
// ---------------------------------------------------------------------------

/**
 * Build detailed pipeline gate diagnostics for each blocking role.
 * Reports required artifact, missing artifact, backend provenance,
 * execution semantic, and legacy bypass status for every blocking gate.
 * This is used by the runtime doctor and review packet for observability.
 *
 * @param {object} store - State store
 * @param {object} options
 * @param {string} options.task_id - Task to inspect
 * @param {object} [config={}] - Runtime config for role backend resolution
 * @returns {Promise<{ gates: Array<object>, legacy_bypass: boolean }>}
 */
export async function buildPipelineGateDetail(store, { task_id, config = {} } = {}) {
  const { ARTIFACT_SCHEMA } = await import("./agent-artifact-contract.mjs");
  const { ROLE_BACKEND_DEFAULTS } = await import("./agent-execution-backends.mjs");

  const existing = await listAgentRuns(store, { task_id, limit: 100 });
  const agentRuns = existing.agent_runs || [];

  const taskStore = await store.load();
  const task = (taskStore.tasks || []).find((t) => t.id === task_id) || {};
  const legacyBypass = isLegacyTask(task) && !shouldEnforcePipelineGates(task);

  const gates = [];

  for (const role of BLOCKING_GATE_ROLES) {
    const run = agentRuns.find((r) => normalizeContractRole(r.role) === role);
    const required = Array.from(ARTIFACT_SCHEMA.required_by_role[role] || []);
    const artifacts = [
      ...(Array.isArray(run?.input_artifacts) ? run.input_artifacts : []),
      ...(Array.isArray(run?.output_artifacts) ? run.output_artifacts : []),
    ];
    const presentKinds = new Set(artifacts.map((a) => a.kind || a).filter(Boolean));
    const missing = required.filter((k) => !presentKinds.has(k));

    const backendId = run?.backend || ROLE_BACKEND_DEFAULTS[role]?.backend || "null";
    const semantic = run?.execution_semantic
      || (backendId === "null" ? "auto_artifact" : "real");

    gates.push({
      contract_role: role,
      backend: backendId,
      execution_semantic: semantic,
      status: run?.status || "not_created",
      satisfied: missing.length === 0 && (run?.status === "completed" || run?.status === "skipped"),
      required_artifacts: required,
      missing_artifacts: missing,
      has_agent_run: Boolean(run),
      agent_run_id: run?.id || null,
      completed_at: run?.completed_at || null,
      legacy_bypass: legacyBypass,
      backend_provenance: backendId === "codex_exec"
        ? "real agent execution (builder/repairer path)"
        : backendId === "local_command"
          ? "deterministic shell command execution (verifier/reviewer path)"
          : `auto_artifact (${role} completed from task result evidence, no external commands)`,
    });
  }

  return { gates, legacy_bypass: legacyBypass };
}
export async function convergeBacklog(store, config = {}) {
  const { getTaskAcceptanceBundle } = await import('./review/task-acceptance-bundle.mjs');
  const { reconcileBundle, RECONCILIATION_TYPES } = await import('./review/review-backlog-reconciler.mjs');
  const { classifyIntegrationState, INTEGRATION_RECONCILIATION_TYPES } = await import('./integration-backlog-reconciler.mjs');
  const { classifyBlocker, BLOCKER_CLASSIFICATIONS, BACKLOG_CATEGORIES } = await import('./backlog-census.mjs');
  const { normalizeTaskStatus, TASK_STATUSES, isFailedTerminalStatus } = await import('./task-status-taxonomy.mjs');
  const { REVIEW_STATES } = await import('./task-review-status-taxonomy.mjs');

  const state = await store.load();
  const tasks = state.tasks || [];
  const scanned_at = new Date().toISOString();

  const BACKLOG_STATUSES = new Set([
    TASK_STATUSES.WAITING_FOR_REVIEW,
    TASK_STATUSES.WAITING_FOR_REPAIR,
    TASK_STATUSES.WAITING_FOR_INTEGRATION,
    ...Object.values(REVIEW_STATES),
  ]);
  for (const s of Object.values(TASK_STATUSES)) {
    if (isFailedTerminalStatus(s)) BACKLOG_STATUSES.add(s);
  }

  const convergence = [];
  const typingCounts = {};

  for (const task of tasks) {
    const ns = normalizeTaskStatus(task.status);
    if (!BACKLOG_STATUSES.has(ns)) continue;

    const taskObj = { task_id: task.id, status: ns, classification: 'unknown', proposed_action: 'manual_review', evidence: {} };

    if (ns === TASK_STATUSES.WAITING_FOR_REVIEW) {
      // Use review-backlog-reconciler
      try {
        const bundle = await getTaskAcceptanceBundle({ store, config, task_id: task.id });
        const reconciled = reconcileBundle({ task, bundle, state, store });
        const integrated = reconciled.is_integrated || Boolean(task.result?.integration?.merged === true || task.result?.integration?.status === 'ff_only_merged' || task.result?.integration?.status === 'merged');
        const verified = bundle.verification?.passed === true || task.result?.verification?.passed === true;
        const accepted = reconciled.bundle_status === 'completed' || task.status === 'completed' || (
          task.result?.reviewer_decision?.passed === true ||
          task.result?.reviewer_decision?.decision === 'accepted' ||
          task.result?.acceptance_gate?.passed === true
        );

        if (accepted && verified && integrated) {
          taskObj.classification = 'accepted_verified_integrated';
          taskObj.proposed_action = 'auto_complete';
        } else if (accepted && verified) {
          taskObj.classification = 'accepted_verified_needs_integration';
          taskObj.proposed_action = 'auto_integrate';
        } else if (bundle.blockers?.length === 0 && !bundle.missing_evidence?.length) {
          taskObj.classification = 'noop_evidence_missing';
          taskObj.proposed_action = 'auto_repair_evidence';
        } else if (bundle.blockers?.some(b => b.code?.includes('contract'))) {
          taskObj.classification = 'invalid_contract';
          taskObj.proposed_action = 'contract_repair';
        } else if (reconciled.reconciled) {
          taskObj.classification = 'reconciled_by_evidence';
          taskObj.proposed_action = 'auto_accept';
        } else if (reconciled.still_blocking?.length > 0) {
          taskObj.classification = 'still_blocking';
          taskObj.proposed_action = 'manual_review';
        } else {
          taskObj.classification = 'true_human_review';
          taskObj.proposed_action = 'human_review';
        }
        taskObj.evidence = { bundle_status: bundle.status, integrated, verified, accepted, reconciled: reconciled.reconciled, still_blocking: reconciled.still_blocking?.length };
      } catch (err) {
        taskObj.classification = 'bundle_error';
        taskObj.proposed_action = 'manual_review';
        taskObj.evidence = { error: err.message };
      }
    } else if (ns === TASK_STATUSES.WAITING_FOR_REPAIR) {
      // Check for completed/accepted repair successor or repair budget
      const result = task.result || {};
      const hasSuccessor = result.repair_goal_id || result.repair_task_id;
      const successors = state.tasks?.filter(t => t.repair_of_task_id === task.id || t.parent_task_id === task.id) || [];
      const completedAcceptedSuccessor = successors.some(t => t.status === 'completed' && (t.result?.reviewer_decision?.passed === true || t.result?.verification?.passed === true));
      const repairBudgetExhausted = result.repair_budget_exhausted === true || (task.attempt >= (task.max_attempts || 3));
      const repairTaskMissing = !hasSuccessor && successors.length === 0;

      if (completedAcceptedSuccessor) {
        taskObj.classification = 'repair_successor_completed_accepted';
        taskObj.proposed_action = 'inherit_repair_and_complete';
      } else if (repairTaskMissing) {
        taskObj.classification = 'repair_task_missing';
        taskObj.proposed_action = 'create_repair_task';
      } else if (repairBudgetExhausted) {
        taskObj.classification = 'repair_budget_exhausted';
        taskObj.proposed_action = 'human_terminal_decision';
      } else {
        taskObj.classification = 'repair_pending';
        taskObj.proposed_action = 'queue_next_repair';
      }
      taskObj.evidence = { has_successor: !!hasSuccessor, successors_count: successors.length, completed_accepted_successor: completedAcceptedSuccessor, budget_exhausted: repairBudgetExhausted };
    } else if (ns === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
      // Use integration-backlog-reconciler
      try {
        const result = task.result || {};
        const classification = classifyIntegrationState({ task, result, canonicalRepoPath: config.defaultRepoPath || config.defaultWorkspaceRoot || null });
        taskObj.classification = classification.classification;
        taskObj.evidence = classification.evidence;

        if (classification.classification === INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED) {
          taskObj.proposed_action = 'auto_complete';
        } else if (classification.classification === INTEGRATION_RECONCILIATION_TYPES.WAITING_FOR_EXTERNAL_INTEGRATION) {
          taskObj.proposed_action = 'wait_for_external'; // Not a current blocker
        } else if (classification.classification === INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE) {
          taskObj.proposed_action = 'auto_repair';
        } else if (classification.classification === INTEGRATION_RECONCILIATION_TYPES.INTEGRATION_NOT_NEEDED) {
          taskObj.proposed_action = 'auto_complete';
        } else if (classification.classification === INTEGRATION_RECONCILIATION_TYPES.COMMIT_NOT_ON_MAIN) {
          taskObj.proposed_action = 'wait_for_external';
        } else {
          taskObj.proposed_action = 'manual_review';
        }
      } catch (err) {
        taskObj.classification = 'classification_error';
        taskObj.proposed_action = 'manual_review';
        taskObj.evidence = { error: err.message };
      }
    } else if (isFailedTerminalStatus(ns)) {
      try {
        const classification = classifyBlocker(task);
        taskObj.classification = classification.classification;
        taskObj.proposed_action = classification.recommended_next_action;
        taskObj.evidence = classification.evidence;
      } catch (err) {
        taskObj.classification = 'classification_error';
        taskObj.proposed_action = 'manual_review';
        taskObj.evidence = { error: err.message };
      }
    }

    typingCounts[taskObj.classification] = (typingCounts[taskObj.classification] || 0) + 1;
    convergence.push(taskObj);
  }

  const typingSummary = {};
  for (const [key, count] of Object.entries(typingCounts)) {
    const category = key.includes('auto_') || key.includes('repair_') ? 'machine_actionable' :
                     key === 'true_human_review' ? 'true_human_review' :
                     key === 'wait_for_external' ? 'external_wait' :
                     'needs_manual_review';
    if (!typingSummary[category]) typingSummary[category] = { count: 0, types: {} };
    typingSummary[category].count += count;
    typingSummary[category].types[key] = count;
  }

  return {
    scanned_at,
    total_backlog: convergence.length,
    convergence,
    typing_summary: typingSummary,
    diagnostics: {
      machine_actionable: typingSummary.machine_actionable?.count || 0,
      true_human_review: typingSummary.true_human_review?.count || 0,
      external_wait: typingSummary.external_wait?.count || 0,
      needs_manual_review: typingSummary.needs_manual_review?.count || 0,
    },
  };
}
