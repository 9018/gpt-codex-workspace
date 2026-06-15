import { randomUUID } from "node:crypto";

export function createGithubSync(config) {
  const repo = process.env.GPTWORK_GITHUB_REPO || "";
  const token = process.env.GPTWORK_GITHUB_TOKEN || "";
  const enabled = !!(repo && token);
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

  return {
    enabled,

    async syncTask(task) {
      if (!enabled) return { ok: false, reason: "github not configured" };
      const label = "task-" + task.status;
      const existing = knownIssues.find((i) =>
        i.body && i.body.includes("**Task ID**: `" + task.id + "`")
      );
      try {
        if (existing) {
          const res = await api("PATCH", "/issues/" + existing.number, {
            title: "[Task] " + task.title + " [" + task.status + "]",
            body: taskToIssueBody(task),
            state: task.status === "completed" || task.status === "cancelled" ? "closed" : "open",
            labels: ["gptwork-task", label]
          });
          if (res) return { ok: true, issue: res.number, updated: true };
        } else {
          const res = await api("POST", "/issues", {
            title: "[Task] " + task.title + " [" + task.status + "]",
            body: taskToIssueBody(task),
            labels: ["gptwork-task", label]
          });
          if (res) {
            knownIssues.push({ number: res.number, body: taskToIssueBody(task) });
            return { ok: true, issue: res.number, created: true };
          }
        }
        return { ok: false, reason: "api call failed" };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    async syncChatGptRequest(request) {
      if (!enabled) return { ok: false, reason: "github not configured" };
      const existing = knownIssues.find((i) =>
        i.body && i.body.includes("**Request ID**: `" + request.id + "`")
      );
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
      const res = await api("GET", "/issues?labels=gptwork-task,gptwork-question&state=open&per_page=50");
      if (!res) return [];
      knownIssues = Array.isArray(res) ? res : [];
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

    async importFromIssues(store) {
      if (!enabled) return [];
      const issues = await this.pollIssues();
      const imported = [];
      const state = await store.load();
      for (const issue of issues) {
        if (issue.labels.includes("gptwork-question")) continue;
        const idMatch = issue.body.match(/\*\*Task ID\*\*:\s*`(task_[a-f0-9-]+)`/);
        if (idMatch && state.tasks.find((t) => t.id === idMatch[1])) continue;
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
          assignee: "",
          status: taskStatus,
          mode: "builder",
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
    }
  };
}
