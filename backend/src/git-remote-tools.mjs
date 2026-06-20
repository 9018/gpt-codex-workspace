// git-remote-tools.mjs
// Git remote ref reader tools for workmcp.
// Use these when the user asks to inspect GitHub remote repository code and
// GitHub connector is unavailable. They read through workspace Git remote
// tracking refs and require no GitHub MCP.
//
// Each tool accepts (repo | repo_path) to locate the Git checkout:
//   repo      - owner/name ("9018/gpt-codex-workspace") or full URL
//   repo_path - explicit local filesystem path to the checkout

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseGitHubUrl } from "./repo-registry.mjs";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function runGit(repoDir, args, { timeout = 15000, maxBuffer = 1000000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repoDir || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeout}ms`));
    }, timeout);

    function collect(target, chunk, currentBytes) {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > maxBuffer && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error(`git ${args.join(" ")} exceeded max output ${maxBuffer} bytes`));
      }
      if (!settled) target.push(chunk);
      return nextBytes;
    }

    child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (code !== 0) {
        const error = new Error(stderrBuffer.toString("utf8").trim() || `git ${args.join(" ")} exited ${code}`);
        error.code = code;
        error.stderr = stderrBuffer.toString("utf8");
        error.stdout = stdoutBuffer.toString("utf8");
        reject(error);
        return;
      }
      resolvePromise({ stdout: stdoutBuffer, stderr: stderrBuffer });
    });
  });
}

async function gitText(repoDir, args, options) {
  try {
    const result = await runGit(repoDir, args, options);
    return result.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
}

async function gitBuffer(repoDir, args, options) {
  const result = await runGit(repoDir, args, options);
  return result.stdout;
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

async function getRemoteUrl(repoDir, remote) {
  return gitText(repoDir, ["remote", "get-url", remote]);
}

async function getCurrentBranch(repoDir) {
  const ref = await gitText(repoDir, ["symbolic-ref", "HEAD"]);
  if (ref && ref.startsWith("refs/heads/")) return ref.slice(11);
  return null;
}

async function getLocalHead(repoDir) {
  return gitText(repoDir, ["rev-parse", "HEAD"]);
}

async function getTrackingRef(repoDir, remote, branch) {
  const ref = `refs/remotes/${remote}/${branch}`;
  const sha = await gitText(repoDir, ["rev-parse", ref]);
  if (sha) return { trackingRef: ref, trackingHead: sha };
  return { trackingRef: null, trackingHead: null };
}

async function getRemoteHeadViaLsRemote(repoDir, remote, branch) {
  const remoteUrl = await getRemoteUrl(repoDir, remote);
  if (!remoteUrl) return null;
  const out = await gitText(null, ["ls-remote", remoteUrl, `refs/heads/${branch}`]);
  if (out) {
    const parts = out.split(/\s+/);
    return parts[0] || null;
  }
  return null;
}

async function getDirtyInfo(repoDir) {
  const out = await gitText(repoDir, ["status", "--porcelain"]);
  if (!out) return { dirty: false, dirtyPaths: [] };
  const lines = out.split("\n").filter(Boolean);
  return { dirty: lines.length > 0, dirtyPaths: lines.map((line) => line.replace(/^.. /, "")).filter(Boolean) };
}

function parseNameStatusLines(lines, limit) {
  return lines.slice(0, limit).map((line) => {
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

function defaultRemoteRef(defaultRemote, defaultBranch) {
  return `${defaultRemote || "origin"}/${defaultBranch || "main"}`;
}

// ---------------------------------------------------------------------------
// Tool handlers  (called from gptwork-server.mjs createTools)
// ---------------------------------------------------------------------------

export async function handleResolveRepo(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) {
    return { ok: false, found: false, error: "Repository not found. No matching Git checkout discovered. Use repo_path to specify the path.", repo: repo || null, repo_path: repo_path || null };
  }
  const effectiveRemote = defaultRemote || "origin";
  const remoteUrl = await getRemoteUrl(repoDir, effectiveRemote);
  const currentBranch = await getCurrentBranch(repoDir);
  const localHead = await getLocalHead(repoDir);
  const tracking = await getTrackingRef(repoDir, effectiveRemote, currentBranch || "main");
  let resolvedDefaultBranch = "main";
  const remoteHeadRef = await gitText(repoDir, ["symbolic-ref", `refs/remotes/${effectiveRemote}/HEAD`]);
  if (remoteHeadRef) {
    const escapedRemote = effectiveRemote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = remoteHeadRef.match(new RegExp("refs/remotes/" + escapedRemote + "/(.+)"));
    if (match) resolvedDefaultBranch = match[1];
  }
  return {
    ok: true, found: true, repo_path: repoDir, remote: "origin",
    remote_url: remoteUrl, default_branch: resolvedDefaultBranch,
    current_branch: currentBranch || null, local_head: localHead || null,
    tracking_ref: tracking.trackingRef, tracking_head: tracking.trackingHead,
  };
}

export async function handleFetch(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  await gitText(repoDir, ["fetch", remote, branch], { timeout: 30000, maxBuffer: 2000000 });
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = await gitText(repoDir, ["rev-parse", trackingRef]) || null;
  return { ok: true, repo_path: repoDir, remote, branch, tracking_ref: trackingRef, tracking_head: trackingHead };
}

export async function handleStatus(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const fetch = args.fetch !== undefined ? args.fetch : true;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  if (fetch) await gitText(repoDir, ["fetch", remote, branch], { timeout: 30000, maxBuffer: 2000000 });
  const localHead = await getLocalHead(repoDir);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = await gitText(repoDir, ["rev-parse", trackingRef]) || null;
  const remoteHead = await getRemoteHeadViaLsRemote(repoDir, remote, branch);
  const dirty = await getDirtyInfo(repoDir);
  return {
    ok: true, repo_path: repoDir, remote, branch, local_head: localHead || null,
    tracking_head: trackingHead, remote_head: remoteHead,
    local_equals_tracking: localHead && trackingHead ? localHead === trackingHead : null,
    tracking_equals_remote: trackingHead && remoteHead ? trackingHead === remoteHead : null,
    dirty: dirty.dirty, dirty_paths: dirty.dirtyPaths,
  };
}

export async function handleListFiles(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || defaultRemoteRef(defaultRemote, defaultBranch);
  const path = args.path;
  const limit = args.limit || 200;
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  const gitArgs = path ? ["ls-tree", "-r", "--name-only", ref, path] : ["ls-tree", "-r", "--name-only", ref];
  const out = await gitText(repoDir, gitArgs);
  if (out === null) return { ok: false, error: `Failed to list files for ref "${ref}". The ref may not exist or be invalid.`, repo_path: repoDir, ref };
  const files = out.split("\n").filter(Boolean);
  return { ok: true, repo_path: repoDir, ref, path: path || null, total_count: files.length, truncated: files.length > limit, limit, files: files.slice(0, limit) };
}

export async function handleReadFile(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || defaultRemoteRef(defaultRemote, defaultBranch);
  const path = args.path;
  const max_bytes = args.max_bytes || 200000;
  if (!path) return { ok: false, error: "path is required" };
  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };
  try {
    const buf = await gitBuffer(repoDir, ["show", `${ref}:${path}`], { timeout: 15000, maxBuffer: Math.max(max_bytes + 1024, 1000000) });
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

export async function handleChangedFiles(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const base = args.base || "HEAD";
  const head = args.head || defaultRemoteRef(defaultRemote, defaultBranch);
  const path = args.path;
  const limit = args.limit || 500;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  const gitArgs = path ? ["diff", "--name-status", `${base}..${head}`, "--", path] : ["diff", "--name-status", `${base}..${head}`];
  const out = await gitText(repoDir, gitArgs);
  if (out === null) return { ok: false, error: `Failed to diff ${base}..${head}. The refs may not exist or be invalid.`, repo_path: repoDir || null, base, head };

  const lines = out ? out.split("\n").filter(Boolean) : [];
  const files = parseNameStatusLines(lines, limit);

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

export async function handleDiff(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const base = args.base || "HEAD";
  const head = args.head || defaultRemoteRef(defaultRemote, defaultBranch);
  const path = args.path;
  const maxBytes = args.max_bytes || 200000;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  try {
    const gitArgs = path ? ["diff", `${base}..${head}`, "--", path] : ["diff", `${base}..${head}`];
    const buf = await gitBuffer(repoDir, gitArgs, { timeout: 30000, maxBuffer: Math.max(maxBytes + 1024, 1000000) });
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

export async function handleShowCommit(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const ref = args.ref || defaultRemoteRef(defaultRemote, defaultBranch);
  const maxFiles = args.max_files || 100;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  const raw = await gitText(repoDir, ["show", "--format=SHA:%H%nSHORT:%h%nSUBJECT:%s%nAUTHOR_NAME:%an%nAUTHOR_EMAIL:%ae%nAUTHORED_AT:%ai%nCOMMITTED_AT:%ci%n---", "--name-status", ref]);
  if (raw === null) return { ok: false, error: `Failed to show commit "${ref}". The ref may not exist or be invalid.`, repo_path: repoDir };

  const sepIdx = raw.indexOf("\n---\n");
  const metaRaw = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  const filesRaw = sepIdx >= 0 ? raw.slice(sepIdx + 5) : "";

  const meta = {};
  for (const line of metaRaw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      meta[line.slice(0, colonIdx)] = line.slice(colonIdx + 1);
    }
  }

  const fileLines = filesRaw.split("\n").filter(Boolean);
  const files = parseNameStatusLines(fileLines, maxFiles);

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

export async function handleCompareLocal(args, { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const repo = args.repo !== undefined ? args.repo : defaultRepo;
  const repo_path = args.repo_path !== undefined ? args.repo_path : defaultRepoPath;
  const remote = args.remote || defaultRemote || "origin";
  const branch = args.branch || defaultBranch || "main";
  const fetchEnabled = args.fetch !== undefined ? args.fetch : true;
  const limit = args.limit || 200;

  const repoDir = resolveRepo(repo || null, repo_path || null, registry, defaultWorkspaceRoot);
  if (!repoDir) return { ok: false, found: false, error: "Repository not found." };

  if (fetchEnabled) await gitText(repoDir, ["fetch", remote, branch], { timeout: 30000, maxBuffer: 2000000 });

  const localHead = await getLocalHead(repoDir);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const trackingHead = await gitText(repoDir, ["rev-parse", trackingRef]) || null;
  const remoteHead = await getRemoteHeadViaLsRemote(repoDir, remote, branch);
  const dirty = await getDirtyInfo(repoDir);

  let aheadCount = 0;
  let behindCount = 0;
  if (localHead && trackingHead) {
    const aheadOut = await gitText(repoDir, ["rev-list", "--count", `${trackingRef}..HEAD`]);
    const behindOut = await gitText(repoDir, ["rev-list", "--count", `HEAD..${trackingRef}`]);
    if (aheadOut) aheadCount = parseInt(aheadOut, 10) || 0;
    if (behindOut) behindCount = parseInt(behindOut, 10) || 0;
  }

  const changedOut = await gitText(repoDir, ["diff", "--name-status", `HEAD..${trackingRef}`]);
  let changedFiles = [];
  if (changedOut) {
    const lines = changedOut.split("\n").filter(Boolean).slice(0, limit);
    changedFiles = parseNameStatusLines(lines, limit);
  }

  return {
    ok: true,
    repo_path: repoDir,
    remote,
    branch,
    local_head: localHead || null,
    tracking_ref: trackingRef,
    tracking_head: trackingHead,
    remote_head: remoteHead,
    local_equals_tracking: localHead && trackingHead ? localHead === trackingHead : null,
    tracking_equals_remote: trackingHead && remoteHead ? trackingHead === remoteHead : null,
    ahead_count: aheadCount,
    behind_count: behindCount,
    dirty: dirty.dirty,
    dirty_paths: dirty.dirtyPaths,
    changed_files: changedFiles,
    changed_files_truncated: changedFiles.length >= limit,
  };
}
