/**
 * execution-store.mjs — Durable store for execution records.
 *
 * Each execution record tracks the full lifecycle of a task execution
 * within a worktree, including:
 *   - workstream_id, goal_id, task_id
 *   - worktree_path, branch, base_commit, head_commit
 *   - session_id, optional codex_thread_id
 *
 * Execution records are stored under:
 *   <workspaceRoot>/.gptwork/executions/<execution_id>.json
 */
/**
 * @deprecated Wave 10R — 旧 execution 路径。
 * 新代码应使用 execution-core/ 模块：
 *   ExecutionRunService → execution-core/execution-run-service.mjs
 *   ExecutionRunStore → execution-core/execution-run-store.mjs
 * 将在下次大版本中移除。
 */


import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const EXECUTIONS_DIR = ".gptwork/executions";

const SAFE_EXECUTION_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeExecutionId(executionId) {
  const id = String(executionId || "");
  if (!SAFE_EXECUTION_ID.test(id)) {
    throw new Error(`unsafe execution id: ${id || "(empty)"}`);
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
    throw new Error("resolved execution path escapes base directory");
  }
  return resolvedPath;
}

export { nowIso as __nowIso };

/**
 * Create an execution store bound to a workspace root.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot - Root path for the workspace (required)
 * @returns {object} Execution store API
 */
export function createExecutionStore({ workspaceRoot } = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const executionsDir = join(workspaceRoot, EXECUTIONS_DIR);

  function recordPath(executionId) {
    const safeId = assertSafeExecutionId(executionId);
    return resolveInside(executionsDir, join(executionsDir, `${safeId}.json`));
  }

  async function ensureDir() {
    await mkdir(executionsDir, { recursive: true });
  }

  async function writeRecord(record) {
    await ensureDir();
    const path = recordPath(record.id);
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
    await rename(tmpPath, path);
  }

  async function readRecord(executionId) {
    const text = await readFile(recordPath(executionId), "utf8");
    return JSON.parse(text);
  }

  return {
    executionsDir,

    /**
     * Create a new execution record.
     *
     * @param {object} params
     * @param {string} [params.executionId] - Optional explicit ID; auto-generated if omitted
     * @param {string} [params.workstreamId] - Workstream identifier
     * @param {string} [params.goalId] - Goal identifier
     * @param {string} [params.taskId] - Task identifier
     * @param {string} [params.worktreePath] - Resolved task worktree path
     * @param {string} [params.branch] - Git branch for the worktree
     * @param {string} [params.baseCommit] - Base commit SHA (resolved during materialization)
     * @param {string} [params.headCommit] - Head commit SHA (resolved after execution)
     * @param {string} [params.sessionId] - TUI session identifier
     * @param {string} [params.codexThreadId] - Optional Codex thread identifier
     * @param {object} [params.metadata] - Optional additional metadata
     * @returns {Promise<object>} Created execution record
     */
    async createExecution({
      executionId = null,
      workstreamId = null,
      goalId = null,
      taskId = null,
      worktreePath = null,
      branch = null,
      baseCommit = null,
      headCommit = null,
      sessionId = null,
      codexThreadId = null,
      metadata = {},
    } = {}) {
      const id = assertSafeExecutionId(executionId || `exec_${randomUUID()}`);
      const createdAt = nowIso();
      const record = {
        id,
        schema_version: 1,
        workstream_id: workstreamId,
        goal_id: goalId,
        task_id: taskId,
        worktree_path: worktreePath,
        branch,
        base_commit: baseCommit,
        head_commit: headCommit,
        session_id: sessionId,
        codex_thread_id: codexThreadId,
        provider: null,
        interaction_mode: null,
        provider_run_id: null,
        request: null,
        runtime_details: null,
        evidence_ref: null,
        transition_history: [],
        status: "created",
        created_at: createdAt,
        updated_at: createdAt,
        metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
      };
      await writeRecord(record);
      return record;
    },

    /**
     * Read an execution record by ID.
     *
     * @param {string} executionId - Execution record ID
     * @param {object} [options]
     * @param {number} [options.maxChars] - Truncate log to last N chars
     * @returns {Promise<object>} Execution record with optional log
     */
    async readExecution(executionId, { maxChars } = {}) {
      const record = await readRecord(executionId);
      let log = "";
      try {
        const logFilePath = recordPath(executionId).replace(/\.json$/, ".log");
        log = await readFile(logFilePath, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      if (Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 && log.length > Number(maxChars)) {
        log = log.slice(-Number(maxChars));
      }
      return { ...record, log };
    },

    /**
     * Update an execution record with a partial patch.
     *
     * @param {string} executionId - Execution record ID
     * @param {object} patch - Fields to merge into the record
     * @returns {Promise<object>} Updated execution record
     */
    async updateExecution(executionId, patch = {}) {
      const record = await readRecord(executionId);
      const { id, created_at, ...allowed } = patch;
      const next = {
        ...record,
        ...allowed,
        id: record.id,
        created_at: record.created_at,
        updated_at: nowIso(),
      };
      // Ensure required fields
      next.status = next.status || record.status;
      await writeRecord(next);
      return next;
    },

    /**
     * List all execution records, newest first.
     *
     * @returns {Promise<Array<object>>} Sorted execution records
     */
    async listExecutions() {
      await ensureDir();
      const entries = await readdir(executionsDir, { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        if (!SAFE_EXECUTION_ID.test(id)) continue;
        try {
          const record = await readRecord(id);
          records.push(record);
        } catch {
          // Ignore malformed files
        }
      }
      records.sort(
        (a, b) =>
          String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
          String(a.id).localeCompare(String(b.id))
      );
      return records;
    },

    /**
     * Find execution records matching a query.
     *
     * @param {object} query - Fields to match (e.g., { task_id: "task_1", goal_id: "goal_1" })
     * @returns {Promise<Array<object>>} Matching execution records
     */
    async findExecutions(query = {}) {
      const all = await this.listExecutions();
      if (!query || Object.keys(query).length === 0) return all;
      return all.filter((record) => {
        for (const [key, value] of Object.entries(query)) {
          if (record[key] !== value) return false;
        }
        return true;
      });
    },

    /**
     * Append a log line to an execution record's log file.
     *
     * @param {string} executionId - Execution record ID
     * @param {string} text - Text to append
     * @returns {Promise<object>} File stat
     */
    async appendExecutionLog(executionId, text) {
      await ensureDir();
      const logFilePath = recordPath(executionId).replace(/\.json$/, ".log");
      await mkdir(dirname(logFilePath), { recursive: true });
      const chunk = String(text ?? "");
      await appendFile(logFilePath, chunk.endsWith("\n") ? chunk : `${chunk}\n`, "utf8");
      return stat(logFilePath);
    },
  };
}
