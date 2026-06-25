import { readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

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
 *   .gptwork/worktrees/<host>/<owner>/<repo>/<taskId>
 */
export function deriveWorktreeRelPath(repo_id, taskId) {
  return `.gptwork/worktrees/${repo_id}/${taskId}`;
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
