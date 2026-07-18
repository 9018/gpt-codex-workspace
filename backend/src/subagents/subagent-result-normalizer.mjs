/**
 * subagent-result-normalizer.mjs — Normalizes subagent results to a consistent structure.
 *
 * Raw subagent results come from various execution backends (codex_exec, local_command,
 * auto_artifact). This module normalizes them into a uniform shape for progress.json
 * and subagents.json consumption by ChatGPT and controllers, without ANSI parsing.
 *
 * Normalized shape per subagent:
 *   { role, round, phase, status, summary, changed_files, artifacts,
 *     blockers, started_at, completed_at, evidence }
 */

import { getPhaseForRoleInfo, isRepairRole } from "./subagent-policy.mjs";

// -- Constants ---------------------------------------------------------------

const VALID_STATUSES = new Set(["declared", "not_spawned", "spawning", "running", "completed", "failed", "skipped"]);

// -- Helpers -----------------------------------------------------------------

function normalizeStatus(status, fallback = "declared") {
  return VALID_STATUSES.has(status) ? status : fallback;
}

function normalizeString(val, fallback = "") {
  return val && typeof val === "string" ? val : fallback;
}

function normalizeArray(val) {
  return Array.isArray(val) ? val : [];
}

function normalizeObject(val, fallback = {}) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : fallback;
}

// -- Normalizer --------------------------------------------------------------

/**
 * Normalize a single raw subagent result into the canonical shape.
 *
 * @param {object} raw - Raw subagent result from any backend
 * @returns {object} Normalized subagent result
 */
export function normalizeSubagentResult(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      role: "",
      round: 1,
      phase: "",
      status: "failed",
      summary: "Invalid subagent result (empty or non-object)",
      changed_files: [],
      artifacts: [],
      blockers: [],
      started_at: null,
      completed_at: null,
      evidence: {},
    };
  }

  const role = normalizeString(raw.role, "builder");
  const round = typeof raw.round === "number" && raw.round >= 1 ? raw.round : 1;

  let phase = normalizeString(raw.phase);
  if (!phase) {
    try {
      const phaseInfo = getPhaseForRoleInfo(role);
      phase = phaseInfo ? phaseInfo.name : "";
    } catch {
      phase = "";
    }
  }

  const status = normalizeStatus(raw.status);
  const summary = normalizeString(raw.summary);
  const changedFiles = normalizeArray(raw.changed_files || raw.changedFiles || raw.changed);
  const artifacts = normalizeArray(raw.artifacts || raw.output_artifacts || raw.artifacts_output);
  const blockers = normalizeArray(raw.blockers || raw.blocking_findings || raw.blocked_by);
  const startedAt = raw.started_at || raw.startedAt || null;
  const completedAt = raw.completed_at || raw.completedAt || raw.updated_at || null;

  // Extract evidence from various possible formats
  const evidence = normalizeObject(raw.evidence, {});
  if (raw.output_artifacts && !raw.artifacts) {
    // Already handled above
  }
  if (raw.result_json) {
    evidence.result_json = raw.result_json;
  }
  if (raw.result_md) {
    evidence.result_md = raw.result_md;
  }
  if (raw.exit_code !== undefined) {
    evidence.exit_code = raw.exit_code;
  }

  return {
    role,
    round,
    phase,
    status,
    summary,
    changed_files: changedFiles,
    artifacts,
    blockers,
    started_at: startedAt,
    completed_at: completedAt,
    evidence: Object.keys(evidence).length > 0 ? evidence : undefined,
  };
}

/**
 * Normalize an array of raw subagent results.
 *
 * @param {object[]} rawArray - Array of raw subagent results
 * @returns {object[]} Array of normalized subagent results
 */
export function normalizeSubagentResults(rawArray = []) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map(normalizeSubagentResult);
}

/**
 * Build subagents.json compatible array from normalized results,
 * merging by role+round deduplication.
 *
 * @param {object[]} normalizedResults - Array of normalized subagent results
 * @returns {object[]} Deduplicated subagents array
 */
