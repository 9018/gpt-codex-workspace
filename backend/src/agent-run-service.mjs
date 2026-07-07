import { randomUUID } from "node:crypto";
import { DEFAULT_AGENT_PIPELINE, normalizeAgentRole, validateAgentRoles } from "./subagent-policy.mjs";
import { ARTIFACT_SCHEMA, AGENT_ROLE_ENUM, normalizeContractRole, validateAgentArtifactContract } from "./agent-artifact-contract.mjs";
import { missingAgentRunEvidence } from "./evidence/operation-evidence-profiles.mjs";

const STATUSES = new Set(["queued", "running", "completed", "failed", "waiting_for_review", "cancelled", "skipped"]);

function now() {
  return new Date().toISOString();
}

function ensureAgentRuns(state) {
  if (!Array.isArray(state.agent_runs)) state.agent_runs = [];
  return state.agent_runs;
}

function normalizeStatus(status, fallback = "queued") {
  return STATUSES.has(status) ? status : fallback;
}

function normalizeStoredAgentRole(role) {
  const value = role || "builder";
  normalizeAgentRole(value);
  return value;
}

export async function createAgentRun(store, args = {}, context = {}) {
  const result = await store.mutate((state) => {
    const at = now();
    const agentRun = {
      id: `agent_run_${randomUUID()}`,
      goal_id: args.goal_id || "",
      task_id: args.task_id || "",
      role: normalizeStoredAgentRole(args.role),
      contract_role: normalizeAgentRole(args.role),
      agent: args.agent || "codex",
      status: normalizeStatus(args.status),
      input_artifacts: Array.isArray(args.input_artifacts) ? args.input_artifacts : [],
      output_artifacts: Array.isArray(args.output_artifacts) ? args.output_artifacts : [],
      summary: args.summary || "",
      events: [],
      created_at: at,
      updated_at: at,
    };
    ensureAgentRuns(state).push(agentRun);
    return { agent_run: agentRun };
  });
  await context.eventLogger?.append("agent_run.created", { agent_run_id: result.agent_run.id, goal_id: result.agent_run.goal_id, task_id: result.agent_run.task_id, role: result.agent_run.role, agent: result.agent_run.agent });
  await context.hookBus?.emit("onAgentRunStarted", { agent_run: result.agent_run });
  return result;
}

export async function listAgentRuns(store, args = {}) {
  const state = await store.load();
  let runs = ensureAgentRuns(state);
  if (args.goal_id) runs = runs.filter((run) => run.goal_id === args.goal_id);
  if (args.task_id) runs = runs.filter((run) => run.task_id === args.task_id);
  if (args.role) runs = runs.filter((run) => run.role === args.role || run.contract_role === args.role);
  if (args.status) runs = runs.filter((run) => run.status === args.status);
  return { agent_runs: runs.slice(-(Number(args.limit) || 50)).reverse() };
}

export async function getAgentRun(store, args = {}) {
  const state = await store.load();
  const agentRun = ensureAgentRuns(state).find((run) => run.id === args.agent_run_id) || null;
  if (!agentRun) throw new Error(`agent run not found: ${args.agent_run_id}`);
  return { agent_run: agentRun };
}

export async function appendAgentEvent(store, args = {}, context = {}) {
  return store.mutate(async (state) => {
    const agentRun = ensureAgentRuns(state).find((run) => run.id === args.agent_run_id);
    if (!agentRun) throw new Error(`agent run not found: ${args.agent_run_id}`);
    const event = {
      type: args.type || "progress",
      message: args.message || "",
      data: args.data || {},
      created_at: now(),
    };
    if (!Array.isArray(agentRun.events)) agentRun.events = [];
    agentRun.events.push(event);
    agentRun.updated_at = event.created_at;
    await context.eventLogger?.append("agent_run.event", { agent_run_id: agentRun.id, type: event.type, message: event.message });
    await context.hookBus?.emit("onAgentRunEvent", { agent_run: agentRun, event });
    return { agent_run: agentRun, event };
  });
}

