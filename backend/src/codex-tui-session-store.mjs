/**
 * codex-tui-session-store.mjs — Persistent session store for Codex TUI sessions.
 *
 * Session records persist to <workspaceRoot>/.gptwork/codex-tui-sessions/<id>.json
 * and include task/goal identifiers, execution path, repo lock, and optional
 * worktree metadata for worktree-based execution tracking.
 *
 * Also provides atomic write/read for subagent progress files:
 *   .gptwork/goals/<goal_id>/progress.json
 *   .gptwork/goals/<goal_id>/subagents.json
 *
 * Fields (session):
 *   id, task_id, goal_id, cwd, repo_lock_id,
 *   workstream_id, worktree_path, branch, base_commit, head_commit,
 *   codex_thread_id, status, metadata, log
 *
 * Fields (progress):
 *   phase, status, current_action, blockers, next_expected_event,
 *   last_progress_at, subagents: [{ role, status, summary, changed_files, artifacts }]
 *
 * Fields (subagents):
 *   [{ role, round, phase, status, summary, changed_files, artifacts, blockers }]
 */

import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const CODEX_TUI_SESSIONS_DIR = ".gptwork/codex-tui-sessions";
export const CODEX_TUI_PROGRESS_FILENAME = "progress.json";
export const CODEX_TUI_SUBAGENTS_FILENAME = "subagents.json";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_GOAL_ID = /^[A-Za-z0-9_-]+$/;

export function assertSafeCodexTuiSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`unsafe session id: ${id || "(empty)"}`);
  }
  return id;
}

function assertSafeGoalId(goalId) {
  const id = String(goalId || "");
  if (!SAFE_GOAL_ID.test(id)) {
    throw new Error(`unsafe goal id: ${id || "(empty)"}`);
  }
  return id;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveInside(baseDir, path) {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + "/")) {
    throw new Error("resolved session path escapes session directory");
  }
  return resolvedPath;
}

function tailText(text, maxChars) {
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  return text.length > limit ? text.slice(-limit) : text;
}

