/**
 * subagent-progress-store.mjs — Atomic progress.json and subagents.json writer.
 *
 * Writes structured progress and subagent state to .gptwork/goals/<goal_id>/
 * using atomic write (write to tmp, rename). This allows ChatGPT and controllers
 * to read execution phase, subagent status, blockers, and artifacts without
 * needing to parse ANSI TUI screen output.
 *
 * Progress structure:
 *   { phase, status, current_action, blockers, next_expected_event,
 *     last_progress_at, subagents: [{ role, status, summary,
 *       changed_files, artifacts, started_at, completed_at, blockers }] }
 *
 * Subagents structure:
 *   [{ role, status, summary, changed_files, artifacts, started_at,
 *      completed_at, blockers, round }]
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// -- Constants ---------------------------------------------------------------

const PROGRESS_FILENAME = "progress.json";
const SUBAGENTS_FILENAME = "subagents.json";
const VALID_STATUSES = new Set(["pending", "running", "completed", "failed", "blocked", "skipped", "cancelled"]);
const VALID_PHASES = new Set([
  "context_curation", "analysis", "planning", "building",
  "verification", "review", "repair", "finalization",
]);

// -- Helpers -----------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function assertSafeGoalId(goalId) {
  if (!goalId || typeof goalId !== "string" || !/^[A-Za-z0-9_-]+$/.test(goalId)) {
    throw new Error(`Unsafe or missing goal_id: ${String(goalId)}`);
  }
  return goalId;
}

function normalizeStatus(status, fallback = "pending") {
  return VALID_STATUSES.has(status) ? status : fallback;
}

function normalizePhase(phase, fallback = "context_curation") {
  return VALID_PHASES.has(phase) ? phase : fallback;
}

// -- Progress store factory --------------------------------------------------

/**
 * Create a subagent progress store for a given workspace root.
 *
 * @param {object} config
 * @param {string} config.workspaceRoot - Workspace root directory
 * @returns {object} Progress store API
 */