export async function completeAgentRun(store, args = {}, context = {}) {
  const result = await store.mutate((state) => {
    const agentRun = ensureAgentRuns(state).find((run) => run.id === args.agent_run_id);
    if (!agentRun) throw new Error(`agent run not found: ${args.agent_run_id}`);
    agentRun.status = normalizeStatus(args.status, "completed");
    agentRun.summary = args.summary || agentRun.summary || "";
    if (Array.isArray(args.output_artifacts)) agentRun.output_artifacts = args.output_artifacts;
    agentRun.updated_at = now();
    if (!Array.isArray(agentRun.events)) agentRun.events = [];
    agentRun.events.push({ type: "completed", message: agentRun.summary, data: { status: agentRun.status }, created_at: agentRun.updated_at });
    return { agent_run: agentRun };
  });
  await context.eventLogger?.append("agent_run.completed", { agent_run_id: result.agent_run.id, status: result.agent_run.status, summary: result.agent_run.summary });
  await context.hookBus?.emit("onAgentRunCompleted", { agent_run: result.agent_run });
  return result;
}

export async function runAgentPipeline(store, args = {}, context = {}) {
  const pipelineId = `pipeline_${randomUUID()}`;
  const roles = validateAgentRoles(args.roles || DEFAULT_AGENT_PIPELINE);
  const executionOrder = validateAgentRoles(args.execution_order || roles);
  const reviewGateAfter = args.review_gate_after || "reviewer";
  normalizeAgentRole(reviewGateAfter);
  const pipeline = {
    id: pipelineId,
    goal_id: args.goal_id || "",
    task_id: args.task_id || "",
    roles,
    review_gate_after: reviewGateAfter,
    execution_order: executionOrder,
    status: "created",
    created_at: now(),
  };
  const created = [];
  for (const role of roles) {
    const result = await createAgentRun(store, { ...args, role, status: "queued" }, context);
    created.push(result.agent_run);
  }
  pipeline.agent_run_ids = created.map((r) => r.id);
  pipeline.updated_at = now();
  await context.eventLogger?.append("pipeline.created", { pipeline_id: pipelineId, goal_id: pipeline.goal_id, task_id: pipeline.task_id, roles, agent_run_ids: pipeline.agent_run_ids });
  return { pipeline, agent_runs: created, count: created.length };
}

export async function cancelAgentRun(store, args = {}, context = {}) {
  const result = await store.mutate((state) => {
    const agentRun = ensureAgentRuns(state).find((run) => run.id === args.agent_run_id);
    if (!agentRun) throw new Error(`agent run not found: ${args.agent_run_id}`);
    agentRun.status = "cancelled";
    agentRun.summary = args.reason || "cancelled";
    agentRun.updated_at = now();
    if (!Array.isArray(agentRun.events)) agentRun.events = [];
    agentRun.events.push({ type: "cancelled", message: agentRun.summary, data: {}, created_at: agentRun.updated_at });
    return { agent_run: agentRun };
  });
  await context.eventLogger?.append("agent_run.cancelled", { agent_run_id: result.agent_run.id, reason: args.reason || "" });
  await context.hookBus?.emit("onAgentRunCancelled", { agent_run: result.agent_run });
  return result;
}

export function buildSubagentsFromAgentRuns(agentRuns = []) {
  return [...agentRuns]
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .map((run) => ({
      role: run.role,
      contract_role: normalizeContractRole(run.role),
      status: run.status,
      summary: run.summary || "",
      agent_run_id: run.id,
      started_at: run.created_at || null,
      completed_at: run.updated_at || null,
    }));
}

export function agentRunsBlockCompletion(agentRuns = []) {
  const blockingRoles = new Set(["verifier", "reviewer", "finalizer", "integrator"]);
  return agentRuns.some((run) => {
    const role = normalizeAgentRole(run.role);
    if (!blockingRoles.has(role)) return false;
    if (!["completed", "skipped"].includes(run.status)) return true;
    if (run.status === "skipped") return false;
    return !validateAgentArtifactContract(run).valid;
  });
}

// ---------------------------------------------------------------------------
// P1: Multi-agent pipeline completion gates
// ---------------------------------------------------------------------------
// Extends the abstract state-recording pipeline with concrete artifact gates.
// The acceptance/reviewer/finalizer roles must produce output before the
// task can proceed to completion.
//
// Gate order follows the G2 role/artifact contract.
//
// Each gate:
// - Checks whether its required agent run is completed
// - Collects output artifacts (summary, result, evidence)
// - Reports whether the gate is satisfied

/** Ordered roles for gating task completion */
const GATE_ROLES = AGENT_ROLE_ENUM.filter((role) => role !== "repairer");
const BASE_GATE_ROLES = ["planner", "builder", "verifier", "reviewer", "finalizer"];

