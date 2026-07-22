import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { _isTruthy } from "./github-adapter-utils.mjs";
import { buildResultComment, requestToIssueBody, taskToIssueBody } from "./github-issue-formatters.mjs";

// ---------------------------------------------------------------------------
// Module-level helpers for task-intake marker detection
// ---------------------------------------------------------------------------

function _parseFrontmatter(body) {
  if (!body || typeof body !== "string") return null;
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("---\n")) return null;
  const endIdx = trimmed.indexOf("\n---", 4);
  if (endIdx === -1) return null;
  const fm = trimmed.slice(4, endIdx);
  const result = {};
  for (const line of fm.split("\n")) {
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const key = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function _extractJsonBlock(body) {
  if (!body || typeof body !== "string") return null;
  const start = body.indexOf("{");
  if (start === -1) return null;
  const end = body.lastIndexOf("}");
  if (end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); }
  catch { return null; }
}

function _hasTaskIntakeMarker(issue) {
  const labels = issue.labels || [];
  if (labels.includes("gptwork-task") || labels.includes("codex-task")) return true;
  const body = issue.body || "";
  const fm = _parseFrontmatter(body);
  if (fm && fm.gptwork_intake === "task") return true;
  const jb = _extractJsonBlock(body);
  if (jb && jb.gptwork_intake === "task") return true;
  return false;
}

export function _satisfiesRequestTaskIntakeCondition(request) {
  if (!request) return false;
  if (request.escalation && request.escalation.category === "task_intake") return true;
  const text = (request.title || "") + " " + (request.prompt || "");
  return text.includes("gptwork_intake: task");
}

function _extractTaskIntakeMetadata(issue) {
  const body = issue.body || "";
  const fm = _parseFrontmatter(body);
  if (fm) return { workspace_id: fm.workspace_id || undefined, mode: fm.mode || undefined, assignee: fm.assign_to || undefined };
  const jb = _extractJsonBlock(body);
  if (jb) return { workspace_id: jb.workspace_id || undefined, mode: jb.mode || undefined, assignee: jb.assign_to || undefined };
  return {};
}

async function _moveFile(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
}

