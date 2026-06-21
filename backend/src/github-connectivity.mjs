import { execSync } from "node:child_process";
import { _isTruthy, hasGit, splitRepo } from "./github-adapter-utils.mjs";

export function checkDirectGitAvailable(cwd) {
  if (!hasGit()) return { available: false, reason: "git not found" };
  try {
    execSync("git rev-parse --git-dir", { cwd: cwd || undefined, stdio: "pipe", timeout: 5000 });
    return { available: true, git_dir: true };
  } catch {
    return { available: true, git_dir: false, reason: "cwd is not a git repo" };
  }
}

/**
 * Check whether SSH authentication to GitHub is likely working.
 * Uses only ssh -T exit status/output, never reads private keys.
 */
export function checkSshAuthAvailable() {
  if (!hasGit()) return { available: false, reason: "git not found" };
  try {
    const out = execSync("ssh -T git@github.com 2>&1; true", { stdio: "pipe", timeout: 10000, encoding: "utf8" });
    const text = out || "";
    if (text.includes("successfully authenticated")) {
      const userMatch = text.match(/Hi\s+(\S+?)\s*/);
      return { available: true, authenticated_user: userMatch ? userMatch[1] : "unknown" };
    }
    if (text.includes("Permission denied")) {
      return { available: false, reason: "ssh key not accepted by GitHub" };
    }
    return { available: false, reason: "ssh check did not confirm authentication" };
  } catch {
    return { available: false, reason: "ssh check command failed" };
  }
}

/**
 * Check whether the gh CLI is installed and authenticated.
 */
export function checkGhCliAvailable() {
  try {
    execSync("gh --version", { stdio: "pipe", timeout: 5000, encoding: "utf8" });
    const out = execSync("gh auth status 2>&1", { stdio: "pipe", timeout: 5000, encoding: "utf8" });
    if (out.includes("Logged in")) {
      return { available: true, authenticated: true };
    }
    return { available: true, authenticated: false, reason: "gh not logged in" };
  } catch {
    return { available: false, reason: "gh not found or not configured" };
  }
}

/**
 * Detect the git repo context from a workspace path.
 * Returns owner/repo, remote URL, and whether it's a git repo.
 */
export function detectWorkspaceRepo(path) {
  if (!hasGit()) return { is_git: false, owner_repo: null, remote_url: null };
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      cwd: path || undefined, stdio: "pipe", timeout: 5000, encoding: "utf8"
    }).trim();
    if (!toplevel) return { is_git: false, owner_repo: null, remote_url: null };
    let owner_repo = null;
    let remote_url = null;
    try {
      remote_url = execSync("git config --get remote.origin.url", {
        cwd: toplevel, stdio: "pipe", timeout: 5000, encoding: "utf8"
      }).trim();
      const httpsParse = remote_url.match(/github\.com[:\/]([^/\s]+?\/[^/\s]+?)(?:\.git)?$/);
      if (httpsParse) owner_repo = httpsParse[1];
    } catch { /* no remote */ }
    return { is_git: true, toplevel, owner_repo, remote_url };
  } catch {
    return { is_git: false, owner_repo: null, remote_url: null };
  }
}

/**
 * Try to fetch a GitHub issue using multiple strategies:
 * 1. GitHub API token -> 2. gh CLI -> 3. Unauthenticated REST API -> unavailable
 */
