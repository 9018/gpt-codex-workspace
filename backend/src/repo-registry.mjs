// repo-registry.mjs
// Canonical multi-repo workspace management for GPTWork
//
// Features:
// - Parse GitHub SSH and HTTPS URLs
// - Repo id generation with owner/repo disambiguation
// - Canonical path generation (deterministic paths)
// - Worktree and tmp path generation
// - Registry load/save/update via .gptwork/repos.json
// - Stale temporary clone detection
// - Git status checks (ahead/behind, local vs remote)
// - Multi-repo ambiguity resolution

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub URL (SSH or HTTPS) into its components.
 *
 * Supported formats:
 *   SSH:   git@github.com:owner/repo.git
 *          git@github.com:owner/repo
 *   HTTPS: https://github.com/owner/repo.git
 *          https://github.com/owner/repo
 *          https://github.com/owner/repo#branch
 *   Owner/repo shorthand: owner/repo
 *
 * Returns { provider, host, owner, repo, repo_id } or null.
 */
export function parseGitHubUrl(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  let owner = null;
  let repo = null;
  let host = "github.com";
  const provider = "github";

  // SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(
    /^git@([\w.-]+):([^/\s]+?)\/([^/\s]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    host = sshMatch[1];
    owner = sshMatch[2];
    repo = sshMatch[3].replace(/\.git$/, "");
    return { provider, host, owner, repo, repo_id: `${host}/${owner}/${repo}` };
  }

  // HTTPS: https://github.com/owner/repo.git (or without .git, or with #fragment)
  const httpsMatch = trimmed.match(
    /^https?:\/\/([\w.-]+)\/([^/\s]+?)\/([^/\s?#]+?)(?:\.git)?(?:#[\w.-]+)?$/
  );
  if (httpsMatch) {
    host = httpsMatch[1];
    owner = httpsMatch[2];
    repo = httpsMatch[3].replace(/\.git$/, "");
    return { provider, host, owner, repo, repo_id: `${host}/${owner}/${repo}` };
  }

  // Owner/repo shorthand
  const shortMatch = trimmed.match(
    /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/
  );
  if (shortMatch) {
    owner = shortMatch[1];
    repo = shortMatch[2];
    return { provider, host, owner, repo, repo_id: `${host}/${owner}/${repo}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path Generation
// ---------------------------------------------------------------------------

/**
 * Derive the canonical relpath for a repo_id:
 *   repos/<host>/<owner>/<repo>
 */
export function deriveCanonicalRelPath(repo_id) {
  return `repos/${repo_id}`;
}

/**
 * Derive the absolute canonical path for a repo.
 */
export function deriveCanonicalPath(workspaceRoot, repo_id) {
  return join(workspaceRoot, deriveCanonicalRelPath(repo_id));
}

/**
 * Derive the worktree relpath:
 *   worktrees/<host>/<owner>/<repo>/<taskId>
 */
export function deriveWorktreeRelPath(repo_id, taskId) {
  return `worktrees/${repo_id}/${taskId}`;
}

/**
 * Derive the absolute worktree path for a task.
 */
export function deriveWorktreePath(workspaceRoot, repo_id, taskId) {
  return join(workspaceRoot, deriveWorktreeRelPath(repo_id, taskId));
}

/**
 * Derive the tmp relpath:
 *   tmp/codex/<taskId>
 */
export function deriveTmpRelPath(taskId) {
  return `tmp/codex/${taskId}`;
}

/**
 * Derive the absolute tmp path for a task.
 */
export function deriveTmpPath(workspaceRoot, taskId) {
  return join(workspaceRoot, deriveTmpRelPath(taskId));
}

// ---------------------------------------------------------------------------
// Temp Clone Detection
// ---------------------------------------------------------------------------

/**
 * Check if a path is a temporary clone (starts with .tmp).
 */
export function isTempClone(path) {
  if (!path) return false;
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  return base.startsWith(".tmp");
}

/**
 * Check if a path matches the canonical repo layout:
 *   <workspaceRoot>/repos/<host>/<owner>/<repo>
 */
export function isCanonicalPath(path, workspaceRoot) {
  if (!path || !workspaceRoot) return false;
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(workspaceRoot);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel.startsWith(`repos/`) || rel.startsWith(`repos\\`);
}

/**
 * Scan the workspace root for stale temporary clones.
 * Returns array of { path, name, type, is_repo }.
 */
export async function detectStaleTempClones(workspaceRoot) {
  const results = [];
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".tmp")) continue;
      const fullPath = join(workspaceRoot, entry.name);
      let isRepo = false;
      // .tmp-xxx/repo/.git  (gh-check pattern)
      try {
        await stat(join(fullPath, "repo", ".git"));
        isRepo = true;
      } catch {
        // .tmp-xxx/.git (generic temp clone)
        try {
          await stat(join(fullPath, ".git"));
          isRepo = true;
        } catch {
          // not a repo
        }
      }
      results.push({
        path: fullPath,
        name: entry.name,
        type: "temp-clone",
        is_repo: isRepo,
      });
    }
  } catch {
    // workspace root may not exist yet
  }
  return results;
}

// ---------------------------------------------------------------------------
// Repo Registry
// ---------------------------------------------------------------------------

/**
 * RepoRegistry manages the .gptwork/repos.json file.
 *
 * RepoRecord:
 * { repo_id, provider, host, owner, repo_name, remote_url,
 *   default_branch, canonical_path, roles, tags, status,
 *   created_at, updated_at }
 */
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

export function _gitExec(repoDir, args) {
  try {
    const cmd = `git ${args}`;
    return execSync(cmd, {
      cwd: repoDir || process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

export function _detectGitBranch(repoDir) {
  if (!repoDir || !existsSync(join(repoDir, ".git"))) return null;

  const head = _gitExec(repoDir, "symbolic-ref refs/remotes/origin/HEAD 2>/dev/null");
  if (head) {
    const m = head.match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  }

  const branches = _gitExec(repoDir, "branch -r");
  if (branches) {
    if (branches.includes("origin/main")) return "main";
    if (branches.includes("origin/master")) return "master";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repo Status
// ---------------------------------------------------------------------------

/**
 * Get detailed status for a registered repository.
 */
export async function getRepoStatus(repoRecord, workspaceRoot, registryInstance = null) {
  const repoDir = repoRecord.canonical_path;
  const branch = repoRecord.default_branch;

  let localHead = null;
  let remoteHead = null;
  let currentBranch = null;
  let ahead = 0;
  let behind = 0;
  let hasUncommitted = false;

  if (repoDir && existsSync(join(repoDir, ".git"))) {
    localHead = _gitExec(repoDir, "rev-parse HEAD 2>/dev/null") || null;
    currentBranch = _gitExec(repoDir, "rev-parse --abbrev-ref HEAD 2>/dev/null") || null;
    hasUncommitted = (_gitExec(repoDir, "status --porcelain 2>/dev/null") || "").length > 0;

    // Try local remote tracking ref first
    remoteHead = _gitExec(repoDir, `rev-parse refs/remotes/origin/${branch} 2>/dev/null`);
    if (!remoteHead) {
      const remote = _gitExec(repoDir, "remote get-url origin 2>/dev/null");
      if (remote) {
        const ls = _gitExec(null, `ls-remote "${remote}" refs/heads/${branch} 2>/dev/null`);
        if (ls) remoteHead = ls.split(/\s+/)[0] || null;
      }
    }

    if (localHead) {
      const ab = _gitExec(repoDir, `rev-list --left-right --count origin/${branch}...HEAD 2>/dev/null`);
      if (ab) {
        const parts = ab.split(/\s+/);
        behind = parseInt(parts[0], 10) || 0;
        ahead = parseInt(parts[1], 10) || 0;
      }
    }
  }

  let staleTempCopies = [];
  if (registryInstance) {
    staleTempCopies = await registryInstance.detectStaleTempClones();
  } else {
    staleTempCopies = await detectStaleTempClones(workspaceRoot);
  }

  const canonicalRelPath = repoRecord.canonical_path
    ? relative(workspaceRoot, repoRecord.canonical_path)
    : deriveCanonicalRelPath(repoRecord.repo_id);

  return {
    repo_id: repoRecord.repo_id,
    remote_url: repoRecord.remote_url,
    default_branch: branch,
    canonical_path: repoRecord.canonical_path,
    canonical_rel_path: canonicalRelPath,
    current_branch: currentBranch,
    local_head: localHead,
    remote_head: remoteHead,
    ahead,
    behind,
    has_uncommitted: hasUncommitted,
    is_canonical: repoRecord.canonical_path
      ? isCanonicalPath(repoRecord.canonical_path, workspaceRoot)
      : false,
    stale_temp_copies: staleTempCopies.filter((c) => c.is_repo),
  };
}
