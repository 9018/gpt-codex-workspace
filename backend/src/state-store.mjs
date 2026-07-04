import { copyFile, mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_EXECUTION_STATUSES,
  HUMAN_REVIEW_STATUSES,
  REPAIR_STATUSES,
  TASK_STATUSES,
} from "./task-status-taxonomy.mjs";

const CODEX_QUEUE_ACTIVE_STATUSES = Object.freeze([
  ...Object.values(TASK_STATUSES).filter((status) =>
    ACTIVE_EXECUTION_STATUSES.has(status) ||
    HUMAN_REVIEW_STATUSES.has(status) ||
    REPAIR_STATUSES.has(status)
  ),
]);

const CODEX_QUEUE_TERMINAL_STATUSES = Object.freeze([
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
]);

// ---------------------------------------------------------------------------
// StateStore with in-memory indexes for O(1) lookups
// ---------------------------------------------------------------------------

export class StateStore {
  constructor({ statePath, defaultWorkspaceRoot, oldDefaultStatePath, maxActivities = 10000 }) {
    this.statePath = statePath;
    this.defaultWorkspaceRoot = defaultWorkspaceRoot;
    this.oldDefaultStatePath = oldDefaultStatePath || null;
    this.maxActivities = Math.max(1, Number(maxActivities) || 10000);
    this.state = null;
    this._migrationSource = null;
    this._saveLock = null;
    this._mutationLock = null;
    this._stateVersion = 0;
    this._derivedCache = new Map();
    this._stateMtime = 0;
    this._stateSize = null;
    this._clearIndexes();
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  /** Clear all in-memory indexes. */
  _clearIndexes() {
    this._indexesReady = false;
    this._idxTasksById = null;
    this._idxGoalsById = null;
    this._idxGoalsByTaskId = null;
    this._idxConversationsById = null;
    this._idxMemoriesByGoalId = null;
    this._idxCodexActiveTasksByStatus = null;
    this._idxCodexTerminalTasksByStatus = null;
  }

  /** Rebuild in-memory indexes from current state. */
  _buildIndexes() {
    this._clearIndexes();
    if (!this.state) return;

    this._idxTasksById = new Map();
    this._idxGoalsById = new Map();
    this._idxGoalsByTaskId = new Map();
    this._idxConversationsById = new Map();
    this._idxMemoriesByGoalId = new Map();

    // Split codex task indexes: active (pending work) vs terminal (done/failed)
    const codexActiveStatuses = new Set(CODEX_QUEUE_ACTIVE_STATUSES);
    const codexTerminalStatuses = new Set(CODEX_QUEUE_TERMINAL_STATUSES);

    this._idxCodexActiveTasksByStatus = new Map();
    this._idxCodexTerminalTasksByStatus = new Map();
    for (const st of codexActiveStatuses) this._idxCodexActiveTasksByStatus.set(st, []);
    for (const st of codexTerminalStatuses) this._idxCodexTerminalTasksByStatus.set(st, []);

    for (const task of this.state.tasks || []) {
      this._idxTasksById.set(task.id, task);
      if (task.assignee === "codex") {
        if (codexActiveStatuses.has(task.status)) {
          this._idxCodexActiveTasksByStatus.get(task.status).push(task);
        } else if (codexTerminalStatuses.has(task.status)) {
          this._idxCodexTerminalTasksByStatus.get(task.status).push(task);
        }
      }
    }

    for (const goal of this.state.goals || []) {
      this._idxGoalsById.set(goal.id, goal);
      if (goal.task_id) this._idxGoalsByTaskId.set(goal.task_id, goal);
    }

    for (const conv of this.state.conversations || []) {
      this._idxConversationsById.set(conv.id, conv);
    }

    for (const mem of this.state.memories || []) {
      if (!this._idxMemoriesByGoalId.has(mem.goal_id)) this._idxMemoriesByGoalId.set(mem.goal_id, []);
      this._idxMemoriesByGoalId.get(mem.goal_id).push(mem);
    }
    this._indexesReady = true;
  }

  /** Refresh in-memory state from disk when the state file's mtime changed. */
  async _tryReloadOnExternalChange() {
    try {
      const st = await stat(this.statePath);
      const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
      const size = Number.isFinite(st.size) ? st.size : null;
      // File mtimes are not guaranteed to be strictly monotonic across
      // external writers, atomic renames, or coarse filesystems.  Treat any
      // fingerprint difference as a potential external state mutation.
      if (mtimeMs !== this._stateMtime || size !== this._stateSize) {
        const raw = await readFile(this.statePath, "utf8");
        this.state = JSON.parse(raw);
        this._stateMtime = mtimeMs;
        this._stateSize = size;
        this._buildIndexes();
        this._stateVersion += 1;
        this.clearDerivedCache();
      }
    } catch {
      // stat or readFile failed; keep in-memory state unchanged
    }
  }

  async load() {
    if (!this.state) {
      await this._migrateIfNeeded();
      try {
        this.state = JSON.parse(await readFile(this.statePath, "utf8"));
        // Record mtime after initial load
        try {
          const st = await stat(this.statePath);
          if (Number.isFinite(st.mtimeMs)) this._stateMtime = st.mtimeMs;
          if (Number.isFinite(st.size)) this._stateSize = st.size;
        } catch {
          // stat non-fatal
        }
      } catch {
        this.state = this.defaultState();
        await this.save();
        return this.state;
      }
    } else {
      // Subsequent loads: check if the file was modified externally and
      // reload if needed.  This ensures runtime diagnostics such as
      // runtime_status see the latest state without requiring a restart.
      await this._tryReloadOnExternalChange();
    }
    if (!this._indexesReady) this._buildIndexes();
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Indexed lookup helpers (O(1) vs. O(n) for array.find)
  //
  // These methods use in-memory indexes when available and fall back to
  // array scanning if indexes haven't been built.  All are async for
  // backward compatibility with existing callers.
  // -----------------------------------------------------------------------

  async findTaskById(id) {
    if (this._idxTasksById) return this._idxTasksById.get(id) ?? null;
    const state = await this.load();
    return state.tasks.find((task) => task.id === id) || null;
  }

  async findGoalById(id) {
    if (this._idxGoalsById) return this._idxGoalsById.get(id) ?? null;
    const state = await this.load();
    return state.goals.find((goal) => goal.id === id) || null;
  }

  findGoalByTaskId(taskId) {
    return this._idxGoalsByTaskId?.get(taskId) ?? null;
  }

  findConversationById(id) {
    return this._idxConversationsById?.get(id) ?? null;
  }

  getMemoriesByGoalId(goalId) {
    return this._idxMemoriesByGoalId?.get(goalId) ?? [];
  }

  getCodexTasksByStatus(status) {
    if (this._idxCodexActiveTasksByStatus?.has(status)) {
      return this._idxCodexActiveTasksByStatus.get(status);
    }
    if (this._idxCodexTerminalTasksByStatus?.has(status)) {
      return this._idxCodexTerminalTasksByStatus.get(status);
    }
    return [];
  }

  /**
   * Get codex-assigned tasks grouped by status with counts.
   * Returns { tasks: [], counts: { assigned: N, ... } }.
   * Only active (non-terminal) tasks are included in the tasks array.
   * Counts include terminal statuses for monitoring compatibility.
   */
  getCodexTaskQueue() {
    const counts = {};
    const allTasks = [];
    // Active statuses only for the task list (terminal tasks don't need processing)
    for (const st of CODEX_QUEUE_ACTIVE_STATUSES) {
      const tasks = this.getCodexTasksByStatus(st);
      counts[st] = tasks.length;
      if (tasks.length) allTasks.push(...tasks);
    }
    // Include terminal counts for queue monitoring (compatible with worker-queue-counts)
    for (const st of CODEX_QUEUE_TERMINAL_STATUSES) {
      counts[st] = this.getCodexTasksByStatus(st).length;
    }
    return { tasks: allTasks, counts };
  }

  getStateVersion() {
    return this._stateVersion || 0;
  }

  clearDerivedCache() {
    this._derivedCache.clear();
  }

  getDerivedCache(key) {
    const entry = this._derivedCache.get(key);
    if (!entry || entry.version !== this.getStateVersion()) return undefined;
    return entry.value;
  }

  setDerivedCache(key, value) {
    this._derivedCache.set(key, { version: this.getStateVersion(), value });
    return value;
  }

  getOrBuildDerived(key, builder) {
    const cached = this.getDerivedCache(key);
    if (cached !== undefined) return cached;
    return this.setDerivedCache(key, builder());
  }

  /**
   * Index-based query for worker candidate tasks.
   * Returns tasks matching any of the given statuses without scanning state.tasks.
   * Uses round-robin status buckets, oldest first within each bucket, so a large
   * assigned backlog cannot starve queued or waiting_for_lock tasks forever.
   *
   * @param {string[]} statuses - Statuses to match (e.g. ["assigned", "queued"])
   * @param {number} [maxTasks] - Optional max results limit
   * @returns {object[]} Task objects
   */
  getCodexActiveQueueCandidates(statuses, maxTasks) {
    if (!this._idxCodexActiveTasksByStatus) return [];
    const limit = maxTasks ? Math.max(1, Number(maxTasks) || 1) : null;
    const result = [];
    const seen = new Set();
    const taskTime = (task) => {
      const ts = Date.parse(task.created_at || task.updated_at || "");
      return Number.isFinite(ts) ? ts : 0;
    };
    const byOldest = (a, b) => taskTime(a) - taskTime(b) || String(a.id || "").localeCompare(String(b.id || ""));
    const buckets = (statuses || [])
      .map((st) => ({ status: st, tasks: [...(this._idxCodexActiveTasksByStatus.get(st) || [])].sort(byOldest) }))
      .filter((bucket) => bucket.tasks.length > 0);

    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets) {
        const task = bucket.tasks.shift();
        if (!task || seen.has(task.id)) continue;
        seen.add(task.id);
        result.push(task);
        added = true;
        if (limit && result.length >= limit) return result;
      }
    }
    return result;
  }

