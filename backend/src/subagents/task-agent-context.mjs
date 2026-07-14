import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createTaskContextStore } from "../context-contract/task-context-store.mjs";
import { createWorkstreamContextStore } from "../workstream/workstream-context-store.mjs";
import { compileRoleView } from "./role-view-compiler.mjs";
import { ADVISORY_ROLE_ENUM } from "./advisory-artifact-contract.mjs";
import { TASK_ISOLATED_AGENT_PIPELINE, REPAIRER_ROLE } from "../subagent-policy.mjs";

function digest(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function atomicJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

function ensureAdvisoryRuns(state) {
  if (!Array.isArray(state.advisory_runs)) state.advisory_runs = [];
  return state.advisory_runs;
}

export async function prepareTaskAgentContext(store, { task_id, goal_id } = {}) {
  const state = await store.load();
  const task = (state.tasks || []).find((item) => item.id === task_id);
  const goal = (state.goals || []).find((item) => item.id === (goal_id || task?.goal_id));
  if (!task || !goal) throw new Error("task and goal are required for role context preparation");
  const workspaceRoot = store.defaultWorkspaceRoot;
  if (!workspaceRoot) throw new Error("defaultWorkspaceRoot is required for role context preparation");

  const contextStore = createTaskContextStore({ workspaceRoot });
  const packet = await contextStore.readPacket(`.gptwork/goals/${goal.id}`);
  if (!packet) return { prepared: false, reason: "task_context_missing", role_views: {}, advisory_runs: [] };
  const contextDigest = task.task_context_digest || goal.task_context?.contract_digest || null;
  let workstreamSnapshot = null;
  if (task.workstream_id || goal.workstream_id) {
    workstreamSnapshot = await createWorkstreamContextStore({ workspaceRoot })
      .readSnapshot(task.workstream_id || goal.workstream_id)
      .catch(() => null);
  }

  const goalDir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  const rolesDir = join(goalDir, "roles");
  await mkdir(rolesDir, { recursive: true });

  const advisoryRuns = await store.mutate((mutable) => {
    const runs = ensureAdvisoryRuns(mutable);
    const created = [];
    for (const role of ADVISORY_ROLE_ENUM) {
      let run = runs.find((item) => item.task_id === task.id && item.role === role && !["cancelled", "failed"].includes(item.status));
      if (!run) {
        const at = new Date().toISOString();
        run = {
          id: `advisory_run_${randomUUID()}`,
          workstream_id: task.workstream_id || goal.workstream_id || null,
          goal_id: goal.id,
          task_id: task.id,
          execution_id: null,
          session_id: null,
          role,
          role_kind: "advisory",
          blocking: false,
          status: "queued",
          input_context_digest: contextDigest,
          input_head: null,
          output_artifact: null,
          created_at: at,
          updated_at: at,
        };
        runs.push(run);
      }
      created.push(run);
    }
    return created;
  });

  const sources = {
    objective: packet.objective,
    background: packet.background,
    confirmed_findings: packet.confirmed_findings,
    scope: packet.scope,
    constraints: packet.constraints,
    acceptance_criteria: packet.acceptance_criteria,
    open_questions: packet.open_questions,
    workstream_decisions: workstreamSnapshot?.durable_decisions || [],
    advisory_artifacts: advisoryRuns.map((run) => ({ role: run.role, run_id: run.id, status: run.status })),
  };
  const roles = [...ADVISORY_ROLE_ENUM, ...TASK_ISOLATED_AGENT_PIPELINE, REPAIRER_ROLE];
  const roleViews = {};
  for (const role of roles) {
    const view = compileRoleView({ role, taskContextDigest: contextDigest, sources });
    view.view_digest = digest(view);
    const relativePath = `.gptwork/goals/${goal.id}/roles/${role}.view.json`;
    await atomicJson(join(workspaceRoot, relativePath), view);
    roleViews[role] = { path: relativePath, digest: view.view_digest, view };
  }

  return {
    prepared: true,
    task_context_digest: contextDigest,
    workstream_context_revision: workstreamSnapshot?.revision || null,
    workstream_context_digest: workstreamSnapshot?.digest || null,
    role_views: roleViews,
    advisory_runs: advisoryRuns,
  };
}
