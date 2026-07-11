/**
 * codex-tui-session-store.mjs — Persistent session store for Codex TUI sessions.
 *
 * Session records persist to <workspaceRoot>/.gptwork/codex-tui-sessions/<id>.json
 * and include task/goal identifiers, execution path, repo lock, and optional
 * worktree metadata for worktree-based execution tracking.
 *
 * Fields:
 *   id, task_id, goal_id, cwd, repo_lock_id,
 *   workstream_id, worktree_path, branch, base_commit, head_commit,
 *   codex_thread_id, status, metadata, log
 */

import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const CODEX_TUI_SESSIONS_DIR = ".gptwork/codex-tui-sessions";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function assertSafeCodexTuiSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`unsafe session id: ${id || "(empty)"}`);
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
  };
}