  async findWorkspaceById(id) {
    const state = await this.load();
    return state.workspaces.find((workspace) => workspace.id === id) || null;
  }

  async save() {
    await mkdir(dirname(this.statePath), { recursive: true });
    this._capActivities();
    // Serialize concurrent saves with an internal promise chain.
    // Use temp-file + atomic rename to avoid partial writes on crash.
    // Rebuild indexes after write so they stay consistent with state.
    // If a single save fails, we reset the chain so future saves are not
    // permanently blocked (chain.catch(() => {}) resolves on failure).
    const chain = (this._saveLock || Promise.resolve()).then(async () => {
      const tmpPath = this.statePath + "." + randomUUID() + ".tmp";
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(tmpPath, this.statePath);
      // Rebuild indexes so they stay consistent with the written state
      this._buildIndexes();
      this._stateVersion += 1;
      this.clearDerivedCache();
      // Record mtime after successful save so that subsequent
      // _tryReloadOnExternalChange calls do not spuriously reload.
      try {
        const st = await stat(this.statePath);
        if (Number.isFinite(st.mtimeMs)) this._stateMtime = st.mtimeMs;
        if (Number.isFinite(st.size)) this._stateSize = st.size;
      } catch {}
    });
    // Reset on failure so subsequent saves still execute
    this._saveLock = chain.catch(() => {});
    return chain;
  }

