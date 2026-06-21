import { randomUUID } from "node:crypto";
import { _isTruthy } from "./github-adapter-utils.mjs";
import { buildResultComment, requestToIssueBody, taskToIssueBody } from "./github-issue-formatters.mjs";

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
  let _knownIssueMappings = {};
  // P1.3: Track posted terminal result comments for idempotence
  const _postedResultComments = new Map();

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

/**
 * Check whether a terminal result comment should be posted (idempotence).
 * Same task + status + commit/remote_head should not re-post.
 */
function shouldPostResultComment(task) {
  if (!task.result) return false;
  const commit = task.result.commit || "";
  const remoteHead = task.result.remote_head || "";
  const key = task.id + ":" + task.status + ":" + commit + ":" + remoteHead;
  if (_postedResultComments.has(key)) return false;
  _postedResultComments.set(key, Date.now());
  return true;
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
            if (task.result && (task.status === 'completed' || task.status === 'cancelled') && shouldPostResultComment(task)) {
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
            if (task.result && (task.status === 'completed' || task.status === 'cancelled') && shouldPostResultComment(task)) {
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
      const concurrency = 5;
      let nextIndex = 0;
      const workerFn = async () => {
        while (nextIndex < tasks.length) {
          const idx = nextIndex++;
          const task = tasks[idx];
          const result = await this.syncTask(task);
          results[idx] = { task_id: task.id, ...result };
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => workerFn()));
      return results.filter(Boolean);
    },

    async syncAllRequests(requests) {
      const results = [];
      const concurrency = 5;
      let nextIndex = 0;
      const workerFn = async () => {
        while (nextIndex < requests.length) {
          const idx = nextIndex++;
          const request = requests[idx];
          const result = await this.syncChatGptRequest(request);
          results[idx] = { request_id: request.id, ...result };
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => workerFn()));
      return results.filter(Boolean);
    },

    async importFromIssues(store, { limit = 100, assignToCodex = false } = {}) {
      if (!enabled) return [];
      const issues = await this.pollIssues();
      const imported = [];
      const state = await store.load();
      const existingTasks = state.tasks || [];
      const existingTaskIds = new Set(existingTasks.map((task) => task.id));
      const existingGithubIssueNumbers = new Set(existingTasks.map((task) => task.github_issue_number).filter((value) => value !== undefined && value !== null));
      const existingGithubIssueUrls = new Set(existingTasks.map((task) => task.github_issue_url).filter(Boolean));
      const maxIssues = Math.max(1, Math.min(Number(limit) || 100, 100));
      for (const issue of issues) {
        if (imported.length >= maxIssues) break;
        if (issue.labels.includes("gptwork-question")) continue;
        const idMatch = issue.body.match(/\*\*Task ID\*\*:\s*`(task_[a-f0-9-]+)`/);
        if (idMatch && existingTaskIds.has(idMatch[1])) continue;
        if (existingGithubIssueNumbers.has(issue.number) || existingGithubIssueUrls.has(issue.html_url)) continue;
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
        existingTaskIds.add(task.id);
        existingGithubIssueNumbers.add(issue.number);
        existingGithubIssueUrls.add(issue.html_url);
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