export function createSubagentProgressStore({ workspaceRoot }) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");

  const resolvedRoot = resolve(workspaceRoot);

  function goalDir(goalId) {
    const safeId = assertSafeGoalId(goalId);
    return join(resolvedRoot, ".gptwork", "goals", safeId);
  }

  /**
   * Write a progress.json file atomically.
   * Merges with existing progress if present.
   *
   * @param {string} goalId - Goal identifier
   * @param {object} progress - Progress state to write
   * @returns {Promise<object>} Written progress object
   */
  async function writeProgress(goalId, progress = {}) {
    const dir = goalDir(goalId);
    const filePath = join(dir, PROGRESS_FILENAME);
    const tmpPath = join(dir, `${PROGRESS_FILENAME}.${randomUUID()}.tmp`);

    await mkdir(dir, { recursive: true });

    let existing = {};
    try {
      const raw = await readFile(filePath, "utf8");
      existing = JSON.parse(raw);
    } catch {
      // No existing file, start fresh
    }

    const merged = {
      ...existing,
      ...progress,
      goal_id: goalId,
      last_progress_at: nowIso(),
      phase: normalizePhase(progress.phase || existing.phase),
      status: normalizeStatus(progress.status || existing.status || "running"),
      current_action: progress.current_action || existing.current_action || "",
      blockers: Array.isArray(progress.blockers != null ? progress.blockers : existing.blockers)
        ? (progress.blockers ?? existing.blockers) : [],
      next_expected_event: progress.next_expected_event || existing.next_expected_event || "",
      subagents: Array.isArray(progress.subagents != null ? progress.subagents : existing.subagents)
        ? (progress.subagents ?? existing.subagents) : [],
    };

    // If subagents were provided, merge individually by role+round
    if (Array.isArray(progress.subagents)) {
      for (const incoming of progress.subagents) {
        const idx = merged.subagents.findIndex(
          (s) => s.role === incoming.role && (s.round || 1) === (incoming.round || 1)
        );
        const normalized = {
          role: incoming.role || "",
          round: incoming.round || 1,
          phase: incoming.phase || merged.phase,
          status: normalizeStatus(incoming.status),
          summary: incoming.summary || "",
          changed_files: Array.isArray(incoming.changed_files) ? incoming.changed_files : [],
          artifacts: Array.isArray(incoming.artifacts) ? incoming.artifacts : [],
          blockers: Array.isArray(incoming.blockers) ? incoming.blockers : [],
          started_at: incoming.started_at || null,
          completed_at: incoming.completed_at || null,
        };
        if (idx >= 0) {
          merged.subagents[idx] = { ...merged.subagents[idx], ...normalized };
        } else {
          merged.subagents.push(normalized);
        }
      }
    }

    await writeFile(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await rename(tmpPath, filePath);

    return merged;
  }

  /**
   * Read the latest progress.json for a goal.
   *
   * @param {string} goalId - Goal identifier
   * @returns {Promise<object|null>} Progress object or null
   */
  async function readProgress(goalId) {
    const filePath = join(goalDir(goalId), PROGRESS_FILENAME);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write the subagents.json file atomically (flattened subagent results).
   *
   * @param {string} goalId - Goal identifier
   * @param {object[]} subagents - Array of subagent result objects
   * @returns {Promise<object[]>} Written subagents array
   */
  async function writeSubagents(goalId, subagents = []) {
    const dir = goalDir(goalId);
    const filePath = join(dir, SUBAGENTS_FILENAME);
    const tmpPath = join(dir, `${SUBAGENTS_FILENAME}.${randomUUID()}.tmp`);

    await mkdir(dir, { recursive: true });

    const normalized = subagents.map((s) => ({
      role: s.role || "",
      round: s.round || 1,
      phase: s.phase || "",
      status: normalizeStatus(s.status),
      summary: s.summary || "",
      changed_files: Array.isArray(s.changed_files) ? s.changed_files : [],
      artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
      blockers: Array.isArray(s.blockers) ? s.blockers : [],
      started_at: s.started_at || null,
      completed_at: s.completed_at || null,
    }));

    // Merge with existing subagents.json if present (by role+round)
    let existing = [];
    try {
      const raw = await readFile(filePath, "utf8");
      existing = JSON.parse(raw);
    } catch {
      // No existing file, start fresh
    }

    const merged = [...existing];
    for (const incoming of normalized) {
      const idx = merged.findIndex(
        (s) => s.role === incoming.role && (s.round || 1) === (incoming.round || 1)
      );
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...incoming };
      } else {
        merged.push(incoming);
      }
    }

    await writeFile(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await rename(tmpPath, filePath);

    return merged;
  }

  /**
   * Read the latest subagents.json for a goal.
   *
   * @param {string} goalId - Goal identifier
   * @returns {Promise<object[]|null>} Subagents array or null
   */
  async function readSubagents(goalId) {
    const filePath = join(goalDir(goalId), SUBAGENTS_FILENAME);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Append a single subagent result to both progress.json and subagents.json.
   * This is an atomic two-file update.
   *
   * @param {string} goalId - Goal identifier
   * @param {object} subagentResult - Single subagent result
   * @param {object} [progressUpdate] - Optional progress-level updates
   * @returns {Promise<{ progress: object, subagents: object[] }>}
   */
  async function appendSubagentResult(goalId, subagentResult = {}, progressUpdate = {}) {
    const subagents = await writeSubagents(goalId, [subagentResult]);

    const progress = await writeProgress(goalId, {
      subagents: [subagentResult],
      ...progressUpdate,
    });

    return { progress, subagents };
  }

  return {
    writeProgress,
    readProgress,
    writeSubagents,
    readSubagents,
    appendSubagentResult,
  };
}

// -- Convenience helpers -----------------------------------------------------

/**
 * Build a progress object from agent run data.
 *
 * @param {object} options
 * @param {string} options.phase - Current phase name
 * @param {string} options.status - Overall pipeline status
 * @param {string} [options.currentAction] - Current action description
 * @param {string[]} [options.blockers] - Active blockers
 * @param {string} [options.nextExpectedEvent] - Next expected event
 * @param {object[]} [options.subagents] - Array of subagent states
 * @returns {object} Progress object
 */
export function buildProgressPayload({
  phase = "context_curation",
  status = "running",
  currentAction = "",
  blockers = [],
  nextExpectedEvent = "",
  subagents = [],
} = {}) {
  return {
    phase: normalizePhase(phase),
    status: normalizeStatus(status),
    current_action: currentAction,
    blockers: Array.isArray(blockers) ? blockers : [],
    next_expected_event: nextExpectedEvent,
    subagents: Array.isArray(subagents) ? subagents : [],
  };
}
