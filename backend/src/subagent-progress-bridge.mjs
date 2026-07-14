/**
 * subagent-progress-bridge.mjs — Bridges agent run lifecycle to subagent progress store.
 *
 * Reads agent_run records from the state store and writes structured progress
 * to progress.json and subagents.json in the goal directory.
 *
 * This is the key link between the multi-agent pipeline lifecycle and the
 * parent TUI's structured progress tracking (codex_tui_progress / codex_tui_subagents tools).
 *
 * P0-MA12-G5: Main chain linking — Agent → Subagent Progress → Parent TUI.
 */

import { createSubagentProgressStore } from "./subagents/subagent-progress-store.mjs";
import { inferPipelineStatus, inferCurrentPhase, inferNextExpectedEvent, collectBlockers } from "./subagents/subagent-result-normalizer.mjs";

const PHASE_BY_ROLE = Object.freeze({
  context_curator: "context_curation",
  explorer: "analysis",
  architect: "analysis",
  test_analyst: "analysis",
  planner: "planning",
  builder: "building",
  verifier: "verification",
  reviewer: "review",
  repairer: "repair",
  integrator: "integration",
  finalizer: "finalization",
});

function phaseForRole(role) {
  return PHASE_BY_ROLE[(role || "").trim()] || (role || "unknown");
}

function nowIso() { return new Date().toISOString(); }

function normalizeStatus(status) {
  if (!status) return "pending";
  if (status === "queued" || status === "waiting_for_review") return "pending";
  return ["completed","running","failed","blocked","skipped","cancelled","pending"].includes(status) ? status : "pending";
}

export function buildProgressFromAgentRuns(agentRuns = []) {
  const subagents = agentRuns.map((run) => ({
    role: run.role || run.contract_role || "unknown",
    role_kind: run.role_kind || "canonical",
    blocking: run.blocking !== false,
    agent_run_id: run.id || null,
    input_context_digest: run.input_context_digest || null,
    role_view_path: run.role_view_path || null,
    round: Number(run.round || 1),
    phase: phaseForRole(run.role || run.contract_role),
    status: normalizeStatus(run.status),
    summary: run.summary || "",
    changed_files: Array.isArray(run.output_artifacts)
      ? run.output_artifacts.filter((a) => a && a.kind === "change_summary").map((a) => a.path).filter(Boolean)
      : [],
    artifacts: Array.isArray(run.output_artifacts) ? run.output_artifacts.filter(Boolean) : [],
    blockers: [],
    started_at: run.created_at || null,
    completed_at: run.updated_at && run.updated_at !== run.created_at ? run.updated_at : null,
  }));
  const running = subagents.filter((s) => s.status === "running");
  return {
    phase: inferCurrentPhase(subagents),
    status: inferPipelineStatus(subagents),
    current_action: running.length > 0 ? `agent_run: ${running.map((s) => s.role).join(", ")}` : "idle",
    blockers: collectBlockers(subagents),
    next_expected_event: inferNextExpectedEvent(subagents),
    last_progress_at: nowIso(),
    subagents,
  };
}

export function buildSubagentsFromAgentRuns(agentRuns = []) {
  return agentRuns.map((run) => ({
    role: run.role || run.contract_role || "unknown",
    role_kind: run.role_kind || "canonical",
    blocking: run.blocking !== false,
    agent_run_id: run.id || null,
    input_context_digest: run.input_context_digest || null,
    role_view_path: run.role_view_path || null,
    round: Number(run.round || 1),
    phase: phaseForRole(run.role || run.contract_role),
    status: normalizeStatus(run.status),
    summary: run.summary || "",
    changed_files: Array.isArray(run.output_artifacts)
      ? run.output_artifacts.filter((a) => a && a.kind === "change_summary").map((a) => a.path).filter(Boolean)
      : [],
    artifacts: Array.isArray(run.output_artifacts) ? run.output_artifacts.filter(Boolean) : [],
    blockers: [],
    started_at: run.created_at || null,
    completed_at: run.updated_at && run.updated_at !== run.created_at ? run.updated_at : null,
  }));
}

export async function syncAgentRunProgress({ store, workspaceRoot, goalId, taskId, agentRuns } = {}) {
  if (!store || !goalId || !workspaceRoot) return { progress: null, subagents: null };
  let runs = agentRuns;
  if (!runs && taskId) {
    try {
      const state = await store.load();
      const formal = (state.agent_runs || []).filter((run) => run.task_id === taskId);
      const advisory = (state.advisory_runs || []).filter((run) => run.task_id === taskId);
      runs = [...formal, ...advisory].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    } catch {
      return { progress: null, subagents: null };
    }
  }
  if (!runs || runs.length === 0) return { progress: null, subagents: null };
  const progressStore = createSubagentProgressStore({ workspaceRoot });
  const progress = await progressStore.writeProgress(goalId, buildProgressFromAgentRuns(runs));
  const subagents = await progressStore.writeSubagents(goalId, buildSubagentsFromAgentRuns(runs));
  return { progress, subagents };
}
