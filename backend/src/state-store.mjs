import { copyFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
  }

  async load() {
    if (this.state) return this.state;
    await this._migrateIfNeeded();
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch {
      this.state = this.defaultState();
      await this.save();
    }
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.statePath), { recursive: true });
    this._capActivities();
    // Serialize concurrent saves with an internal promise chain.
    // Use temp-file + atomic rename to avoid partial writes on crash.
    // If a single save fails, we reset the chain so future saves are not
    // permanently blocked (chain.catch(() => {}) resolves on failure).
    const chain = (this._saveLock || Promise.resolve()).then(async () => {
      const tmpPath = this.statePath + "." + randomUUID() + ".tmp";
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(tmpPath, this.statePath);
    });
    // Reset on failure so subsequent saves still execute
    this._saveLock = chain.catch(() => {});
    return chain;
  }

  async mutate(updater) {
    const chain = (this._mutationLock || Promise.resolve()).then(async () => {
      const state = await this.load();
      const result = await updater(state);
      await this.save();
      return result;
    });
    this._mutationLock = chain.catch(() => {});
    return chain;
  }

  async findTaskById(id) {
    const state = await this.load();
    return state.tasks.find((task) => task.id === id) || null;
  }

  async findGoalById(id) {
    const state = await this.load();
    return state.goals.find((goal) => goal.id === id) || null;
  }

  async findWorkspaceById(id) {
    const state = await this.load();
    return state.workspaces.find((workspace) => workspace.id === id) || null;
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
      conversations: [],
      memories: [],
      tasks: [],
      chatgpt_requests: [],
      activities: [],
      audit: []
    };
  }
}