  async mutate(updater) {
    const chain = (this._mutationLock || Promise.resolve()).then(async () => {
      const state = await this.load();
      const result = await updater(state);
      // Indexes will be rebuilt inside save()
      await this.save();
      return result;
    });
    this._mutationLock = chain.catch(() => {});
    return chain;
  }

  _capActivities() {
    if (!this.state || !Array.isArray(this.state.activities)) return;
    const excess = this.state.activities.length - this.maxActivities;
    if (excess > 0) this.state.activities.splice(0, excess);
  }

  async _migrateIfNeeded() {
    if (!this.oldDefaultStatePath) return;
    try {
      await readFile(this.statePath, "utf8");
      return;
    } catch {}
    try {
      await readFile(this.oldDefaultStatePath, "utf8");
      await mkdir(dirname(this.statePath), { recursive: true });
      await copyFile(this.oldDefaultStatePath, this.statePath);
      this._migrationSource = resolve(this.oldDefaultStatePath);
    } catch {}
  }

  get migrationSource() {
    return this._migrationSource;
  }

  defaultState() {
    const now = new Date().toISOString();
    return {
      users: [{ id: "user_default", name: "Default User" }],
      teams: [{ id: "team_default", name: "Default Team" }],
      projects: [{
        id: "default",
        team_id: "team_default",
        name: "Default Project",
        description: "Default GPTWork project",
        default_workspace_id: "hosted-default",
        created_at: now,
        updated_at: now
      }],
      workspaces: [{
        id: "hosted-default",
        project_id: "default",
        name: "Hosted Default",
        type: "hosted",
        root: this.defaultWorkspaceRoot,
        default: true,
        created_at: now,
        updated_at: now
      }],
      goals: [],
      agent_runs: [],
      goal_queue: [],
      conversations: [],
      memories: [],
      tasks: [],
      chatgpt_requests: [],
      activities: [],
      audit: []
    };
  }
}
