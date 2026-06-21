import { defaultRemoteRef, getCurrentBranch, getDirtyInfo, getLocalHead, getRemoteHeadViaLsRemote, getRemoteUrl, getTrackingRef, gitBuffer, gitText, parseNameStatusLines, resolveRepo } from "./git-remote-core.mjs";

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
