import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class StateStore {
  constructor({ statePath, defaultWorkspaceRoot, oldDefaultStatePath }) {
    this.statePath = statePath;
    this.defaultWorkspaceRoot = defaultWorkspaceRoot;
    this.oldDefaultStatePath = oldDefaultStatePath || null;
    this.state = null;
    this._migrationSource = null;
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
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
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
