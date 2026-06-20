import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";


/**
 * Determine if a value is truthy (like _getBool in runtime-config.mjs but
 * standalone).  When undefined/null returns false (default-off).
 */
function _isTruthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1";
}

/**
 * Parse an owner/repo string from text like:
 *   "repo:9018/gpt-codex-workspace"
 *   "9018/gpt-codex-workspace"
 *   "https://github.com/9018/gpt-codex-workspace"
 *   "git@github.com:9018/gpt-codex-workspace.git"
 * Returns "owner/repo" or null.
 */
export function parseRepo(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const httpsMatch = trimmed.match(/github\.com\/([^/\s]+?\/[^/\s?#]+?)(?:\.git)?(?:\s|$|[?#])/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = trimmed.match(/git@github\.com:([^/\s]+?\/[^/\s]+?)(?:\.git)?(?:\s|$)/);
  if (sshMatch) return sshMatch[1];
  const repoMatch = trimmed.match(/(?:repo:\s*)?([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)(?:\.git)?(?:\s|$)/);
  if (repoMatch) return repoMatch[1];
  return null;
}

/**
 * Parse an issue number from text like: "Issue #1", "#1", "issue 42"
 * Returns the number or null.
 */
export function parseIssueNumber(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/(?:[Ii]ssue\s*)?#?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function hasGit() {
  try { execSync("git --version", { stdio: "pipe", timeout: 5000 }); return true; }
  catch { return false; }
}

function splitRepo(repoFull) {
  const parts = (repoFull || "").split("/");
  return { owner: parts[0] || "", repo: parts[1] || "" };
}


export function createGithubSync(config) {
  // Use config values (resolved from options/process.env/runtime.env) with
  // direct process.env fallback for backward compatibility.
  // githubEnabled resolves GPTWORK_GITHUB_ENABLED with proper precedence
  // (process.env > runtime.env > code defaults), defaulting to false.
  const repo = config.githubRepo || process.env.GPTWORK_GITHUB_REPO || "";
  const token = config.githubToken || process.env.GPTWORK_GITHUB_TOKEN || "";
  const enabled = _isTruthy(config.githubEnabled !== undefined ? config.githubEnabled : process.env.GPTWORK_GITHUB_ENABLED) && !!(repo && token);
  let knownIssues = [];
  let knownComments = [];

  const headers = () => ({
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json",
    "User-Agent": "gptwork-mcp/0.2"
  });

  async function api(method, path, body) {
    if (!enabled) return null;
    try {
      const url = "https://api.github.com/repos/" + repo + path;
      const opts = { method, headers: headers() };
      if (body) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
      const response = await fetch(url, opts);
      if (!response.ok) {
        const text = await response.text();
        throw new Error("GitHub API " + response.status + ": " + text.slice(0, 200));
      }
      return response.json();
    } catch (error) {
      console.error("[github-sync] API call failed:", error.message);
      return null;
    }
  }

  function taskToIssueBody(task) {
    let body = "## Task: " + task.title + "\n\n";
    if (task.description) body += task.description + "\n\n";
    body += "**Status**: " + task.status + "\n";
    body += "**Assignee**: " + (task.assignee || "unassigned") + "\n";
    body += "**Workspace**: " + task.workspace_id + "\n";
    body += "**Project**: " + task.project_id + "\n";
    body += "**Mode**: " + (task.mode || "builder") + "\n\n";
    if (task.logs && task.logs.length > 0) {
      body += "### Logs\n\n";
      for (const log of task.logs.slice(-10)) {
        body += "- " + log.time + ": " + log.message + "\n";
      }
      body += "\n";
    }
    if (task.artifacts && task.artifacts.length > 0) {
      body += "### Artifacts\n\n";
      for (const art of task.artifacts) {
        body += "- " + (art.label || art.path) + ": " + art.path + "\n";
      }
      body += "\n";
    }
    if (task.result) {
      body += "### Result\n\n";
      if (task.result.summary) body += task.result.summary + "\n\n";
      if (task.result.tests) body += "**Tests**: " + task.result.tests + "\n";
      if (task.result.commit) body += "**Commit**: `" + task.result.commit + "`\n";
      if (task.result.remote_head) body += "**Remote HEAD**: `" + task.result.remote_head + "`\n";
      if (Array.isArray(task.result.changed_files) && task.result.changed_files.length > 0) {
        body += "**Changed Files**: " + task.result.changed_files.join(", ") + "\n";
      }
      if (Array.isArray(task.result.warnings) && task.result.warnings.length > 0) {
        body += "**Warnings**:\n";
        for (const w of task.result.warnings) body += "- " + w + "\n";
      }
      body += "\n";
    }
    body += "---\n*Sync from GPTWork MCP*\n";
    body += "**Task ID**: `" + task.id + "`\n";
    return body;
  }

  function requestToIssueBody(request) {
    let body = "## ChatGPT Request: " + request.title + "\n\n";
    body += "**Prompt**: " + request.prompt + "\n\n";
    body += "**Status**: " + request.status + "\n";
    body += "**Source**: " + request.source + "\n";
    body += "**Task ID**: " + (request.task_id || "none") + "\n\n";
    if (request.response) {
      body += "### Response\n\n" + request.response + "\n\n";
    }
    body += "---\n*Sync from GPTWork MCP*\n";
    body += "**Request ID**: `" + request.id + "`\n";
    return body;
  }

function buildResultComment(task) {
  let body = "## Task " + (task.status === "completed" ? "Complete" : "Finished") + "\n\n";
  body += "**Status**: " + task.status + "\n";
  if (task.result) {
    if (task.result.summary) body += "**Summary**: " + task.result.summary + "\n\n";
    if (task.result.tests) body += "**Tests**: " + task.result.tests + "\n";
    if (task.result.commit) body += "**Commit**: `" + task.result.commit + "`\n";
    if (task.result.remote_head) body += "**Remote HEAD**: `" + task.result.remote_head + "`\n";
    if (Array.isArray(task.result.changed_files) && task.result.changed_files.length > 0) {
      body += "**Changed Files**: " + task.result.changed_files.join(", ") + "\n";
    }
    if (Array.isArray(task.result.warnings) && task.result.warnings.length > 0) {
      body += "**Warnings**:\n";
      for (const w of task.result.warnings) body += "- " + w + "\n";
    }
  }
  body += "\n---\n*Synced from GPTWork MCP*\n";
  body += "**Task ID**: `" + task.id + "`\n";
  return body;
}
  return {
    /**
     * Search GitHub API for an existing issue containing a Task ID or Request ID.
     * Used as fallback when in-memory knownIssues is empty (e.g., after restart).
     */
    async _findExistingIssue(searchBody) {
      if (!enabled) return null;
      const res = await api("GET", "/issues?state=open&per_page=100");
      if (!Array.isArray(res)) return null;
      return res.find((i) => {
        if (i.pull_request) return false;
        const labels = (i.labels || []).map((l) => typeof l === "string" ? l : l.name || "");
        if (!labels.includes("gptwork-task") && !labels.includes("gptwork-question")) return false;
        return (i.body || "").includes(searchBody);
      }) || null;
    },

    enabled,
    buildResultComment,
    async addIssueComment(issueNumber, body) {
      if (!enabled) return null;
      return api("POST", "/issues/" + issueNumber + "/comments", { body });
    },


    async syncTask(task) {
      if (!enabled) return { ok: false, reason: "github not configured" };
      const label = "task-" + task.status;
      const linkedIssueNumber = Number(task.github_issue_number);
      let existing = Number.isInteger(linkedIssueNumber) && linkedIssueNumber > 0
        ? { number: linkedIssueNumber }
        : knownIssues.find((i) =>
          i.body && i.body.includes("**Task ID**: `" + task.id + "`")
        );
      if (!existing) {
        const found = await this._findExistingIssue("**Task ID**: `" + task.id + "`");
        if (found) existing = found;
      }
      try {
        if (existing) {
          const res = await api("PATCH", "/issues/" + existing.number, {
            title: "[Task] " + task.title + " [" + task.status + "]",
            body: taskToIssueBody(task),
            state: task.status === "completed" || task.status === "cancelled" ? "closed" : "open",
            labels: ["gptwork-task", label]
          });
          if (res) {
            let comment = null;
            if (task.result && (task.status === 'completed' || task.status === 'cancelled')) {
              comment = await this.addIssueComment(res.number, buildResultComment(task));
            }
            return { ok: true, issue: res.number, updated: true, comment_posted: !!comment };
          }
        } else {
          const res = await api("POST", "/issues", {
            title: "[Task] " + task.title + " [" + task.status + "]",
            body: taskToIssueBody(task),
            labels: ["gptwork-task", label]
          });
          if (res) {
            knownIssues.push({ number: res.number, body: taskToIssueBody(task) });
            let comment = null;
            if (task.result && (task.status === 'completed' || task.status === 'cancelled')) {
              comment = await this.addIssueComment(res.number, buildResultComment(task));
            }
            return { ok: true, issue: res.number, created: true, comment_posted: !!comment };
          }
        }
        return { ok: false, reason: "api call failed" };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    async syncChatGptRequest(request) {
      if (!enabled) return { ok: false, reason: "github not configured" };
      let existing = knownIssues.find((i) =>
        i.body && i.body.includes("**Request ID**: `" + request.id + "`")
      );
      if (!existing) {
        const found = await this._findExistingIssue("**Request ID**: `" + request.id + "`");
        if (found) existing = found;
      }
      try {
        if (existing) {
          await api("PATCH", "/issues/" + existing.number, {
            title: "[Question] " + request.title + " [" + request.status + "]",
            body: requestToIssueBody(request),
            state: request.status === "answered" ? "closed" : "open",
            labels: ["gptwork-question"]
          });
          return { ok: true, issue: existing.number, updated: true };
        } else {
          const res = await api("POST", "/issues", {
            title: "[Question] " + request.title + " [" + request.status + "]",
            body: requestToIssueBody(request),
            labels: ["gptwork-question"]
          });
          if (res) {
            knownIssues.push({ number: res.number, body: requestToIssueBody(request) });
            return { ok: true, issue: res.number, created: true };
          }
        }
        return { ok: false, reason: "api call failed" };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    async pollIssues() {
      if (!enabled) return [];
      const res = await api("GET", "/issues?state=open&per_page=100");
      if (!res) return [];
      knownIssues = (Array.isArray(res) ? res : []).filter((issue) => {
        if (issue.pull_request) return false;
        const labels = (issue.labels || []).map((l) => typeof l === "string" ? l : l.name || "");
        return labels.includes("gptwork-task")
          || labels.includes("gptwork-question")
          || /^\[(?:GPTWork\s+)?(?:Task|Question)\]/i.test(issue.title || "");
      });
      knownComments = {};
      for (const issue of knownIssues) {
        knownComments[issue.number] = null;
      }
      return knownIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || "",
        labels: issue.labels.map((l) => typeof l === "string" ? l : l.name || ""),
        state: issue.state,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        html_url: issue.html_url
      }));
    },

    getKnownIssues() {
      return knownIssues;
    },

    getKnownComments() {
      return knownComments;
    },

    async pollIssueComments(issueNumber) {
      if (!enabled) return [];
      const res = await api("GET", "/issues/" + issueNumber + "/comments");
      if (!Array.isArray(res)) return [];
      return res.map((c) => ({
        id: c.id,
        body: c.body || "",
        user: c.user?.login || "unknown",
        created_at: c.created_at,
        updated_at: c.updated_at
      }));
    },

    async importResponsesFromComments(store) {
      if (!enabled) return [];
      const state = await store.load();
      const requests = state.chatgpt_requests || [];
      const imported = [];
      for (const issue of knownIssues) {
        if (!issue.body || !issue.body.includes("**Request ID**:")) continue;
        const idMatch = issue.body.match(/\*\*Request ID\*\*:\s*`(chatreq_[a-f0-9-]+)`/);
        if (!idMatch) continue;
        const reqId = idMatch[1];
        const request = requests.find((r) => r.id === reqId);
        if (!request || request.status === "answered") continue;
        const comments = await this.pollIssueComments(issue.number);
        const lastComment = comments[comments.length - 1];
        if (lastComment && lastComment.body && !lastComment.body.includes("Sync from GPTWork MCP")) {
          request.status = "answered";
          request.response = lastComment.body;
          request.answered_at = new Date().toISOString();
          request.answered_by = "github-comment:" + lastComment.user;
          request.github_comment_id = lastComment.id;
          state.activities.push({ time: request.answered_at, type: "chatgpt_request.answered_via_github", request_id: reqId, comment_user: lastComment.user });
          imported.push({ request_id: reqId, response: lastComment.body, user: lastComment.user });
        }
      }
      if (imported.length > 0) await store.save();
      return imported;
    },

    async syncAllTasks(tasks) {
      const results = [];
      for (const task of tasks) {
        const result = await this.syncTask(task);
        results.push({ task_id: task.id, ...result });
      }
      return results;
    },

    async syncAllRequests(requests) {
      const results = [];
      for (const request of requests) {
        const result = await this.syncChatGptRequest(request);
        results.push({ request_id: request.id, ...result });
      }
      return results;
    },

    async importFromIssues(store, { limit = 100, assignToCodex = false } = {}) {
      if (!enabled) return [];
      const issues = await this.pollIssues();
      const imported = [];
      const state = await store.load();
      const maxIssues = Math.max(1, Math.min(Number(limit) || 100, 100));
      for (const issue of issues) {
        if (imported.length >= maxIssues) break;
        if (issue.labels.includes("gptwork-question")) continue;
        const idMatch = issue.body.match(/\*\*Task ID\*\*:\s*`(task_[a-f0-9-]+)`/);
        if (idMatch && state.tasks.find((t) => t.id === idMatch[1])) continue;
        if (state.tasks.find((t) => t.github_issue_number === issue.number || t.github_issue_url === issue.html_url)) continue;
        const titleMatch = issue.title.match(/^\[Task\]\s+(.+?)\s+\[(.+?)\]$/);
        const taskTitle = titleMatch ? titleMatch[1] : issue.title;
        const taskStatus = titleMatch ? titleMatch[2] : "queued";
        const now = new Date().toISOString();
        const task = {
          id: "task_" + randomUUID(),
          project_id: "default",
          workspace_id: "hosted-default",
          title: taskTitle,
          description: issue.body || "",
          created_by: "github-import",
          assignee: assignToCodex ? "codex" : "",
          status: taskStatus,
          mode: "builder",
          github_issue_number: issue.number,
          github_issue_url: issue.html_url || null,
          logs: [{ time: now, message: "Imported from GitHub issue #" + issue.number }],
          artifacts: [],
          result: null,
          created_at: now,
          updated_at: now
        };
        state.tasks.push(task);
        state.activities.push({ time: now, type: "task.imported", task_id: task.id, source: "github", issue: issue.number });
        imported.push(task);
      }
      if (imported.length > 0) await store.save();
      return imported;
    },

    /**
     * Return a comprehensive GitHub connectivity status object.
     * Distinguishes API sync not configured from git/SSH/gh available.
     */
    status() {
      // Use the already-resolved config/repo/token/enabled for consistency
      return {
        api_sync_enabled: enabled,
        api_repo: repo || null,
        api_token_set: !!token,
        detected_repo_from_workspace: null,
        detected_remote_url: null,
        direct_git_available: null,
        ssh_auth_likely_available: null,
        gh_cli_available: null,
        last_delivery_channel: null
      };
    }
  };
}


/**
 * Check whether git is installed on this system.
 */
function checkDirectGitAvailable(cwd) {
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
function checkSshAuthAvailable() {
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
function checkGhCliAvailable() {
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
function detectWorkspaceRepo(path) {
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
async function grabIssue(issueNumber, repoFull) {
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
function getStatusWithAsyncChecks(cwd) {
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
function syncToGitHubResult(task, existingDelivery) {
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

export { checkDirectGitAvailable, checkSshAuthAvailable, checkGhCliAvailable, detectWorkspaceRepo, grabIssue, getStatusWithAsyncChecks, syncToGitHubResult };