export function createCodexTuiSessionStore({ workspaceRoot }) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const sessionsDir = join(workspaceRoot, CODEX_TUI_SESSIONS_DIR);

  function recordPath(sessionId) {
    const safeId = assertSafeCodexTuiSessionId(sessionId);
    return resolveInside(sessionsDir, join(sessionsDir, `${safeId}.json`));
  }

  function logPath(sessionId) {
    const safeId = assertSafeCodexTuiSessionId(sessionId);
    return resolveInside(sessionsDir, join(sessionsDir, `${safeId}.log`));
  }

  function goalProgressDir(goalId) {
    const safeId = assertSafeGoalId(goalId);
    return join(workspaceRoot, ".gptwork", "goals", safeId);
  }

  async function ensureDir() {
    await mkdir(sessionsDir, { recursive: true });
  }

  async function writeRecord(record) {
    await ensureDir();
    const path = recordPath(record.id);
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
    await rename(tmpPath, path);
  }

  async function readRecord(sessionId) {
    const text = await readFile(recordPath(sessionId), "utf8");
    return JSON.parse(text);
  }

  return {
    sessionsDir,

    // -- Session CRUD -------------------------------------------------------

    /**
     * Create a new session record with optional worktree fields.
     *
     * @param {object} params
     * @param {string} params.sessionId - Session identifier
     * @param {string} [params.taskId] - Task identifier
     * @param {string} [params.goalId] - Goal identifier
     * @param {string} [params.cwd] - Working directory (task worktree path)
     * @param {string} [params.repoLockId] - Repo lock identifier
     * @param {string} [params.workstreamId] - Workstream identifier
     * @param {string} [params.worktreePath] - Git worktree path
     * @param {string} [params.branch] - Git branch name
     * @param {string} [params.baseCommit] - Base commit SHA
     * @param {string} [params.headCommit] - Head commit SHA
     * @param {string} [params.codexThreadId] - Codex thread ID
     * @param {object} [params.metadata] - Additional metadata
     * @returns {Promise<object>} Created session record
     */
    async createSession({ sessionId, taskId = null, goalId = null, cwd = null, repoLockId = null, workstreamId = null, worktreePath = null, branch = null, baseCommit = null, headCommit = null, codexThreadId = null, metadata = {} } = {}) {
      const id = assertSafeCodexTuiSessionId(sessionId || `codex_tui_${randomUUID()}`);
      const createdAt = nowIso();
      const record = {
        id,
        runtime_version: 2,
        last_process_heartbeat_at: null,
        last_output_at: null,
        last_meaningful_progress_at: null,
        task_id: taskId,
        goal_id: goalId,
        cwd,
        repo_lock_id: repoLockId,
        workstream_id: workstreamId,
        worktree_path: worktreePath,
        branch,
        base_commit: baseCommit,
        head_commit: headCommit,
        codex_thread_id: codexThreadId,
        status: "created",
        created_at: createdAt,
        updated_at: createdAt,
        metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
      };
      await writeRecord(record);
      return record;
    },

    async readSession(sessionId, { maxChars } = {}) {
      const record = await readRecord(sessionId);
      let log = "";
      try {
        log = await readFile(logPath(sessionId), "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      return { ...record, log: tailText(log, maxChars) };
    },

    async updateSession(sessionId, patch = {}) {
      const record = await readRecord(sessionId);
      const next = {
        ...record,
        ...patch,
        id: record.id,
        created_at: record.created_at,
        updated_at: nowIso(),
      };
      await writeRecord(next);
      return next;
    },

    async listSessions() {
      await ensureDir();
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        if (!SAFE_SESSION_ID.test(id)) continue;
        try {
          const record = await readRecord(id);
          records.push(record);
        } catch {
          // Ignore malformed session files in this internal inventory.
        }
      }
      records.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(a.id).localeCompare(String(b.id)));
      return records;
    },

    async appendSessionLog(sessionId, text) {
      await ensureDir();
      await mkdir(dirname(logPath(sessionId)), { recursive: true });
      const chunk = String(text ?? "");
      await appendFile(logPath(sessionId), chunk.endsWith("\n") ? chunk : `${chunk}\n`, "utf8");
      return stat(logPath(sessionId));
    },

    // -- Subagent progress file atomic writes -------------------------------

    /**
     * Write progress.json atomically for a goal.
     * Merges with existing progress file if present.
     *
     * @param {string} goalId - Goal identifier
     * @param {object} progress - Progress state { phase, status, current_action, blockers, next_expected_event, subagents }
     * @returns {Promise<object>} Written progress object
     */
    async writeGoalProgress(goalId, progress = {}) {
      const dir = goalProgressDir(goalId);
      const filePath = join(dir, CODEX_TUI_PROGRESS_FILENAME);
      const tmpPath = join(dir, `${CODEX_TUI_PROGRESS_FILENAME}.${randomUUID()}.tmp`);

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
        phase: progress.phase || existing.phase || "unknown",
        status: progress.status || existing.status || "running",
        current_action: progress.current_action != null ? progress.current_action : (existing.current_action || ""),
        blockers: Array.isArray(progress.blockers != null ? progress.blockers : existing.blockers)
          ? (progress.blockers ?? existing.blockers) : [],
        next_expected_event: progress.next_expected_event != null ? progress.next_expected_event : (existing.next_expected_event || ""),
        subagents: Array.isArray(progress.subagents != null ? progress.subagents : existing.subagents)
          ? (progress.subagents ?? existing.subagents) : [],
      };

      // Merge subagents individually by role+round
      if (Array.isArray(progress.subagents)) {
        for (const incoming of progress.subagents) {
          const idx = merged.subagents.findIndex(
            (s) => s.role === incoming.role && (s.round || 1) === (incoming.round || 1)
          );
          const normalized = {
            role: incoming.role || "",
            round: incoming.round || 1,
            phase: incoming.phase || merged.phase,
            status: incoming.status || "pending",
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
    },

    /**
     * Read progress.json for a goal.
     *
     * @param {string} goalId - Goal identifier
     * @returns {Promise<object|null>} Progress object or null
     */
    async readGoalProgress(goalId) {
      const filePath = join(goalProgressDir(goalId), CODEX_TUI_PROGRESS_FILENAME);
      try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    /**
     * Write subagents.json atomically for a goal.
     * Merges with existing subagents file if present.
     *
     * @param {string} goalId - Goal identifier
     * @param {object[]} subagents - Array of subagent result objects
     * @returns {Promise<object[]>} Written subagents array
     */
    async writeGoalSubagents(goalId, subagents = []) {
      const dir = goalProgressDir(goalId);
      const filePath = join(dir, CODEX_TUI_SUBAGENTS_FILENAME);
      const tmpPath = join(dir, `${CODEX_TUI_SUBAGENTS_FILENAME}.${randomUUID()}.tmp`);

      await mkdir(dir, { recursive: true });

      const normalized = subagents.map((s) => ({
        role: s.role || "",
        round: s.round || 1,
        phase: s.phase || "",
        status: s.status || "pending",
        summary: s.summary || "",
        changed_files: Array.isArray(s.changed_files) ? s.changed_files : [],
        artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
        blockers: Array.isArray(s.blockers) ? s.blockers : [],
        started_at: s.started_at || null,
        completed_at: s.completed_at || null,
      }));

      // Merge with existing
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
    },

    /**
     * Read subagents.json for a goal.
     *
     * @param {string} goalId - Goal identifier
     * @returns {Promise<object[]|null>} Subagents array or null
     */
    async readGoalSubagents(goalId) {
      const filePath = join(goalProgressDir(goalId), CODEX_TUI_SUBAGENTS_FILENAME);
      try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
}