/**
 * Get all artifacts from completed agent runs for a task/goal.
 *
 * @param {object[]} agentRuns - Array of agent run objects from the store
 * @param {string} [role] - Optional role filter
 * @returns {Array<{ role: string, status: string, summary: string, artifacts: string[] }>}
 */
export function getAgentRunArtifacts(agentRuns = [], role) {
  const roleFilter = role ? normalizeContractRole(role) : null;
  return agentRuns
    .filter((run) => {
      const runRole = normalizeContractRole(run.role);
      if (roleFilter && runRole !== roleFilter) return false;
      return ["completed", "skipped"].includes(run.status);
    })
    .map((run) => ({
      role: run.role,
      contract_role: normalizeContractRole(run.role),
      status: run.status,
      summary: run.summary || "",
      artifacts: [
        ...(Array.isArray(run.input_artifacts) ? run.input_artifacts : []),
        ...(Array.isArray(run.output_artifacts) ? run.output_artifacts : []),
      ],
      completed_at: run.updated_at || null,
      agent_run_id: run.id,
    }));
}

/**
 * Evaluate whether the agent pipeline gates are satisfied for a given
 * set of agent runs.
 *
 * @param {object[]} agentRuns - Array of agent run objects
 * @returns {{
 *   gates_satisfied: boolean,
 *   gates: Array<{ role: string, satisfied: boolean, required_fields: string[], missing_fields: string[], summary: string }>,
 *   blocking_gates: string[],
 *   last_completed_role: string|null,
 * }}
 */
export function evaluateAgentGates(agentRuns = []) {
  const gates = [];
  let lastCompletedRole = null;
  const presentRoles = new Set(agentRuns.map((run) => normalizeContractRole(run.role)));
  const gateRoles = GATE_ROLES.filter((role) => BASE_GATE_ROLES.includes(role) || presentRoles.has(role));

  for (const role of gateRoles) {
    const runs = agentRuns.filter((r) => normalizeContractRole(r.role) === role);
    const completedRun = runs.find((r) => r.status === "completed");
    const skippedRun = runs.find((r) => r.status === "skipped");
    const artifactValidation = completedRun ? validateAgentArtifactContract(completedRun) : null;
    const roleEvidenceValidation = completedRun ? missingAgentRunEvidence(completedRun) : [];

    const missingEvidence = [

      ...(artifactValidation?.missing_artifacts || []),

      ...roleEvidenceValidation.map(e => e.evidence_field || e.artifact_kind || e.code),

    ];

    const satisfied = Boolean(skippedRun || (completedRun && artifactValidation.valid));

    if (completedRun) lastCompletedRole = completedRun.role || role;

    const requiredArtifacts = Array.from(ARTIFACT_SCHEMA.required_by_role[role] || []);
    const missingArtifacts = completedRun ? artifactValidation.missing_artifacts : requiredArtifacts;

    gates.push({
      role: completedRun?.role || skippedRun?.role || runs[0]?.role || role,
      contract_role: role,
      satisfied,
      required_fields: requiredArtifacts,
      missing_fields: missingArtifacts,
      required_artifacts: requiredArtifacts,
      missing_artifacts: missingArtifacts,
      findings: artifactValidation?.findings || [],
      summary: completedRun?.summary || (skippedRun ? "(skipped)" : ""),
      status: completedRun ? "completed" : skippedRun ? "skipped" : runs.some((r) => r.status === "failed") ? "failed" : "pending",
    });
  }

  const blockingGates = gates
    .filter((g) => !g.satisfied)
    .map((g) => g.role);

  return {
    gates_satisfied: blockingGates.length === 0,
    gates,
    blocking_gates: blockingGates,
    last_completed_role: lastCompletedRole,
  };
}

/**
 * Build a consolidated completion artifact from agent pipeline output.
 * This artifact can be stored as part of the task result.
 *
 * @param {object[]} agentRuns - Array of agent run objects
 * @returns {object} Consolidated completion artifact
 */
export function buildAgentCompletionArtifact(agentRuns = []) {
  const gateStatus = evaluateAgentGates(agentRuns);
  const artifacts = getAgentRunArtifacts(agentRuns);

  return {
    pipeline_type: "agent_pipeline",
    gates_satisfied: gateStatus.gates_satisfied,
    gates: gateStatus.gates,
    artifacts,
    last_completed_role: gateStatus.last_completed_role,
    completed_at: new Date().toISOString(),
    summary: artifacts
      .filter((a) => a.summary)
      .map((a) => `[${a.role}] ${a.summary}`)
      .join("\n"),
  };
}
