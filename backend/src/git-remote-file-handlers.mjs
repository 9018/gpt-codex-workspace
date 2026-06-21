import { defaultRemoteRef, getCurrentBranch, getDirtyInfo, getLocalHead, getRemoteHeadViaLsRemote, getRemoteUrl, getTrackingRef, gitBuffer, gitText, parseNameStatusLines, resolveRepo } from "./git-remote-core.mjs";

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
