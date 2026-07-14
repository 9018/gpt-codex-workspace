import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { completeAgentRun } from "./agent-run-service.mjs";
import { syncAgentRunProgress } from "./subagent-progress-bridge.mjs";

const FORMAL_ROLES = new Set([
  "context_curator",
  "planner",
  "builder",
  "verifier",
  "reviewer",
  "finalizer",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isReadonlyDiagnostic(task, goal, result) {
  const contract = object(task?.acceptance_contract || goal?.acceptance_contract);
  const intent = object(contract.intent);
  const requirements = object(contract.requirements);
  const operationKind = String(intent.operation_kind || "");
  const mutationScope = String(intent.mutation_scope || "");
  const requiresCommit = requirements.requires_commit ?? contract.requires_commit ?? true;
  return requiresCommit === false
    && (operationKind === "diagnostic" || result?.execution_mode === "readonly_diagnostic")
    && (!mutationScope || mutationScope === "none");
}

function artifactForRole(role, { goalId, digest, snapshot }) {
  const base = `.gptwork/goals/${goalId}`;
  const resultPath = `${base}/result.json`;
  const metadata = {
    context_digest: digest,
    git: {
      base_head: null,
      input_head: snapshot.commit || null,
      output_head: snapshot.commit || null,
    },
    auto_derived: true,
    source: "tui_completed_diagnostic_progress",
  };
  const common = { role, required: true, present: true, metadata };
  switch (role) {
    case "context_curator": return { ...common, kind: "context_bundle", path: `${base}/context.bundle.md` };
    case "planner": return { ...common, kind: "plan", path: resultPath };
    case "builder": return { ...common, kind: "change_summary", path: resultPath, changed_count: 0, commit: null };
    case "verifier": return { ...common, kind: "verification", path: resultPath, passed: snapshot.result_json?.verification?.passed === true };
    case "reviewer": return { ...common, kind: "reviewer_decision", path: resultPath, passed: true, status: "accepted" };
    case "finalizer": return { ...common, kind: "result", path: resultPath, status: snapshot.result_json?.status || "verified" };
    default: return null;
  }
}

export async function reconcileTuiAgentRunsFromProgress({ store, workspaceRoot, snapshot } = {}) {
  if (!store || !workspaceRoot || !snapshot?.task_id || !snapshot?.goal_id) {
    return { reconciled: false, reason: "missing_inputs", formal_completed: 0, advisory_completed: 0 };
  }
  if (!snapshot.result_json_valid || !snapshot.worktree_clean || !snapshot.result_json) {
    return { reconciled: false, reason: "incomplete_result_evidence", formal_completed: 0, advisory_completed: 0 };
  }
  if (Array.isArray(snapshot.result_json.blockers) && snapshot.result_json.blockers.length > 0) {
    return { reconciled: false, reason: "result_has_blockers", formal_completed: 0, advisory_completed: 0 };
  }

  const state = await store.load();
  const task = (state.tasks || []).find((item) => item.id === snapshot.task_id);
  const goal = (state.goals || []).find((item) => item.id === snapshot.goal_id);
  if (!task || !goal || !isReadonlyDiagnostic(task, goal, snapshot.result_json)) {
    return { reconciled: false, reason: "not_readonly_diagnostic", formal_completed: 0, advisory_completed: 0 };
  }

  const digest = task.task_context_digest || goal.task_context?.contract_digest || null;
  if (!digest) return { reconciled: false, reason: "context_digest_missing", formal_completed: 0, advisory_completed: 0 };
  if (snapshot.task_context_digest !== digest) {
    return { reconciled: false, reason: "session_context_digest_mismatch", formal_completed: 0, advisory_completed: 0 };
  }
  if (snapshot.result_json.goal_id && snapshot.result_json.goal_id !== snapshot.goal_id) {
    return { reconciled: false, reason: "result_goal_mismatch", formal_completed: 0, advisory_completed: 0 };
  }
  if (snapshot.result_json.task_id && snapshot.result_json.task_id !== snapshot.task_id) {
    return { reconciled: false, reason: "result_task_mismatch", formal_completed: 0, advisory_completed: 0 };
  }
  if (snapshot.result_json.verification?.passed !== true || !["verified", "completed"].includes(String(snapshot.result_json.status))) {
    return { reconciled: false, reason: "diagnostic_verification_not_passed", formal_completed: 0, advisory_completed: 0 };
  }

  const progress = await readJson(join(workspaceRoot, ".gptwork", "goals", snapshot.goal_id, "progress.json"));
  const entries = Array.isArray(progress?.subagents) ? progress.subagents : [];
  const progressById = new Map(entries
    .filter((entry) => entry?.agent_run_id && entry?.input_context_digest === digest)
    .map((entry) => [entry.agent_run_id, entry]));

  let formalCompleted = 0;
  const formalRuns = (state.agent_runs || []).filter((run) => run.task_id === snapshot.task_id && FORMAL_ROLES.has(run.role));
  for (const run of formalRuns) {
    const entry = progressById.get(run.id);
    if (run.input_context_digest !== digest) continue;
    const artifact = artifactForRole(run.role, { goalId: snapshot.goal_id, digest, snapshot });
    if (!artifact) continue;
    await completeAgentRun(store, {
      agent_run_id: run.id,
      status: "completed",
      summary: entry?.summary || `${run.role} completed from verified diagnostic TUI result`,
      output_artifacts: [artifact],
    });
    formalCompleted += 1;
  }

  let advisoryCompleted = 0;
  await store.mutate((mutable) => {
    for (const run of mutable.advisory_runs || []) {
      if (run.task_id !== snapshot.task_id || run.input_context_digest !== digest) continue;
      advisoryCompleted += 1;
      const entry = progressById.get(run.id);
      run.status = "completed";
      run.summary = entry?.summary || `${run.role} completed from verified diagnostic TUI result`;
      run.output_artifact = {
        kind: "diagnostic_analysis",
        path: snapshot.result_json_path || `.gptwork/goals/${snapshot.goal_id}/result.json`,
        digest: null,
        context_digest: digest,
      };
      run.updated_at = new Date().toISOString();
    }
  });

  await syncAgentRunProgress({
    store,
    workspaceRoot,
    goalId: snapshot.goal_id,
    taskId: snapshot.task_id,
  }).catch(() => {});

  return {
    reconciled: formalCompleted > 0 || advisoryCompleted > 0,
    reason: formalCompleted > 0 || advisoryCompleted > 0 ? "completed_from_verified_diagnostic_result" : "no_context_bound_runs",
    formal_completed: formalCompleted,
    advisory_completed: advisoryCompleted,
    context_digest: digest,
  };
}