export function createGithubSync(config) {
  const workspaceRoot = config.defaultWorkspaceRoot || process.env.GPTWORK_WORKSPACE_ROOT || ".";
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
  // P1.3: Track sync diagnostic data for github_status visibility
  let _lastSyncDiagnostics = {
    last_sync_at: null,
    last_sync_ok: null,
    last_sync_error: null,
    last_raw_api_issue_count: 0,
    last_imported_tasks: 0,
    last_imported_responses: 0,
    last_scanned_issue_count: 0,
    skipped_reasons: [],
  };

  function _resetSyncDiagnostics() {
    _lastSyncDiagnostics = {
      last_sync_at: new Date().toISOString(),
      last_sync_ok: true,
      last_sync_error: null,
      last_raw_api_issue_count: 0,
      last_imported_tasks: 0,
      last_imported_responses: 0,
      last_scanned_issue_count: 0,
      skipped_reasons: [],
    };
  }

  function _recordSkip(reason, details) {
    _lastSyncDiagnostics.skipped_reasons.push({ reason, details: details || null, time: new Date().toISOString() });
  }

  function _recordError(error) {
    _lastSyncDiagnostics.last_sync_ok = false;
    _lastSyncDiagnostics.last_sync_error = typeof error === "string" ? error.slice(0, 200) : (error && error.message ? error.message.slice(0, 200) : String(error).slice(0, 200));
  }



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
      _recordError(error.message);
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

      // Also search by source_request_id if present (e.g. tasks created from request conversion)
      if (!existing && task.source_request_id) {
        existing = knownIssues.find((i) =>
          i.body && i.body.includes("**Request ID**: `" + task.source_request_id + "`")
        );
        if (!existing) {
          const found = await this._findExistingIssue("**Request ID**: `" + task.source_request_id + "`");
          if (found) existing = found;
        }
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
      const isTaskIntake = _satisfiesRequestTaskIntakeCondition(request);
      const labels = isTaskIntake ? ["gptwork-task"] : ["gptwork-question"];
      const prefix = isTaskIntake ? "Task" : "Question";
      let body = requestToIssueBody(request);
      if (isTaskIntake) {
        body = "---\ngptwork_intake: task\nassign_to: codex\nmode: builder\n---\n\n" + body;
      }
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
            title: "[" + prefix + "] " + request.title + " [" + request.status + "]",
            body: body,
            state: request.status === "answered" ? "closed" : "open",
            labels: labels
          });
          return { ok: true, issue: existing.number, updated: true };
        } else {
          const res = await api("POST", "/issues", {
            title: "[" + prefix + "] " + request.title + " [" + request.status + "]",
            body: body,
            labels: labels
          });
          if (res) {
            knownIssues.push({ number: res.number, body: body });
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
      const raw = Array.isArray(res) ? res : [];
      _lastSyncDiagnostics.last_raw_api_issue_count = raw.length;
      const filtered = [];
      for (const issue of raw) {
        if (issue.pull_request) continue;
        const labels = (issue.labels || []).map((l) => typeof l === "string" ? l : l.name || "");
        if (labels.includes("gptwork-task") || labels.includes("gptwork-question") || /^\[(?:GPTWork\s+)?(?:Task|Question)\]/i.test(issue.title || "")) {
          filtered.push(issue);
        }
      }
      knownIssues = filtered;
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

    getSyncDiagnostics() {
      return { ..._lastSyncDiagnostics };
    },

    getKnownComments() {
      return knownComments;
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
        const idMatch = issue.body.match(/\*\*Request ID\*\*:\s*`(chatreq_[\w-]+)`/);
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
      _lastSyncDiagnostics.last_imported_responses = imported.length;
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

    async importFromIssues(store, { limit = 100, assignToCodex = false, dryRun = false } = {}) {
      if (!enabled) return [];
      _resetSyncDiagnostics();
      if (dryRun) { _lastSyncDiagnostics._dry_run_mode = true; }
      const issues = await this.pollIssues();
      _lastSyncDiagnostics.last_scanned_issue_count = issues ? issues.length : 0;
      if (!issues || issues.length === 0) {
        _recordSkip("no_open_issues", "raw API returned " + (_lastSyncDiagnostics.last_raw_api_issue_count ?? 0) + " issues, 0 passed label/title check");
        return [];
      }
      const imported = [];
      const state = await store.load();
      const existingTasks = state.tasks || [];
      const existingTaskIds = new Set(existingTasks.map((task) => task.id));
      const deletedTaskIds = new Set(Array.isArray(state.deleted_task_ids) ? state.deleted_task_ids : []);
      const deletedGithubIssues = new Set(
        (Array.isArray(state.deleted_github_issues) ? state.deleted_github_issues : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const existingGithubIssueNumbers = new Set(existingTasks.map((task) => task.github_issue_number).filter((value) => Number.isFinite(value) && value > 0));
      const existingGithubIssueUrls = new Set(existingTasks.map((task) => task.github_issue_url).filter(Boolean));
      const maxIssues = Math.max(1, Math.min(Number(limit) || 100, 100));
      for (const issue of issues) {
        if (imported.length >= maxIssues) break;
        if (issue.labels.includes("gptwork-question") && !_hasTaskIntakeMarker(issue)) { _recordSkip("question_label_without_task_intake", "issue #" + issue.number); continue; }
        if (issue.labels.includes("gptwork-question") && _hasTaskIntakeMarker(issue)) { _recordSkip("question_label_with_task_intake_imported", "issue #" + issue.number + " has task-intake marker"); }
        const idMatch = issue.body.match(/\*\*Task ID\*\*:\s*`(task_[a-f0-9-]+)`/);
        if (idMatch && existingTaskIds.has(idMatch[1])) { _recordSkip("already_imported", "issue #" + issue.number + " task " + idMatch[1]); continue; }
        if (idMatch && deletedTaskIds.has(idMatch[1])) { _recordSkip("deleted_task_tombstone", "issue #" + issue.number + " task " + idMatch[1]); continue; }
        if (deletedGithubIssues.has(issue.number)) { _recordSkip("deleted_github_issue_tombstone", "issue #" + issue.number); continue; }
        const reqIdMatch = issue.body.match(/\*\*Request ID\*\*:\s*`(chatreq_[\w-]+)`/);
        if (reqIdMatch && existingTasks.some(t => t.source_request_id === reqIdMatch[1])) { _recordSkip("duplicate_by_request_id", "issue #" + issue.number + " request " + reqIdMatch[1]); continue; }
        if (existingGithubIssueNumbers.has(issue.number) || existingGithubIssueUrls.has(issue.html_url)) { _recordSkip("duplicate_issue_number", "issue #" + issue.number); continue; }
        const titleMatch = issue.title.match(/^\[(?:GPTWork\s+)?Task\]\s+(.+?)\s+\[(.+?)\]$/);
        const taskTitle = titleMatch ? titleMatch[1] : issue.title;
        const taskStatus = titleMatch ? titleMatch[2] : "queued";
        const now = new Date().toISOString();
        const intakeMeta = _extractTaskIntakeMetadata(issue);
        const historicalImport = Boolean(idMatch);
        const task = {
          id: idMatch ? idMatch[1] : "task_" + randomUUID(),
          project_id: "default",
          workspace_id: intakeMeta.workspace_id || "hosted-default",
          title: taskTitle,
          description: issue.body || "",
          created_by: "github-import",
          source: "github-import",
          historical_import: historicalImport,
          auto_advance: historicalImport ? false : true,
          assignee: historicalImport ? "" : (intakeMeta.assignee || (assignToCodex ? "codex" : "")),
          status: taskStatus,
          mode: intakeMeta.mode || "full",
          github_issue_number: issue.number,
          github_issue_url: issue.html_url || null,
          logs: [{ time: now, message: "Imported from GitHub issue #" + issue.number }],
          artifacts: [],
          result: null,
          created_at: issue.created_at || now,
          updated_at: issue.updated_at || issue.created_at || now
        };
        if (!dryRun) {
          state.tasks.push(task);
          existingTaskIds.add(task.id);
          existingGithubIssueNumbers.add(issue.number);
          existingGithubIssueUrls.add(issue.html_url);
          state.activities.push({ time: now, type: "task.imported", task_id: task.id, source: "github", issue: issue.number });
        }
        imported.push(task);
      }
      _lastSyncDiagnostics.last_imported_tasks = imported.length;
      if (imported.length > 0 && !dryRun) await store.save();
      return imported;
    },

    /**
     * Import task handoff files from .gptwork/inbox/*.json.
     * Only kind === "gptwork_task_handoff" with valid fields are imported.
     * Idempotent: same idempotency_key only creates one task.
     * Returns { imported: [], skipped: [], failed: [] }.
     */
    async importInboxHandoffs(store, { dryRun = false } = {}) {
      const inboxDir = join(workspaceRoot, ".gptwork", "inbox");
      let files;
      try {
        const entries = await readdir(inboxDir);
        files = entries.filter(f => f.endsWith(".json"));
      } catch (err) {
        if (err.code === "ENOENT") return { imported: [], skipped: [], failed: [] };
        return { imported: [], skipped: [], failed: [{ file: "_dir_error", reason: err.message }] };
      }
      const state = await store.load();
      const existingKeys = new Set(
        (state.tasks || [])
          .filter(t => t.idempotency_key)
          .map(t => t.idempotency_key)
      );
      const procDir = join(inboxDir, "processed");
      const failDir = join(inboxDir, "failed");
      const results = { imported: [], skipped: [], failed: [] };
      for (const file of files) {
        const filePath = join(inboxDir, file);
        let payload;
        try {
          const content = await readFile(filePath, "utf8");
          payload = JSON.parse(content);
        } catch (err) {
          results.failed.push({ file, reason: "parse_error: " + err.message });
          if (!dryRun) await _moveFile(filePath, join(failDir, file));
          continue;
        }
        if (payload.kind !== "gptwork_task_handoff") {
          results.skipped.push({ file, reason: "invalid_kind: " + (payload.kind || "missing") });
          if (!dryRun) await _moveFile(filePath, join(failDir, file));
          continue;
        }
        const required = ["title", "description", "assignee", "workspace_id", "mode", "idempotency_key"];
        const missing = required.filter(k => !payload[k]);
        if (missing.length > 0) {
          results.failed.push({ file, reason: "missing_fields: " + missing.join(", ") });
          if (!dryRun) await _moveFile(filePath, join(failDir, file));
          continue;
        }
        if (existingKeys.has(payload.idempotency_key)) {
          results.skipped.push({ file, reason: "duplicate_idempotency_key" });
          if (!dryRun) await _moveFile(filePath, join(procDir, file));
          continue;
        }
        if (dryRun) {
          results.imported.push({ file, title: payload.title, idempotency_key: payload.idempotency_key });
          continue;
        }
        const now = new Date().toISOString();
        const task = {
          id: "task_" + randomUUID(),
          project_id: payload.project_id || "default",
          workspace_id: payload.workspace_id,
          title: payload.title,
          description: payload.description || "",
          created_by: "inbox-handoff",
          assignee: payload.assignee,
          status: "queued",
          mode: payload.mode,
          idempotency_key: payload.idempotency_key,
          logs: [{ time: now, message: "Imported from inbox handoff: " + file }],
          artifacts: [],
          result: null,
          created_at: now,
          updated_at: now
        };
        state.tasks.push(task);
        state.activities.push({ time: now, type: "task.imported", task_id: task.id, source: "inbox", file: file });
        existingKeys.add(payload.idempotency_key);
        results.imported.push({ file, task_id: task.id, title: payload.title });
        await _moveFile(filePath, join(procDir, file));
      }
      _lastSyncDiagnostics.last_inbox_imported = results.imported.length;
      _lastSyncDiagnostics.last_inbox_failed = results.failed.length;
      if (results.imported.length > 0) await store.save();
      return results;
    },

    /**
     * Convert a ChatGPT request to a Codex task when it has a task_intake marker.
     * Markers: escalation.category === "task_intake" or body contains "gptwork_intake: task".
     * Idempotent: same request_id only creates one task (stored in task.source_request_id).
     * Returns { converted: true/false, task_id?, reason? }.
     */
    async convertChatGptRequestToTask(store, requestId, { dryRun = false } = {}) {
      const state = await store.load();
      const requests = state.chatgpt_requests || [];
      const request = requests.find(r => r.id === requestId);
      if (!request) return { converted: false, reason: "request_not_found" };
      const existingTask = (state.tasks || []).find(t => t.source_request_id === requestId);
      if (existingTask) return { converted: false, reason: "already_converted", task_id: existingTask.id };
      if (request.status !== "open") return { converted: false, reason: "request_not_open: " + request.status };
      if (!_satisfiesRequestTaskIntakeCondition(request)) return { converted: false, reason: "no_task_intake_marker" };
      if (dryRun) return { convertible: true, request_id: requestId, title: request.title };
      const now = new Date().toISOString();
      const task = {
        id: "task_" + randomUUID(),
        project_id: request.project_id || "default",
        workspace_id: request.workspace_id || "hosted-default",
        title: request.title,
        description: request.prompt || "",
        created_by: "chatgpt-request-convert",
        source_request_id: requestId,
        assignee: "codex",
        status: "queued",
        mode: "full",
        logs: [{ time: now, message: "Created from ChatGPT request conversion: " + requestId }],
        artifacts: [],
        result: null,
        created_at: now,
        updated_at: now
      };
      state.tasks.push(task);
      request.status = "converted";
      request.converted_at = now;
      request.created_task_id = task.id;
      state.activities.push({ time: now, type: "task.created_from_request", task_id: task.id, request_id: requestId });
      await store.save();
      return { converted: true, task_id: task.id, title: task.title };
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
        workspace_root: workspaceRoot,
        inbox_dir: join(workspaceRoot, ".gptwork", "inbox"),
        detected_repo_from_workspace: null,
        detected_remote_url: null,
        direct_git_available: null,
        ssh_auth_likely_available: null,
        gh_cli_available: null,
        last_delivery_channel: null,
        last_inbox_imported: _lastSyncDiagnostics.last_inbox_imported || 0,
        last_inbox_failed: _lastSyncDiagnostics.last_inbox_failed || 0
      };
    }
  };
}


/**
 * Check whether git is installed on this system.
 */