export function deduplicateSubagentResults(normalizedResults = []) {
  const merged = [];
  for (const result of normalizedResults) {
    const existing = merged.findIndex(
      (s) => s.role === result.role && s.round === result.round
    );
    if (existing >= 0) {
      merged[existing] = { ...merged[existing], ...result };
    } else {
      merged.push({ ...result });
    }
  }
  return merged;
}

/**
 * Infer the overall pipeline status from a set of subagent results.
 *
 * @param {object[]} subagents - Array of normalized subagent results
 * @returns {string} One of: "running", "completed", "failed"
 */
export function inferPipelineStatus(subagents = []) {
  if (!Array.isArray(subagents) || subagents.length === 0) return "running";

  const statuses = subagents.map((s) => s.status);

  // If any agent is blocked, pipeline is blocked
  if (statuses.includes("blocked")) return "blocked";

  // If any agent failed (not a repair round), pipeline is failed
  const failures = subagents.filter((s) => s.status === "failed" && !isRepairRole(s.role));
  if (failures.length > 0) return "failed";

  // If any agent is still running, pipeline is running
  if (statuses.includes("running")) return "running";

  // If any agent is declared (not yet started), pipeline is running
  if (statuses.includes("declared") || statuses.includes("spawning")) return "running";

  // If any agent has no started_at, pipeline is running
  const unstarted = subagents.filter((s) => s.role !== "repairer" && s.status === "declared" && !s.started_at);
  if (unstarted.length > 0) return "running";

  // All agents completed/failed/skipped/not_spawned
  const ended = subagents.filter((s) => ["completed", "failed", "skipped", "cancelled", "not_spawned"].includes(s.status));
  if (ended.length > 0 && ended.length === subagents.length) {
    // If finalizer completed, pipeline is completed
    const finalizer = subagents.find((s) => s.role === "finalizer");
    if (finalizer && finalizer.status === "completed") return "completed";

    // Check if everything passed or was skipped
    const allOk = subagents.every((s) =>
      ["completed", "skipped", "cancelled"].includes(s.status) || s.role === "repairer"
    );
    if (allOk) return "completed";

    return "failed";
  }

  return "running";
}

/**
 * Extract the current phase from a set of subagent results.
 *
 * @param {object[]} subagents - Array of normalized subagent results
 * @returns {string} Current phase name
 */
export function inferCurrentPhase(subagents = []) {
  if (!Array.isArray(subagents) || subagents.length === 0) return "context_curation";

  const running = subagents.find((s) => s.status === "running");
  if (running) return running.phase || "context_curation";

  const pending = subagents.find((s) => s.status === "pending");
  if (pending) return pending.phase || "context_curation";

  // All done — return last phase
  const last = subagents[subagents.length - 1];
  return last ? last.phase || "finalization" : "context_curation";
}

/**
 * Collect blockers from all subagent results.
 *
 * @param {object[]} subagents - Array of normalized subagent results
 * @returns {string[]} Combined list of unique blockers
 */
export function collectBlockers(subagents = []) {
  const blockers = new Set();
  for (const agent of subagents) {
    if (agent.status === "blocked" && Array.isArray(agent.blockers)) {
      for (const blocker of agent.blockers) {
        blockers.add(blocker);
      }
    }
  }
  return [...blockers];
}

/**
 * Determines the next expected event based on current pipeline state.
 *
 * @param {object[]} subagents - Array of normalized subagent results
 * @returns {string} Description of the next expected event
 */
export function inferNextExpectedEvent(subagents = []) {
  if (!Array.isArray(subagents) || subagents.length === 0) return "pipeline_start";

  const pipelineStatus = inferPipelineStatus(subagents);
  if (pipelineStatus === "completed") return "task_completion";
  if (pipelineStatus === "failed") return "recovery_or_repair";
  if (pipelineStatus === "blocked") return "blocker_resolution";

  const pending = subagents.find((s) => s.status === "pending");
  if (pending) {
    if (pending.role === "repairer" && pending.round <= 2) {
      return `repair_round_${pending.round}_of_2`;
    }
    if (pending.phase === "analysis" && pending.role !== "context_curator") {
      return "parallel_analysis_completion";
    }
    return `${pending.role || pending.phase}_start`;
  }

  const running = subagents.find((s) => s.status === "running");
  if (running) return `${running.role || "agent"}_completion`;

  return "pipeline_advance";
}
