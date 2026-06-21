import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseGitHubUrl, deriveTmpPath, deriveWorktreePath, detectStaleTempClones } from "./repo-registry-paths.mjs";
import { _detectGitBranch } from "./repo-registry-git.mjs";

export class RepoRegistry {
  constructor({ registryPath, workspaceRoot }) {
    this.registryPath = registryPath;
    this.workspaceRoot = workspaceRoot;
    this._repos = null; // Map<repo_id, RepoRecord>
    this._loaded = false;
  }

  async load() {
    if (this._loaded && this._repos) return this._repos;
    try {
      const data = JSON.parse(await readFile(this.registryPath, "utf8"));
      const repos = data.repositories || [];
      this._repos = new Map(repos.map((r) => [r.repo_id, r]));
    } catch {
      this._repos = new Map();
    }
    this._loaded = true;
    return this._repos;
  }

  async save() {
    if (!this._repos) await this.load();
    await mkdir(dirname(this.registryPath), { recursive: true });
    const data = {
      version: 1,
      workspace_root: this.workspaceRoot,
      updated_at: new Date().toISOString(),
      repositories: Array.from(this._repos.values()),
    };
    await writeFile(this.registryPath, JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Register or update a repository.
   * @param {object} info - { remote_url, canonical_path?, default_branch?, roles?, tags?, status? }
   * @returns {Promise<object>} The registered RepoRecord
   */
  async register(info) {
    const parsed = parseGitHubUrl(info.remote_url);
    if (!parsed) {
      throw new Error(`Cannot parse remote URL: ${info.remote_url}`);
    }
    await this.load();
    const now = new Date().toISOString();
    const existing = this._repos.get(parsed.repo_id);

    let defaultBranch = info.default_branch || existing?.default_branch || "main";
    const canonicalPath = info.canonical_path || existing?.canonical_path || null;

    if (canonicalPath && !info.default_branch && !existing?.default_branch) {
      const detected = _detectGitBranch(canonicalPath);
      if (detected) defaultBranch = detected;
    }

    const record = {
      repo_id: parsed.repo_id,
      provider: parsed.provider,
      host: parsed.host,
      owner: parsed.owner,
      repo_name: parsed.repo,
      remote_url: info.remote_url,
      default_branch: defaultBranch,
      canonical_path: canonicalPath,
      roles: info.roles || existing?.roles || [],
      tags: info.tags || existing?.tags || [],
      status: info.status || existing?.status || "active",
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    this._repos.set(parsed.repo_id, record);
    await this.save();
    return record;
  }

  async unregister(repo_id) {
    await this.load();
    const existed = this._repos.has(repo_id);
    this._repos.delete(repo_id);
    if (existed) await this.save();
    return existed;
  }

  get(repo_id) {
    if (!this._repos) return null;
    return this._repos.get(repo_id) || null;
  }

  findByUrl(remoteUrl) {
    if (!this._repos) return null;
    const parsed = parseGitHubUrl(remoteUrl);
    if (!parsed) return null;
    return this._repos.get(parsed.repo_id) || null;
  }

  findByPath(localPath) {
    if (!this._repos || !localPath) return null;
    const resolved = resolve(localPath);
    for (const record of this._repos.values()) {
      if (record.canonical_path && resolve(record.canonical_path) === resolved) {
        return record;
      }
    }
    return null;
  }

  findByName(owner, repoName) {
    if (!this._repos) return null;
    for (const record of this._repos.values()) {
      if (record.owner === owner && record.repo_name === repoName) {
        return record;
      }
    }
    return null;
  }

  list() {
    if (!this._repos) return [];
    return Array.from(this._repos.values());
  }

  count() {
    if (!this._repos) return 0;
    return this._repos.size;
  }

  /**
   * If exactly one repo is registered, return it. Otherwise null.
   */
  getDefaultRepo() {
    if (this.count() === 1) return this.list()[0];
    return null;
  }

  /**
   * Resolve free text to a repo_id.
   * Accepts repo_id, owner/repo, URL, or unique repo name.
   * Returns repo_id or null if ambiguous/not found.
   */
  resolveRepoId(text) {
    if (!text || !this._repos) return null;
    if (this._repos.has(text)) return text;

    const parsed = parseGitHubUrl(text);
    if (parsed && this._repos.has(parsed.repo_id)) return parsed.repo_id;

    const ownerRepoMatch = text.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
    if (ownerRepoMatch) {
      const [, owner, repoName] = ownerRepoMatch;
      for (const record of this._repos.values()) {
        if (record.owner === owner && record.repo_name === repoName) {
          return record.repo_id;
        }
      }
    }

    // Match by repo name alone (only if unique)
    const repoName = text.split("/").pop();
    if (repoName) {
      const matches = [];
      for (const record of this._repos.values()) {
        if (record.repo_name === repoName) matches.push(record.repo_id);
      }
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  generateWorktreePath(repo_id, taskId) {
    return deriveWorktreePath(this.workspaceRoot, repo_id, taskId);
  }

  generateTmpPath(taskId) {
    return deriveTmpPath(this.workspaceRoot, taskId);
  }

  async detectStaleTempClones() {
    return detectStaleTempClones(this.workspaceRoot);
  }

  getAllCanonicalPaths() {
    if (!this._repos) return [];
    return this.list().filter((r) => r.canonical_path).map((r) => r.canonical_path);
  }
}

// ---------------------------------------------------------------------------
// Git Helpers (internal, exported for testing)
// ---------------------------------------------------------------------------
