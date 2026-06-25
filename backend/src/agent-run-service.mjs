import { randomUUID } from "node:crypto";
import { DEFAULT_AGENT_PIPELINE, normalizeAgentRole, validateAgentRoles } from "./subagent-policy.mjs";

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

export async function createAgentRun(store, args = {}, context = {}) {
  const result = await store.mutate((state) => {
    const at = now();
    const agentRun = {
      id: `agent_run_${randomUUID()}`,
      goal_id: args.goal_id || "",
      task_id: args.task_id || "",
      role: normalizeAgentRole(args.role),
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
  const reviewGateAfter = normalizeAgentRole(args.review_gate_after || "reviewer");
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
      status: run.status,
      summary: run.summary || "",
      agent_run_id: run.id,
      started_at: run.created_at || null,
      completed_at: run.updated_at || null,
    }));
}

export function agentRunsBlockCompletion(agentRuns = []) {
  const blockingRoles = new Set(["tester", "reviewer", "finalizer"]);
  return agentRuns.some((run) => blockingRoles.has(run.role) && !["completed", "skipped"].includes(run.status));
}