export async function grabIssue(issueNumber, repoFull) {
  const { owner, repo: repoName } = splitRepo(repoFull || process.env.GPTWORK_GITHUB_REPO || "");
  if (!owner || !repoName || !issueNumber) {
    return { issue: null, source: "unavailable", error: "missing owner/repo or issue number" };
  }

  // Strategy 1: GitHub API token
  const token = process.env.GPTWORK_GITHUB_TOKEN || "";
  if (token && process.env.GPTWORK_GITHUB_REPO) {
    try {
      const url = "https://api.github.com/repos/" + owner + "/" + repoName + "/issues/" + issueNumber;
      const response = await fetch(url, {
        headers: {
          "Authorization": "Bearer " + token,
          "Accept": "application/vnd.github+json",
          "User-Agent": "gptwork-mcp/0.2"
        }
      });
      if (response.ok) {
        const data = await response.json();
        return {
          issue: { number: data.number, title: data.title, body: data.body || "", state: data.state, labels: (data.labels || []).map(function(l) { return typeof l === "string" ? l : l.name || ""; }), url: data.html_url },
          source: "github-api-token"
        };
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: gh CLI
  try {
    const out = execSync("gh issue view " + issueNumber + " --repo " + owner + "/" + repoName + " --json title,body,labels,state,url 2>&1", {
      stdio: "pipe", timeout: 15000, encoding: "utf8"
    });
    const data = JSON.parse(out);
    return {
      issue: { number: issueNumber, title: data.title, body: data.body || "", state: data.state, labels: Array.isArray(data.labels) ? data.labels.map(function(l) { return typeof l === "string" ? l : l.name || l; }) : [], url: data.url },
      source: "gh-cli"
    };
  } catch { /* fall through */ }

  // Strategy 3: Unauthenticated GitHub REST API (public repos)
  try {
    const url = "https://api.github.com/repos/" + owner + "/" + repoName + "/issues/" + issueNumber;
    const response = await fetch(url, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "gptwork-mcp/0.2" }
    });
    if (response.ok) {
      const data = await response.json();
      return {
        issue: { number: data.number, title: data.title, body: data.body || "", state: data.state, labels: (data.labels || []).map(function(l) { return typeof l === "string" ? l : l.name || ""; }), url: data.html_url },
        source: "github-public-rest"
      };
    }
  } catch { /* fall through */ }

  return { issue: null, source: "unavailable", error: "all strategies failed" };
}

/**
 * Compute full status with async shell checks.
 */
export function getStatusWithAsyncChecks(cwd) {
  const base = { api_sync_enabled: _isTruthy(process.env.GPTWORK_GITHUB_ENABLED) && !!(process.env.GPTWORK_GITHUB_REPO && process.env.GPTWORK_GITHUB_TOKEN), api_repo: process.env.GPTWORK_GITHUB_REPO || null, api_token_set: !!process.env.GPTWORK_GITHUB_TOKEN, detected_repo_from_workspace: null, detected_remote_url: null, direct_git_available: null, ssh_auth_likely_available: null, gh_cli_available: null, last_delivery_channel: null };
  const gitCheck = checkDirectGitAvailable(cwd);
  base.direct_git_available = gitCheck.available;
  if (gitCheck.available) {
    const wsRepo = detectWorkspaceRepo(cwd);
    base.detected_repo_from_workspace = wsRepo.owner_repo;
    base.detected_remote_url = wsRepo.remote_url;
  }
  const sshCheck = checkSshAuthAvailable();
  base.ssh_auth_likely_available = sshCheck.available;
  const ghCheck = checkGhCliAvailable();
  base.gh_cli_available = ghCheck.available;
  return base;
}

/**
 * Build a result for sync_to_github that includes both API sync and direct git push status.
 */
export function syncToGitHubResult(task, existingDelivery) {
  const apiEnabled = _isTruthy(process.env.GPTWORK_GITHUB_ENABLED) && !!(process.env.GPTWORK_GITHUB_REPO && process.env.GPTWORK_GITHUB_TOKEN);
  const result = {
    api_sync: apiEnabled ? "enabled" : "disabled",
    direct_git_result: "unavailable",
    remote_commit: null,
    delivery_channel: "none"
  };
  if (existingDelivery) {
    result.direct_git_result = "already_pushed";
    result.remote_commit = existingDelivery.remote_commit || null;
    result.delivery_channel = existingDelivery.delivery_channel || "direct-git";
  } else {
    const gitAvail = hasGit();
    result.direct_git_result = gitAvail ? "available" : "unavailable";
  }
  if (apiEnabled) {
    result.delivery_channel = "github-api-sync";
  } else if (result.direct_git_result === "already_pushed") {
    result.delivery_channel = result.delivery_channel;
  } else if (result.direct_git_result === "available") {
    result.delivery_channel = "direct-git";
  }
  return result;
}

