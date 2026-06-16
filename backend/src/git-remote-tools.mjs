// git-remote-tools.mjs
// Git remote ref reader tools for workmcp.
// Use these when the user asks to inspect GitHub remote repository code and
// GitHub connector is unavailable. They read through workspace Git remote
// tracking refs and require no GitHub MCP.
//
// Each tool accepts (repo | repo_path) to locate the Git checkout:
//   repo      - owner/name ("9018/gpt-codex-workspace") or full URL
//   repo_path - explicit local filesystem path to the checkout

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseGitHubUrl } from "./repo-registry.mjs";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _gitExec(repoDir, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoDir || process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

/** Walk up from startDir looking for a .git directory. */
function _findGitDir(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a repo spec to a local Git checkout directory.
 *
 * Resolution order:
 *  1. repo_path given -> resolve (walk up to .git)
 *  2. repo given      -> look up in registry, then canonical workspace path
 *  3. Fallback        -> walk up from cwd
 */
function resolveRepo(fromRepo, fromPath, registry, defaultWorkspaceRoot) {
  if (fromPath) {
    const gitDir = _findGitDir(fromPath);
    if (gitDir) return gitDir;
    return null;
  }

  if (fromRepo) {
    if (registry) {
      const repoId = registry.resolveRepoId(fromRepo);
      if (repoId) {
        const record = registry.get(repoId);
        if (record && record.canonical_path) {
          const gitDir = _findGitDir(record.canonical_path);
          if (gitDir) return gitDir;
        }
      }
    }
    const parsed = parseGitHubUrl(fromRepo);
    if (parsed && defaultWorkspaceRoot) {
      const candidate = join(defaultWorkspaceRoot, `repos/${parsed.repo_id}`);
      const gitDir = _findGitDir(candidate);
      if (gitDir) return gitDir;
    }
  }

  return _findGitDir(process.cwd());
}

function getRemoteUrl(repoDir, remote) {
  return _gitExec(repoDir, `remote get-url ${remote} 2>/dev/null`);
}

function getCurrentBranch(repoDir) {
  const ref = _gitExec(repoDir, "symbolic-ref HEAD 2>/dev/null");
  if (ref && ref.startsWith("refs/heads/")) return ref.slice(11);
  return null;
}

function getLocalHead(repoDir) {
  return _gitExec(repoDir, "rev-parse HEAD 2>/dev/null");
}

function getTrackingRef(repoDir, remote, branch) {
  const ref = `refs/remotes/${remote}/${branch}`;
  const sha = _gitExec(repoDir, `rev-parse ${ref} 2>/dev/null`);
  if (sha) return { trackingRef: ref, trackingHead: sha };
  return { trackingRef: null, trackingHead: null };
}

function getRemoteHeadViaLsRemote(repoDir, remote, branch) {
  const remoteUrl = getRemoteUrl(repoDir, remote);
  if (!remoteUrl) return null;
  const out = _gitExec(null, `ls-remote "${remoteUrl}" refs/heads/${branch} 2>/dev/null`);
  if (out) {
    const parts = out.split(/\s+/);
    return parts[0] || null;
  }
  return null;
}

function getDirtyInfo(repoDir) {
  const out = _gitExec(repoDir, "status --porcelain 2>/dev/null");
  if (!out) return { dirty: false, dirtyPaths: [] };
  const lines = out.split("\n").filter(Boolean);
  return { dirty: lines.length > 0, dirtyPaths: lines.map((l) => l.replace(/^.. /, "")).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Tool handlers  (called from gptwork-server.mjs createTools)
// ---------------------------------------------------------------------------

export function handleResolveRepo(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) {
    return { ok: false, found: false, error: "Repository not found. No matching Git checkout discovered. Use repo_path to specify the path.", repo: repo || null, repo_path: repo_path || null };
  }
  const effectiveRemote = defaultRemote || "origin";
  const remoteUrl = getRemoteUrl(repoDir, effectiveRemote);
  const currentBranch = getCurrentBranch(repoDir);
  const localHead = getLocalHead(repoDir);
  const tracking = getTrackingRef(repoDir, effectiveRemote, currentBranch || "main");
  let resolvedDefaultBranch = "main";
  const remoteHeadRef = _gitExec(repoDir, `symbolic-ref refs/remotes/${effectiveRemote}/HEAD 2>/dev/null`);
  if (remoteHeadRef) {
    const escapedRemote = effectiveRemote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = remoteHeadRef.match(new RegExp('refs/remotes/' + escapedRemote + '/(.+)'));
    if (m) resolvedDefaultBranch = m[1];
  }
  return {
    ok: true, found: true, repo_path: repoDir, remote: "origin",
    remote_url: remoteUrl, default_branch: resolvedDefaultBranch,
    current_branch: currentBranch || null, local_head: localHead || null,
    tracking_ref: tracking.trackingRef, tracking_head: tracking.trackingHead,
  };
}

export function handleFetch(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  _gitExec(repoDir, `fetch ${remote} ${branch} 2>&1`);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = _gitExec(repoDir, `rev-parse ${trackingRef} 2>/dev/null`) || null;
  return { ok: true, repo_path: repoDir, remote, branch, tracking_ref: trackingRef, tracking_head: trackingHead };
}

export function handleStatus(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const fetch = args.fetch !== undefined ? args.fetch : true;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  if (fetch) _gitExec(repoDir, `fetch ${remote} ${branch} 2>/dev/null`);
  const localHead = getLocalHead(repoDir);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = _gitExec(repoDir, `rev-parse ${trackingRef} 2>/dev/null`) || null;
  const remoteHead = getRemoteHeadViaLsRemote(repoDir, remote, branch);
  const dirty = getDirtyInfo(repoDir);
  return {
    ok: true, repo_path: repoDir, remote, branch, local_head: localHead || null,
    tracking_head: trackingHead, remote_head: remoteHead,
    local_equals_tracking: localHead && trackingHead ? localHead === trackingHead : null,
    tracking_equals_remote: trackingHead && remoteHead ? trackingHead === remoteHead : null,
    dirty: dirty.dirty, dirty_paths: dirty.dirtyPaths,
  };
}

export function handleListFiles(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || `${defaultRemote || "origin"}/${defaultBranch || "main"}`;
  const path = args.path;
  const limit = args.limit || 200;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  const treeArgs = path ? `ls-tree -r --name-only ${ref} ${path}` : `ls-tree -r --name-only ${ref}`;
  const out = _gitExec(repoDir, treeArgs);
  if (out === null) return { ok: false, error: `Failed to list files for ref "${ref}". The ref may not exist or be invalid.`, repo_path: repoDir, ref };
  const files = out.split("\n").filter(Boolean);
  return { ok: true, repo_path: repoDir, ref, path: path || null, total_count: files.length, truncated: files.length > limit, limit, files: files.slice(0, limit) };
}

export function handleReadFile(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || `${defaultRemote || "origin"}/${defaultBranch || "main"}`;
  const path = args.path;
  const max_bytes = args.max_bytes || 200000;
  if (!path) return { ok: false, error: "path is required" };
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  try {
    const buf = execSync(`git show ${ref}:${path}`, { cwd: repoDir, encoding: "buffer", stdio: "pipe", timeout: 15000 });
    const bytes = buf.length;
    const truncated = bytes > max_bytes;
    const content = truncated ? buf.subarray(0, max_bytes).toString("utf8") : buf.toString("utf8");
    return { ok: true, repo_path: repoDir, ref, path, content, bytes, truncated };
  } catch (err) {
    return { ok: false, error: `Failed to read file "${path}" at ref "${ref}": ${err.message || err}`, repo_path: repoDir, ref, path };
  }
}

// ---------------------------------------------------------------------------
// git_remote_changed_files
// ---------------------------------------------------------------------------

export function handleChangedFiles(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const base = args.base || "HEAD";
  const head = args.head || (defaultRemote + "/" + defaultBranch || "origin/main");
  const path = args.path;
  const limit = args.limit || 500;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  const out = _gitExec(repoDir, `diff --name-status ${base}..${head}${path ? ` -- ${path}` : ""} 2>/dev/null`);
  if (out === null) return { ok: false, error: `Failed to diff ${base}..${head}. The refs may not exist or be invalid.`, repo_path: repoDir || null, base, head };

  const lines = out ? out.split("\n").filter(Boolean) : [];
  const files = lines.slice(0, limit).map((line) => {
    const parts = line.split("\t");
    const status = parts[0];
    const filePath = parts[1];
    let old_path;
    if ((status[0] === "R" || status[0] === "C") && parts.length >= 3) {
      old_path = parts[1];
      return { status, path: parts[2], old_path };
    }
    return { status, path: filePath };
  });

  return {
    ok: true,
    repo_path: repoDir,
    base,
    head,
    path: path || null,
    total_count: lines.length,
    truncated: lines.length > limit,
    files,
  };
}

// ---------------------------------------------------------------------------
// git_remote_diff
// ---------------------------------------------------------------------------

export function handleDiff(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const base = args.base || "HEAD";
  const head = args.head || (defaultRemote + "/" + defaultBranch || "origin/main");
  const path = args.path;
  const maxBytes = args.max_bytes || 200000;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  try {
    const buf = execSync(`git diff ${base}..${head}${path ? ` -- ${path}` : ""}`, {
      cwd: repoDir,
      encoding: "buffer",
      stdio: "pipe",
      timeout: 30000,
    });
    const bytes = buf.length;
    const truncated = bytes > maxBytes;
    const diff = truncated ? buf.subarray(0, maxBytes).toString("utf8") : buf.toString("utf8");
    return { ok: true, repo_path: repoDir, base, head, path: path || null, diff, bytes, truncated };
  } catch (err) {
    if (err.stderr && err.stderr.includes("bad revision")) {
      return { ok: false, error: `Failed to diff ${base}..${head}. The refs may not exist or be invalid.`, repo_path: repoDir };
    }
    return { ok: false, error: `Failed to diff ${base}..${head}: ${err.message || err}`, repo_path: repoDir };
  }
}

// ---------------------------------------------------------------------------
// git_remote_show_commit
// ---------------------------------------------------------------------------

export function handleShowCommit(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || (defaultRemote + "/" + defaultBranch || "origin/main");
  const maxFiles = args.max_files || 100;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  // Use git show with custom format and --name-status
  // The format outputs key:value lines, then --- separator, then name-status lines
  const raw = _gitExec(repoDir, `show --format="SHA:%H%nSHORT:%h%nSUBJECT:%s%nAUTHOR_NAME:%an%nAUTHOR_EMAIL:%ae%nAUTHORED_AT:%ai%nCOMMITTED_AT:%ci%n---" --name-status ${ref} 2>/dev/null`);
  if (raw === null) return { ok: false, error: `Failed to show commit "${ref}". The ref may not exist or be invalid.`, repo_path: repoDir };

  // Split metadata and file sections
  const sepIdx = raw.indexOf("\n---\n");
  const metaRaw = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  const filesRaw = sepIdx >= 0 ? raw.slice(sepIdx + 5) : "";

  // Parse metadata
  const meta = {};
  for (const line of metaRaw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      meta[line.slice(0, colonIdx)] = line.slice(colonIdx + 1);
    }
  }

  // Parse file list
  const fileLines = filesRaw.split("\n").filter(Boolean);
  const files = fileLines.slice(0, maxFiles).map((line) => {
    const parts = line.split("\t");
    const status = parts[0];
    const filePath = parts[1];
    let old_path;
    if ((status[0] === "R" || status[0] === "C") && parts.length >= 3) {
      old_path = parts[1];
      return { status, path: parts[2], old_path };
    }
    return { status, path: filePath };
  });

  return {
    ok: true,
    repo_path: repoDir,
    ref,
    sha: meta.SHA || null,
    short_sha: meta.SHORT || null,
    subject: meta.SUBJECT || null,
    author_name: meta.AUTHOR_NAME || null,
    author_email: meta.AUTHOR_EMAIL || null,
    authored_at: meta.AUTHORED_AT || null,
    committed_at: meta.COMMITTED_AT || null,
    files,
    total_count: fileLines.length,
    truncated: fileLines.length > maxFiles,
  };
}

// ---------------------------------------------------------------------------
// git_remote_compare_local
// ---------------------------------------------------------------------------

export function handleCompareLocal(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const fetchEnabled = args.fetch !== undefined ? args.fetch : true;
  const limit = args.limit || 200;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  // Fetch remote tracking refs
  if (fetchEnabled) _gitExec(repoDir, `fetch ${remote} ${branch} 2>/dev/null`);

  const localHead = getLocalHead(repoDir);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = _gitExec(repoDir, `rev-parse ${trackingRef} 2>/dev/null`) || null;
  const remoteHead = getRemoteHeadViaLsRemote(repoDir, remote, branch);
  const dirty = getDirtyInfo(repoDir);

  // ahead/behind counts
  let aheadCount = 0;
  let behindCount = 0;
  if (localHead && trackingHead) {
    const aheadOut = _gitExec(repoDir, `rev-list --count ${trackingRef}..HEAD 2>/dev/null`);
    const behindOut = _gitExec(repoDir, `rev-list --count HEAD..${trackingRef} 2>/dev/null`);
    if (aheadOut) aheadCount = parseInt(aheadOut, 10) || 0;
    if (behindOut) behindCount = parseInt(behindOut, 10) || 0;
  }

  // Changed files between HEAD and tracking
  const changedOut = _gitExec(repoDir, `diff --name-status HEAD..${trackingRef} 2>/dev/null`);
  let changedFiles = [];
  if (changedOut) {
    const lines = changedOut.split("\n").filter(Boolean).slice(0, limit);
    changedFiles = lines.map((line) => {
      const parts = line.split("\t");
      const status = parts[0];
      const filePath = parts[1];
      let old_path;
      if ((status[0] === "R" || status[0] === "C") && parts.length >= 3) {
        old_path = parts[1];
        return { status, path: parts[2], old_path };
      }
      return { status, path: filePath };
    });
  }

  return {
    ok: true,
    repo_path: repoDir,
    remote,
    branch,
    local_head: localHead || null,
    tracking_head: trackingHead,
    remote_head: remoteHead,
    local_equals_tracking: localHead && trackingHead ? localHead === trackingHead : null,
    tracking_equals_remote: trackingHead && remoteHead ? trackingHead === remoteHead : null,
    dirty: dirty.dirty,
    dirty_paths: dirty.dirtyPaths,
    ahead_count: aheadCount,
    behind_count: behindCount,
    changed_files: changedFiles,
  };
}
