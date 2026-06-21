import { randomUUID } from "node:crypto";

const ROLES = new Set(["planner", "architect", "implementer", "tester", "reviewer", "finalizer"]);
const STATUSES = new Set(["queued", "running", "completed", "failed", "waiting_for_review"]);

function now() {
  return new Date().toISOString();
}

function ensureAgentRuns(state) {
  if (!Array.isArray(state.agent_runs)) state.agent_runs = [];
  return state.agent_runs;
}

function normalizeRole(role) {
  return ROLES.has(role) ? role : "implementer";
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
      role: normalizeRole(args.role),
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
  await context.hookBus?.emit("onAgentRunStarted", result);
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

export async function appendAgentEvent(store, args = {}) {
  return store.mutate((state) => {
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
  await context.hookBus?.emit("onAgentRunCompleted", result);
  return result;
}

export async function runAgentPipeline(store, args = {}) {
  const roles = Array.isArray(args.roles) && args.roles.length ? args.roles : ["planner", "implementer", "tester", "reviewer", "finalizer"];
  const created = [];
  for (const role of roles) {
    const result = await createAgentRun(store, { ...args, role, status: "queued" });
    created.push(result.agent_run);
  }
  return { agent_runs: created, count: created.length };
}
