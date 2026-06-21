import { defaultRemoteRef, getCurrentBranch, getDirtyInfo, getLocalHead, getRemoteHeadViaLsRemote, getRemoteUrl, getTrackingRef, gitBuffer, gitText, parseNameStatusLines, resolveRepo } from "./git-remote-core.mjs";

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
