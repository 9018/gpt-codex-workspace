import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { exec, execSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { StateStore } from "./state-store.mjs";
import { ensureParent, resolveWorkspacePath } from "./path-utils.mjs";
import { createBrowserRegistry } from "./browser-http.mjs";
import { buildSshExecCommand, runSshExec, sshListDir, sshReadTextFile, sshDownloadBase64, sshWriteTextFile, sshUploadBase64, sshMkdir, sshDelete, sshMove, sshCopy, sshSha256, sshStat, sshSearchFiles } from "./ssh-adapter.mjs";
import { createGithubSync } from "./github-adapter.mjs";

const MCP_PROTOCOL_VERSION = "2025-03-26";

export async function createGptWorkServer(options = {}) {
  const tokenContexts = normalizeTokenContexts(
    options.tokenContexts || parseTokenContexts(process.env.GPTWORK_TOKEN_CONTEXTS || ""),
    options.tokens || parseTokens(process.env.GPTWORK_TOKENS || process.env.GPTWORK_API_TOKEN || "dev-token,test")
  );
  const config = {
    statePath: options.statePath || process.env.GPTWORK_STATE_PATH || "./data/state.json",
    defaultWorkspaceRoot: options.defaultWorkspaceRoot || process.env.GPTWORK_WORKSPACE_ROOT || "./data/workspaces/default",
    tokens: Object.keys(tokenContexts),
    tokenContexts,
    requireAuth: options.requireAuth ?? process.env.GPTWORK_REQUIRE_AUTH !== "false",
    codexHome: options.codexHome || process.env.GPTWORK_CODEX_HOME || "/home/a9017",
    codexExecArgs: options.codexExecArgs || process.env.GPTWORK_CODEX_EXEC_ARGS || "--yolo --skip-git-repo-check",
    pythonCommand: options.pythonCommand || process.env.GPTWORK_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    maxReadBytes: Number(process.env.GPTWORK_MAX_READ_BYTES || 200000),
    maxShellOutputBytes: Number(process.env.GPTWORK_MAX_SHELL_OUTPUT_BYTES || 200000),
    shellTimeout: Number(process.env.GPTWORK_SHELL_TIMEOUT || 60)
  };
  const store = new StateStore(config);
  await store.load();
  const browser = createBrowserRegistry();
  const github = createGithubSync(config);
  const tools = createTools({ store, config, browser, github });

  return {
    async runAssignedCodexTasks(args = {}, context = defaultTokenContext("worker")) {
      return runAssignedCodexTasks(store, config, github, args, context);
    },

    async handleRpc(message, headers = {}, emitProgress = () => {}) {
      try {
        if (!message || message.jsonrpc !== "2.0") return jsonError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
        if (message.method === "initialize") return jsonResult(message.id, initializeResult());
        if (message.method === "notifications/initialized") return null;
        if (message.method === "tools/list") {
          assertAuthorized(headers, config);
          return jsonResult(message.id, { tools: toolList(tools) });
        }
        if (message.method === "tools/call") {
          const context = { ...assertAuthorized(headers, config), emitProgress };
          const name = message.params?.name;
          const args = message.params?.arguments || {};
          const handler = tools[name]?.handler;
          if (!handler) return jsonError(message.id, -32601, `Unknown tool: ${name}`);
          const structuredContent = await handler(args, context);
          return jsonResult(message.id, {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
            isError: false
          });
        }
        return jsonError(message.id, -32601, `Unknown method: ${message.method}`);
      } catch (error) {
        return jsonError(message?.id ?? null, error.code || -32000, error.message);
      }
    },

    async listen({ host = "127.0.0.1", port = 8787 } = {}) {
      const httpServer = http.createServer((req, res) => handleHttp(req, res, this));
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(port, host, () => {
              httpServer.removeListener("error", reject);
              resolve();
            });
          });
          return httpServer;
        } catch (err) {
          if (err.code !== "EADDRINUSE") throw err;
          try { execSync("lsof -ti :" + port + " 2>/dev/null | xargs kill -9 2>/dev/null"); } catch {}
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      throw new Error("Could not listen on port " + port + " after 5 retries");
    }
  };
}

export function startCodexWorker(server, {
  intervalMs = Number(process.env.GPTWORK_CODEX_WORKER_INTERVAL_MS || 5000),
  limit = Number(process.env.GPTWORK_CODEX_WORKER_LIMIT || 10),
  concurrency = Number(process.env.GPTWORK_CODEX_WORKER_CONCURRENCY || 4)
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const wr = await server.runAssignedCodexTasks({ limit, concurrency });
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) {
        const done = wr.tasks.filter(t => t.status === "completed").length;
        const skip = wr.tasks.filter(t => t.skipped).length;
        appendFileSync(_lp, `[gptwork-worker] tick inspected=${wr.inspected} completed=${done} skipped=${skip}\n`);
      }}
    } catch (error) {
      { const _lp = process.env.GPTWORK_LOG_PATH; if (_lp) appendFileSync(_lp, `[gptwork-worker] ${error.message}\n`); }
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

function createTools({ store, config, browser, github }) {
  const tool = (description, inputSchema, handler) => ({ description, inputSchema, handler });
  return {
    health_check: tool("Check whether the GPTWork MCP server is running.", schema({}), async () => ({ ok: true, service: "gptwork-mcp", time: new Date().toISOString() })),
    get_current_user: tool("Return the current token-bound user context.", schema({}), async (_args, context) => ({
      user: { id: context.user_id, name: context.user_name },
      team_id: context.team_id,
      project_ids: context.project_ids,
      workspace_ids: context.workspace_ids,
      scopes: context.scopes
    })),
    list_projects: tool("List your available projects. Each project has workspaces (hosted or SSH) and tasks. Start here to find which project to work on.", schema({}), async (_args, context) => {
      const state = await store.load();
      return { projects: state.projects.filter((project) => canAccessProject(context, project.id)) };
    }),
    get_project: tool("Return project detail.", schema({ project_id: "string" }, ["project_id"]), async ({ project_id = "default" }, context) => {
      const state = await store.load();
      requireProjectAccess(context, project_id);
      return { project: findProject(state, project_id) };
    }),
    list_workspaces: tool("List project workspaces.", schema({ project_id: "string" }), async ({ project_id = "default" }, context) => {
      const state = await store.load();
      requireProjectAccess(context, project_id);
      return {
        project_id,
        workspaces: state.workspaces.filter((workspace) => workspace.project_id === project_id && canAccessWorkspace(context, workspace.id))
      };
    }),
    get_workspace_info: tool("Return workspace configuration and capacity summary.", schema({ workspace_id: "string" }), async (args, context) => {
      const workspace = await selectWorkspace(store, args.workspace_id, context);
      if (workspace.type === "hosted") await mkdir(workspace.root, { recursive: true });
      return { workspace, limits: limits(config) };
    }),
    set_active_workspace: tool("Return the selected workspace for caller-side state.", schema({ workspace_id: "string" }, ["workspace_id"]), async ({ workspace_id }, context) => ({ active_workspace: await selectWorkspace(store, workspace_id, context) })),
    create_workspace: tool("Create a hosted or SSH workspace for a project. SSH workspaces use key authentication first; pass identity_file to pin a key. Hosts outside 10.0.0.0/8 use the default SOCKS proxy 10.0.1.105:20177 unless socks_proxy is provided.", schema({ project_id: "string", id: "string", name: "string", type: "string", root: "string", host: "string", user: "string", port: "integer", identity_file: "string", socks_proxy: "string", default: "boolean" }, ["project_id", "name", "type", "root"]), async (args, context) => createWorkspace(store, config, args, context)),
    update_workspace: tool("Update workspace metadata or SSH connection settings, including identity_file and socks_proxy.", schema({ workspace_id: "string", name: "string", root: "string", host: "string", user: "string", port: "integer", identity_file: "string", socks_proxy: "string", default: "boolean" }, ["workspace_id"]), async (args, context) => updateWorkspace(store, args, context)),
    delete_workspace: tool("移除工作区注册信息。不影响远程文件。", schema({ workspace_id: "string" }, ["workspace_id"]), async (args, context) => deleteWorkspace(store, args, context)),
    test_workspace_connection: tool("Test hosted or SSH workspace connectivity.", schema({ workspace_id: "string", dry_run: "boolean" }, ["workspace_id"]), async (args, context) => testWorkspaceConnection(store, config, args, context)),
    list_recent_activity: tool("List recent project activity.", schema({ limit: "integer" }), async ({ limit = 50 }) => {
      const state = await store.load();
      return { activities: state.activities.slice(-limit).reverse() };
    }),

    create_goal: tool("Create a shared goal from a ChatGPT-written goal prompt. Use this when ChatGPT turns the user's request into a Codex-executable goal. Stores the raw request, goal prompt, conversation messages, durable memories, workspace-visible context files, and optionally creates an assigned Codex task linked to the same context.", schema({ user_request: "string", goal_prompt: "string", context_summary: "string", project_id: "string", workspace_id: "string", mode: "string", assign_to_codex: "boolean", title: "string", messages: "array", memories: "array", payload: "object", payload_base64: "string", preview_text: "string", bundles: "array" }, ["user_request", "goal_prompt"]), async (args, context) => createGoal(store, config, args, context)),
    create_encoded_goal: tool("Create a shared Codex goal from a GPTChat preview plus base64-encoded JSON payload. The server decodes the payload, stores readable goal/context/transcript files, and assigns Codex when requested.", schema({ preview_text: "string", payload_base64: "string", assign_to_codex: "boolean" }, ["preview_text", "payload_base64"]), async (args, context) => createEncodedGoal(store, config, args, context)),
    list_goals: tool("List shared GPTWork goals for ChatGPT and Codex. Codex should use this to discover assigned or open goal prompts before starting work.", schema({ status: "string", assignee: "string", workspace_id: "string", limit: "integer" }), async (args, context) => listGoals(store, args, context)),
    get_goal_context: tool("Return the full shared goal context: goal prompt, raw user request, conversation messages, durable memories, linked Codex task, and workspace-visible context files. Codex should call this before acting on a goal or linked task.", schema({ goal_id: "string", task_id: "string" }, []), async (args, context) => getGoalContext(store, config, args, context)),
    append_goal_message: tool("Append a ChatGPT, user, or Codex message to a shared goal conversation and optionally store a memory item for future Codex context. Also updates the workspace transcript/context files.", schema({ goal_id: "string", task_id: "string", role: "string", content: "string", memory_key: "string", memory_value: "string" }, ["content"]), async (args, context) => appendGoalMessage(store, config, args, context)),

    create_task: tool("Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.", schema({ title: "string", description: "string", assignee: "string", workspace_id: "string", mode: "string" }, ["title"]), async (args, context) => {
      const result = await createTask(store, config, args, context);
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    list_tasks: tool("List project tasks, optionally filtered. Check what Codex is working on and what tasks are waiting or completed.", schema({ status: "string", assignee: "string", limit: "integer" }), async ({ status, assignee, limit = 50 }) => {
      const state = await store.load();
      await normalizeLegacyModes(store, state);
      let tasks = state.tasks;
      if (status) tasks = tasks.filter((task) => task.status === status);
      if (assignee) tasks = tasks.filter((task) => task.assignee === assignee);
      return { tasks: tasks.slice(-limit).reverse() };
    }),
    get_task: tool("Return a task.", schema({ task_id: "string" }, ["task_id"]), async ({ task_id }) => ({ task: await findTask(store, task_id) })),
    update_task_status: tool("Update a task status. Syncs to GitHub if configured.", schema({ task_id: "string", status: "string" }, ["task_id", "status"]), async ({ task_id, status }) => {
      const result = await updateTask(store, task_id, (task) => { task.status = status; });
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    append_task_log: tool("Append a task log entry.", schema({ task_id: "string", message: "string" }, ["task_id", "message"]), async ({ task_id, message }) => updateTask(store, task_id, (task) => { task.logs.push({ time: new Date().toISOString(), message }); })),
    attach_task_artifact: tool("Attach a task artifact reference.", schema({ task_id: "string", path: "string", label: "string" }, ["task_id", "path"]), async ({ task_id, path, label }) => updateTask(store, task_id, (task) => { task.artifacts.push({ path, label: label || basename(path), time: new Date().toISOString() }); })),
    assign_task_to_codex: tool("Assign a task to Codex for execution. Ordinary tasks run in builder mode so Codex may edit files and perform implementation or deployment steps according to the task. The server ignores readonly for ordinary tasks; only the dedicated safe Codex session inventory task can remain readonly. Pass mode=deploy for Docker/service deployment or mode=admin for privileged maintenance.", schema({ task_id: "string", mode: "string" }, ["task_id"]), async ({ task_id, mode }, context) => {
      const result = await updateTask(store, task_id, (task) => {
        task.assignee = "codex";
        task.status = "assigned";
        task.mode = normalizeAssignedTaskMode(task, mode);
      });
      const linked = await ensureTaskGoal(store, config, result.task.id, context, { assign_to_codex: true });
      github.syncTask(result.task).catch(() => {});
      return linked;
    }),
    list_codex_sessions_metadata: tool("Use this when the user asks to list /home/a9017 Codex sessions. Lists only files under the approved .codex/sessions directory. Metadata only: relative path, size, and modified time. Does not read session contents.", schema({ year: "string", month: "string", day: "string", limit: "integer" }), async (args, context) => listCodexSessionsMetadata(config, args, context)),
    create_codex_session_inventory_task: tool("Use this instead of create_task plus assign_task_to_codex when the user asks Codex to list Codex sessions. Creates a safe readonly task, streams progress, immediately runs the approved built-in handler, and returns the completed task with metadata-only results. It explicitly forbids transcript contents, tokens, configs, cookies, cache files, memories, or shell snapshots.", schema({ limit: "integer" }), async (args, context) => {
      const result = await createCodexSessionInventoryTask(store, config, args, context);
      github.syncTask(result.task).catch(() => {});
      emitTaskProgress(context, result.task, "started", "Safe Codex session metadata inventory started.");
      const completed = await completeCodexSessionInventoryTask(store, config, github, result.task, context);
      emitTaskProgress(context, completed.task, "completed", completed.task.result?.summary || "Safe Codex session metadata inventory completed.");
      return completed;
    }),
    run_assigned_codex_tasks: tool("Process assigned tasks. For session inventory tasks (readonly): safe metadata listing. For builder/deploy tasks: workspace inspection (file listing, port checks, health probes). Supports bounded concurrent execution.", schema({ limit: "integer", concurrency: "integer" }), async (args, context) => runAssignedCodexTasks(store, config, github, args, context)),
    complete_task: tool("Mark a task completed with a summary of what was done. Use after Codex finishes the work and verification passes. Include a brief summary for ChatGPT review.", schema({ task_id: "string", summary: "string" }, ["task_id"]), async ({ task_id, summary = "" }) => {
      const result = await updateTask(store, task_id, (task) => { task.status = "completed"; task.result = { summary, completed_at: new Date().toISOString() }; });
      github.syncTask(result.task).catch(() => {});
      return result;
    }),
    request_human_review: tool("Mark a task as waiting for human review.", schema({ task_id: "string", message: "string" }, ["task_id"]), async ({ task_id, message = "" }) => updateTask(store, task_id, (task) => { task.status = "waiting_for_review"; task.review_message = message; })),
    create_chatgpt_request: tool("Ask ChatGPT a question or request analysis. Use when Codex needs human input, product direction, design feedback, or a tricky judgment call. ChatGPT sees this and responds. Syncs to GitHub Issues if configured.", schema({ title: "string", prompt: "string", source: "string", task_id: "string", workspace_id: "string" }, ["title", "prompt"]), async (args) => {
      const result = await createChatGptRequest(store, args);
      github.syncChatGptRequest(result.request).catch(() => {});
      return result;
    }),
    list_chatgpt_requests: tool("List coordination requests from Codex needing ChatGPT attention. Open requests mean Codex is waiting for your analysis, decision, or input.", schema({ status: "string", source: "string", limit: "integer" }), async ({ status, source, limit = 50 }) => {
      const state = await store.load();
      state.chatgpt_requests ||= [];
      let requests = state.chatgpt_requests;
      if (status) requests = requests.filter((request) => request.status === status);
      if (source) requests = requests.filter((request) => request.source === source);
      return { requests: requests.slice(-limit).reverse() };
    }),
    get_chatgpt_request: tool("Return a ChatGPT coordination request.", schema({ request_id: "string" }, ["request_id"]), async ({ request_id }) => ({ request: await findChatGptRequest(store, request_id) })),
    answer_chatgpt_request: tool("Record ChatGPT response to a coordination request. Use this to attach ChatGPT analysis or decision so Codex can continue working.", schema({ request_id: "string", response: "string" }, ["request_id", "response"]), async ({ request_id, response }) => {
      const result = await updateChatGptRequest(store, request_id, (request) => { request.status = "answered"; request.response = response; request.answered_at = new Date().toISOString(); });
      github.syncChatGptRequest(result.request).catch(() => {});
      return result;
    }),

    list_dir: tool("List files and directories under a workspace path.", schema({ path: "string", recursive: "boolean", limit: "integer", workspace_id: "string" }), async (args, context) => workspaceListDir(store, config, args, context)),
    stat_path: tool("Return metadata for a file or directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceStat(store, config, args, context)),
    read_text_file: tool("Read a UTF-8 text file.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceReadText(store, config, args, context)),
    download_file_base64: tool("Download a file as base64.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDownloadBase64(store, config, args, context)),
    write_text_file: tool("Write a UTF-8 text file.", schema({ path: "string", content: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content"]), async (args, context) => workspaceWriteText(store, config, args, context)),
    upload_base64_file: tool("Upload a base64 encoded file.", schema({ path: "string", content_base64: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content_base64"]), async (args, context) => workspaceUploadBase64(store, config, args, context)),
    upload_bundle_base64: tool("Upload a ZIP bundle encoded as base64. Optionally extract it in the workspace after upload.", schema({ path: "string", zip_base64: "string", overwrite: "boolean", extract: "boolean", target_dir: "string", sha256_expected: "string", workspace_id: "string" }, ["path", "zip_base64"]), async (args, context) => workspaceUploadBundleBase64(store, config, args, context)),
    download_bundle_base64: tool("Create a ZIP bundle from a workspace directory or selected paths and return it as base64 with a SHA256 digest.", schema({ source_dir: "string", paths: "array", workspace_id: "string" }, []), async (args, context) => workspaceDownloadBundleBase64(store, config, args, context)),
    upload_from_url: tool("Download a URL and save it to the workspace.", schema({ url: "string", path: "string", overwrite: "boolean", workspace_id: "string" }, ["url", "path"]), async (args, context) => workspaceUploadFromUrl(store, config, args, context)),
    init_chunk_upload: tool("Initialize a chunk upload session.", schema({ path: "string", total_chunks: "integer" }, ["path", "total_chunks"]), async ({ path, total_chunks }) => ({ upload_id: randomUUID(), path, total_chunks })),
    upload_file_chunk: tool("Accept a chunk upload placeholder.", schema({ upload_id: "string", chunk_index: "integer", chunk_base64: "string" }, ["upload_id", "chunk_index", "chunk_base64"]), async ({ upload_id, chunk_index }) => ({ ok: true, upload_id, chunk_index })),
    finish_chunk_upload: tool("Finish a chunk upload placeholder.", schema({ upload_id: "string", path: "string", sha256_expected: "string" }, ["upload_id", "path", "sha256_expected"]), async ({ upload_id, path }) => ({ ok: false, upload_id, path, error: "chunk merge is not enabled in v1 lightweight backend" })),
    abort_chunk_upload: tool("Abort a chunk upload placeholder.", schema({ upload_id: "string" }, ["upload_id"]), async ({ upload_id }) => ({ ok: true, upload_id })),
    mkdir: tool("Create a directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceMkdir(store, config, args, context)),
    delete_path: tool("归档或清理文件/目录。文件先移入回收位置，确认后可永久清除。", schema({ path: "string", recursive: "boolean", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDelete(store, config, args, context)),
    move_path: tool("Move or rename a file/directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceMove(store, config, args, context)),
    copy_path: tool("Copy a file or directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceCopy(store, config, args, context)),
    search_files: tool("Search text content and file names under a directory.", schema({ q: "string", path: "string", limit: "integer", workspace_id: "string" }, ["q"]), async (args, context) => workspaceSearch(store, config, args, context)),
    sha256_file: tool("Calculate SHA256 of a file.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceSha256(store, config, args, context)),
    create_zip_archive: tool("Create a ZIP archive from a directory.", schema({ source_dir: "string", zip_path: "string", workspace_id: "string" }, ["source_dir", "zip_path"]), async (args, context) => workspaceShellZip(store, config, "create", args, context)),
    extract_zip_archive: tool("Extract a ZIP archive into a workspace directory.", schema({ zip_path: "string", target_dir: "string", workspace_id: "string" }, ["zip_path"]), async (args, context) => workspaceShellZip(store, config, "extract", args, context)),
    shell_exec: tool("在工作区执行终端命令，用于检查服务状态和运行配置脚本。", schema({ command: "string", cwd: "string", timeout: "integer", max_output_bytes: "integer", workspace_id: "string" }, ["command"]), async (args, context) => workspaceShellExec(store, config, args, context)),

    sync_to_github: tool("Sync all open tasks and ChatGPT requests to GitHub Issues.", schema({}), async () => {
      const state = await store.load();
      const tasks = state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
      const requests = (state.chatgpt_requests || []).filter((r) => r.status === 'open');
      const taskResults = await github.syncAllTasks(tasks);
      const requestResults = await github.syncAllRequests(requests);
      return { options: { github_repo: process.env.GPTWORK_GITHUB_REPO || '(not set)', github_enabled: github.enabled }, synced_tasks: taskResults.length, synced_requests: requestResults.length, taskResults, requestResults };
    }),
    sync_from_github: tool("Import open GitHub Issues as tasks, and import GitHub Issue comments as ChatGPT responses. This is the no-reverse-proxy flow: ChatGPT creates GitHub Issues, Codex imports and works on them, results sync back. Also detects ChatGPT responses in issue comments.", schema({}), async () => {
      const imported = await github.importFromIssues(store);
      const responses = await github.importResponsesFromComments(store);
      return { imported_tasks: imported.length, tasks: imported.map((t) => ({ id: t.id, title: t.title, status: t.status })), imported_responses: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, responded_by: r.user })) };
    }),
    github_status: tool("Return GitHub sync configuration and known issue count.", schema({}), async () => ({
      enabled: github.enabled,
      repo: process.env.GPTWORK_GITHUB_REPO || '',
      known_issues: github.getKnownIssues().length,
      env_vars_set: { repo: !!process.env.GPTWORK_GITHUB_REPO, token: !!process.env.GPTWORK_GITHUB_TOKEN }
    })),

    sync_github_comments: tool("Poll GitHub Issues for new comments and import ChatGPT responses as answers to coordination requests. After ChatGPT responds to a question via GitHub Issue comment, use this to bring the answer back into the system.", schema({}), async () => {
      const responses = await github.importResponsesFromComments(store);
      return { checked_issues: github.getKnownIssues().length, responses_found: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, from: r.user })) };
    }),

    browser_new_session: tool("Create a lightweight browser session.", schema({ headless: "boolean", viewport_width: "integer", viewport_height: "integer" }), async (args) => browser.newSession(args)),
    browser_list_sessions: tool("List browser sessions.", schema({}), async () => browser.listSessions()),
    browser_close_session: tool("Close a browser session.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.closeSession(session_id)),
    browser_goto: tool("Navigate a browser session to a URL.", schema({ session_id: "string", url: "string" }, ["session_id", "url"]), async ({ session_id, url }) => browser.goto(session_id, url)),
    browser_current_state: tool("Return current page URL and title.", schema({ session_id: "string" }, ["session_id"]), async ({ session_id }) => browser.currentState(session_id)),
    browser_get_text: tool("Extract visible inner text.", schema({ session_id: "string", max_chars: "integer" }, ["session_id"]), async ({ session_id, max_chars }) => browser.getText(session_id, max_chars)),
    browser_get_html: tool("Extract HTML.", schema({ session_id: "string", max_chars: "integer" }, ["session_id"]), async ({ session_id, max_chars }) => browser.getHtml(session_id, max_chars)),
    browser_extract_links: tool("Extract links.", schema({ session_id: "string", limit: "integer" }, ["session_id"]), async ({ session_id, limit }) => browser.extractLinks(session_id, limit)),
    browser_click: tool("Record a click.", schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]), async ({ session_id, selector }) => browser.click(session_id, selector)),
    browser_fill: tool("Record input fill.", schema({ session_id: "string", selector: "string", text: "string" }, ["session_id", "selector", "text"]), async ({ session_id, selector, text }) => browser.fill(session_id, selector, text)),
    browser_press: tool("Record key press.", schema({ session_id: "string", selector: "string", key: "string" }, ["session_id", "selector", "key"]), async ({ session_id, selector, key }) => browser.press(session_id, selector, key)),
    browser_wait_for_selector: tool("Wait for selector.", schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]), async ({ session_id, selector }) => browser.waitForSelector(session_id, selector)),
    browser_scroll: tool("Record scroll.", schema({ session_id: "string", x: "integer", y: "integer" }, ["session_id"]), async ({ session_id, x, y }) => browser.scroll(session_id, x, y)),
    browser_screenshot: tool("Return screenshot placeholder metadata.", schema({ session_id: "string", path: "string" }, ["session_id"]), async ({ session_id, path = "" }) => ({ ok: false, session_id, path, error: "screenshots require a Playwright-enabled browser adapter" })),
    browser_set_input_files: tool("Return file upload placeholder metadata.", schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector", "path"]), async (args) => ({ ok: false, ...args, error: "file input automation requires a Playwright-enabled browser adapter" })),
    browser_click_and_download: tool("Return download placeholder metadata.", schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector"]), async (args) => ({ ok: false, ...args, error: "download automation requires a Playwright-enabled browser adapter" })),
    browser_evaluate: tool("Evaluate JavaScript placeholder.", schema({ session_id: "string", script: "string" }, ["session_id", "script"]), async ({ session_id, script }) => browser.evaluate(session_id, script))
  };
}

async function handleHttp(req, res, server) {
  setCors(res);
  if (req.method === "OPTIONS") return endJson(res, 204, {});
  if (req.url === "/health") return endJson(res, 200, { ok: true, service: "gptwork-mcp", time: new Date().toISOString() });
  if (!req.url?.startsWith("/mcp")) return endJson(res, 404, { error: "not found" });
  if (req.method === "GET") return endSse(res, ": connected\n\n");
  if (req.method !== "POST") return endJson(res, 406, { jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Not Acceptable: use POST with Accept: text/event-stream" } });

  try {
    const raw = await readRequest(req);
    const message = JSON.parse(raw || "{}");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] || randomUUID());
    setSseHeaders(res);
    const response = await server.handleRpc(message, headersWithPathToken(req), (progress) => writeSseMessage(res, progress));
    if (response) writeSseMessage(res, response);
    res.end();
  } catch (error) {
    const response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
    if (res.headersSent) {
      writeSseMessage(res, response);
      res.end();
    } else {
      endJson(res, 400, response);
    }
  }
}

function headersWithPathToken(req) {
  if (req.headers.authorization) return req.headers;
  const token = tokenFromMcpPath(req.url || "");
  if (!token) return req.headers;
  return { ...req.headers, authorization: `Bearer ${token}` };
}

function tokenFromMcpPath(url) {
  const path = url.split("?", 1)[0];
  const match = path.match(/^\/mcp\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

function endSse(res, body) {
  setSseHeaders(res);
  res.end(body);
}

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
}

function writeSseMessage(res, message) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function toolList(tools) {
  return Object.entries(tools).map(([name, value]) => ({
    name,
    description: value.description,
    inputSchema: value.inputSchema,
    outputSchema: { type: "object", additionalProperties: true }
  }));
}

function schema(properties, required = []) {
  const mapped = {};
  for (const [key, type] of Object.entries(properties)) mapped[key] = { type };
  return { type: "object", properties: mapped, required, additionalProperties: false };
}

function initializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      experimental: {},
      logging: {},
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
      tools: { listChanged: true },
      extensions: { "io.modelcontextprotocol/ui": {} }
    },
    serverInfo: { name: "GPTWork MCP", version: "0.1.0" }
  };
}

function assertAuthorized(headers, config) {
  if (!config.requireAuth) return defaultTokenContext("anonymous");
  const auth = headers.authorization || headers.Authorization || "";
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  if (!token || !config.tokenContexts[token]) {
    const error = new Error("Missing or invalid bearer token");
    error.code = -32001;
    throw error;
  }
  return config.tokenContexts[token];
}

function jsonResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseTokens(value) {
  return String(value).split(",").map((token) => token.trim()).filter(Boolean);
}

function parseTokenContexts(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTokenContexts(contexts, tokens) {
  const normalized = {};
  for (const token of tokens) normalized[token] = defaultTokenContext(token);
  for (const [token, context] of Object.entries(contexts || {})) {
    normalized[token] = {
      ...defaultTokenContext(token),
      ...context,
      user_name: context.user_name || context.name || defaultTokenContext(token).user_name,
      project_ids: normalizeList(context.project_ids, ["*"]),
      workspace_ids: normalizeList(context.workspace_ids, ["*"]),
      scopes: normalizeList(context.scopes, defaultScopes())
    };
  }
  return normalized;
}

function defaultTokenContext(token) {
  return {
    token_label: token === "anonymous" ? "anonymous" : `token:${String(token).slice(0, 6)}`,
    user_id: "user_default",
    user_name: "Default User",
    team_id: "team_default",
    project_ids: ["*"],
    workspace_ids: ["*"],
    scopes: defaultScopes()
  };
}

function defaultScopes() {
  return ["project:read", "project:admin", "task:create", "task:update", "task:assign_codex", "workspace:read", "workspace:write", "files:upload", "files:download", "shell:exec", "ssh:use", "browser:use", "audit:read"];
}

function normalizeList(value, fallback) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function limits(config) {
  return {
    max_read_bytes: config.maxReadBytes,
    max_shell_output_bytes: config.maxShellOutputBytes,
    shell_timeout: config.shellTimeout
  };
}

async function selectWorkspace(store, workspace_id, context = defaultTokenContext("system")) {
  const state = await store.load();
  const workspace = workspace_id
    ? state.workspaces.find((item) => item.id === workspace_id)
    : state.workspaces.find((item) => item.default) || state.workspaces[0];
  if (!workspace) throw new Error(`workspace not found: ${workspace_id || "default"}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);
  return workspace;
}

function findProject(state, project_id) {
  const project = state.projects.find((item) => item.id === project_id);
  if (!project) throw new Error(`project not found: ${project_id}`);
  return project;
}

function canAccessProject(context, projectId) {
  return context.project_ids.includes("*") || context.project_ids.includes(projectId);
}

function canAccessWorkspace(context, workspaceId) {
  return context.workspace_ids.includes("*") || context.workspace_ids.includes(workspaceId);
}

function requireProjectAccess(context, projectId) {
  if (!canAccessProject(context, projectId)) throw new Error(`project access denied: ${projectId}`);
}

function requireWorkspaceAccess(context, workspaceId) {
  if (!canAccessWorkspace(context, workspaceId)) throw new Error(`workspace access denied: ${workspaceId}`);
}

function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) throw new Error(`missing required scope: ${scope}`);
}

async function createWorkspace(store, config, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  requireProjectAccess(context, args.project_id);
  if (args.type === "ssh") requireScope(context, "ssh:use");
  if (!["hosted", "ssh"].includes(args.type)) throw new Error(`unsupported workspace type: ${args.type}`);
  if (args.type === "ssh" && !args.host) throw new Error("SSH workspace requires host");

  const state = await store.load();
  findProject(state, args.project_id);
  const now = new Date().toISOString();
  const id = args.id || `workspace_${randomUUID()}`;
  if (state.workspaces.some((workspace) => workspace.id === id)) throw new Error(`workspace already exists: ${id}`);

  const workspace = {
    id,
    project_id: args.project_id,
    name: args.name,
    type: args.type,
    root: args.root || join(config.defaultWorkspaceRoot, id),
    default: Boolean(args.default),
    created_at: now,
    updated_at: now
  };

  if (args.type === "ssh") {
    workspace.host = args.host;
    workspace.user = args.user || "";
    workspace.port = args.port || 22;
    if (args.identity_file) workspace.identity_file = args.identity_file;
    if (args.socks_proxy) workspace.socks_proxy = args.socks_proxy;
  }

  state.workspaces.push(workspace);
  if (workspace.default) setDefaultWorkspace(state, workspace);
  state.activities.push({ time: now, type: "workspace.created", workspace_id: workspace.id, project_id: workspace.project_id });
  await store.save();
  return { workspace };
}

async function updateWorkspace(store, args, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const workspace = state.workspaces.find((item) => item.id === args.workspace_id);
  if (!workspace) throw new Error(`workspace not found: ${args.workspace_id}`);
  requireProjectAccess(context, workspace.project_id);
  requireWorkspaceAccess(context, workspace.id);

  for (const field of ["name", "root", "host", "user", "port", "identity_file", "socks_proxy"]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) workspace[field] = args[field];
  }
  if (Object.prototype.hasOwnProperty.call(args, "default")) {
    workspace.default = Boolean(args.default);
    if (workspace.default) setDefaultWorkspace(state, workspace);
  }
  workspace.updated_at = new Date().toISOString();
  state.activities.push({ time: workspace.updated_at, type: "workspace.updated", workspace_id: workspace.id });
  await store.save();
  return { workspace };
}

async function deleteWorkspace(store, { workspace_id }, context) {
  requireScope(context, "project:admin");
  requireScope(context, "workspace:write");
  const state = await store.load();
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspace_id);
  if (index === -1) throw new Error(`workspace not found: ${workspace_id}`);
  const [removed] = state.workspaces.splice(index, 1);
  requireProjectAccess(context, removed.project_id);
  requireWorkspaceAccess(context, removed.id);

  if (removed.default) {
    const fallback = state.workspaces.find((workspace) => workspace.project_id === removed.project_id);
    if (fallback) setDefaultWorkspace(state, fallback);
  }
  const now = new Date().toISOString();
  state.activities.push({ time: now, type: "workspace.deleted", workspace_id: removed.id });
  await store.save();
  return { ok: true, removed };
}

async function testWorkspaceConnection(store, config, { workspace_id, dry_run = false }, context) {
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "hosted") {
    await mkdir(workspace.root, { recursive: true });
    return { ok: true, workspace_id: workspace.id, type: "hosted", root: workspace.root };
  }

  requireScope(context, "ssh:use");
  const built = buildSshExecCommand(workspace, "printf gptwork-ssh-ok", ".");
  if (dry_run) return { ok: true, dry_run: true, workspace_id: workspace.id, command: `${built.file} ${built.args.join(" ")}` };

  const result = await runSshExec(workspace, "printf gptwork-ssh-ok", ".", Math.min(config.shellTimeout, 15), config.maxShellOutputBytes);
  return { ok: result.returncode === 0 && result.stdout.includes("gptwork-ssh-ok"), workspace_id: workspace.id, result };
}

function setDefaultWorkspace(state, workspace) {
  for (const item of state.workspaces) {
    if (item.project_id === workspace.project_id) item.default = item.id === workspace.id;
  }
  const project = state.projects.find((item) => item.id === workspace.project_id);
  if (project) {
    project.default_workspace_id = workspace.id;
    project.updated_at = new Date().toISOString();
  }
}

async function createTask(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  const state = await store.load();
  ensureGoalState(state);
  requireProjectAccess(context, args.project_id || "default");
  if (args.workspace_id) requireWorkspaceAccess(context, args.workspace_id);
  const now = new Date().toISOString();
  const task = {
    id: `task_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    title: args.title,
    description: args.description || "",
    created_by: context.user_id,
    assignee: args.assignee || "",
    status: args.assignee ? "queued" : "draft",
    mode: normalizeCreatedTaskMode(args),
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
  state.tasks.push(task);
  state.activities.push({ time: now, type: "task.created", task_id: task.id, title: task.title });
  await store.save();
  if (isCodexSessionInventoryTaskKind(task)) return { task };
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: Boolean(task.assignee) });
  return { task: linked.task, goal: linked.goal, conversation: linked.conversation, memories: linked.memories, workspace_files: linked.workspace_files };
}

function ensureGoalState(state) {
  state.goals ||= [];
  state.conversations ||= [];
  state.memories ||= [];
  state.tasks ||= [];
  state.activities ||= [];
}

async function createGoal(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const projectId = args.project_id || "default";
  const workspaceId = args.workspace_id || "hosted-default";
  requireProjectAccess(context, projectId);
  requireWorkspaceAccess(context, workspaceId);

  const state = await store.load();
  ensureGoalState(state);
  const now = new Date().toISOString();
  const goalId = `goal_${randomUUID()}`;
  const conversationId = `conv_${randomUUID()}`;
  const assignToCodex = args.assign_to_codex !== false;
  const mode = normalizeCreatedTaskMode({ title: args.title || titleFromGoal(args), description: args.goal_prompt, mode: args.mode || "builder" });
  const messages = normalizeGoalMessages(args.messages, now, context.user_id);
  const memories = normalizeGoalMemories(args.memories, goalId, conversationId, now, context.user_id);
  const goal = {
    id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    task_id: null,
    user_request: String(args.user_request || ""),
    goal_prompt: String(args.goal_prompt || ""),
    context_summary: String(args.context_summary || ""),
    preview_text: String(args.preview_text || ""),
    title: args.title || titleFromGoal(args),
    created_by: context.user_id,
    assignee: assignToCodex ? "codex" : "",
    status: assignToCodex ? "assigned" : "open",
    mode,
    created_at: now,
    updated_at: now
  };
  const conversation = {
    id: conversationId,
    goal_id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    messages,
    created_at: now,
    updated_at: now
  };

  state.goals.push(goal);
  state.conversations.push(conversation);
  state.memories.push(...memories);
  state.activities.push({ time: now, type: "goal.created", goal_id: goalId, title: goal.title });

  let task = null;
  if (assignToCodex) {
    task = buildGoalTask(goal, conversation, context.user_id);
    state.tasks.push(task);
    goal.task_id = task.id;
    state.activities.push({ time: now, type: "goal.assigned_codex", goal_id: goalId, task_id: task.id, title: goal.title });
  }

  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {
    payload: args.payload || null,
    payload_base64: args.payload_base64 || "",
    bundles: args.bundles || [],
    initialize_result: true
  }, context);
  await store.save();
  return { goal, conversation, memories, task, workspace_files };
}

async function createEncodedGoal(store, config, { preview_text, payload_base64, assign_to_codex = true } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const payload = decodeBase64Json(payload_base64, "payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded goal payload requires user_request and goal_prompt");
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  if (preview_text && !messages.some((message) => String(message.content || "") === String(preview_text))) {
    messages.push({ role: "chatgpt", content: String(preview_text) });
  }
  return createGoal(store, config, {
    ...payload,
    messages,
    preview_text,
    payload,
    payload_base64,
    assign_to_codex: payload.assign_to_codex ?? assign_to_codex
  }, context);
}

async function listGoals(store, { status, assignee, workspace_id, limit = 50 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);
  let goals = state.goals.filter((goal) => canAccessProject(context, goal.project_id) && canAccessWorkspace(context, goal.workspace_id));
  if (status) goals = goals.filter((goal) => goal.status === status);
  if (assignee) goals = goals.filter((goal) => goal.assignee === assignee);
  if (workspace_id) goals = goals.filter((goal) => goal.workspace_id === workspace_id);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  return { goals: goals.slice(-maxItems).reverse() };
}

async function getGoalContext(store, config, { goal_id, task_id } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);
  const goal = findGoalInState(state, { goal_id, task_id });
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);
  const conversation = state.conversations.find((item) => item.id === goal.conversation_id) || null;
  const memories = state.memories.filter((item) => item.goal_id === goal.id);
  const task = goal.task_id ? state.tasks.find((item) => item.id === goal.task_id) || null : null;
  return { goal, conversation, memories, task, workspace_files: goalWorkspaceFiles(goal), codex_instruction: codexInstruction(goal) };
}

async function appendGoalMessage(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  const state = await store.load();
  ensureGoalState(state);
  const goal = findGoalInState(state, args);
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);
  let conversation = state.conversations.find((item) => item.id === goal.conversation_id);
  const now = new Date().toISOString();
  if (!conversation) {
    conversation = {
      id: goal.conversation_id || `conv_${randomUUID()}`,
      goal_id: goal.id,
      project_id: goal.project_id,
      workspace_id: goal.workspace_id,
      messages: [],
      created_at: now,
      updated_at: now
    };
    goal.conversation_id = conversation.id;
    state.conversations.push(conversation);
  }
  conversation.messages ||= [];
  const message = normalizeGoalMessage({ role: args.role || "codex", content: args.content }, now, context.user_id);
  conversation.messages.push(message);
  conversation.updated_at = now;
  goal.updated_at = now;
  let memory = null;
  if (args.memory_key || args.memory_value) {
    memory = normalizeGoalMemory({ key: args.memory_key || "note", value: args.memory_value || args.content }, goal.id, conversation.id, now, context.user_id);
    state.memories.push(memory);
  }
  state.activities.push({ time: now, type: "goal.message_appended", goal_id: goal.id, role: message.role });
  const memories = state.memories.filter((item) => item.goal_id === goal.id);
  const task = goal.task_id ? state.tasks.find((item) => item.id === goal.task_id) || null : null;
  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, { initialize_result: false }, context);
  await store.save();
  return { goal, conversation, message, memory, workspace_files };
}

function findGoalInState(state, { goal_id, task_id } = {}) {
  const goal = goal_id
    ? state.goals.find((item) => item.id === goal_id)
    : state.goals.find((item) => item.task_id === task_id);
  if (!goal) throw new Error(`goal not found: ${goal_id || task_id || "missing id"}`);
  return goal;
}

async function ensureTaskGoal(store, config, taskId, context = defaultTokenContext("system"), options = {}) {
  const state = await store.load();
  ensureGoalState(state);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (isCodexSessionInventoryTaskKind(task)) return { task };

  let goal = task.goal_id ? state.goals.find((item) => item.id === task.goal_id) : null;
  if (goal) {
    const conversation = state.conversations.find((item) => item.id === goal.conversation_id) || null;
    const memories = state.memories.filter((item) => item.goal_id === goal.id);
    const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {}, context);
    return { task, goal, conversation, memories, workspace_files };
  }

  const encoded = decodeTaskDescriptionEnvelope(task.description || "");
  const payload = encoded?.payload || taskPayloadFromTask(task);
  const created = await createGoal(store, config, {
    ...payload,
    title: payload.title || task.title,
    project_id: payload.project_id || task.project_id,
    workspace_id: payload.workspace_id || task.workspace_id,
    mode: payload.mode || task.mode || "builder",
    assign_to_codex: options.assign_to_codex ?? task.assignee === "codex",
    preview_text: encoded?.preview_text || payload.preview_text || "",
    payload: encoded?.payload || payload,
    payload_base64: encoded?.payload_base64 || ""
  }, context);

  await updateTask(store, task.id, (item) => {
    item.goal_id = created.goal.id;
    item.conversation_id = created.conversation.id;
    if (created.task && created.task.id !== item.id) {
      created.goal.task_id = item.id;
    }
  });

  const linkedState = await store.load();
  const createdTask = created.task && created.task.id !== task.id ? created.task : null;
  if (createdTask) {
    const index = linkedState.tasks.findIndex((item) => item.id === createdTask.id);
    if (index !== -1) linkedState.tasks.splice(index, 1);
  }
  goal = linkedState.goals.find((item) => item.id === created.goal.id);
  goal.task_id = task.id;
  const linkedTask = linkedState.tasks.find((item) => item.id === task.id);
  const conversation = linkedState.conversations.find((item) => item.id === goal.conversation_id) || null;
  const memories = linkedState.memories.filter((item) => item.goal_id === goal.id);
  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, linkedTask, {}, context);
  await store.save();
  return { task: linkedTask, goal, conversation, memories, workspace_files };
}

function taskPayloadFromTask(task) {
  return {
    user_request: task.description || task.title,
    goal_prompt: [
      `Task: ${task.title}`,
      "",
      task.description || "",
      "",
      "Execute this task in the selected workspace and report progress/results back to GPTWork."
    ].join("\n"),
    context_summary: "Created automatically from create_task compatibility flow.",
    project_id: task.project_id,
    workspace_id: task.workspace_id,
    mode: task.mode || "builder",
    messages: [
      { role: "user", content: task.description || task.title },
      { role: "chatgpt", content: `Created compatibility goal from task ${task.id}.` }
    ],
    memories: []
  };
}

function decodeTaskDescriptionEnvelope(description) {
  const text = String(description || "").trim();
  if (!text) return null;
  let envelope = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind === "gptwork.encoded_goal.v1" && parsed.payload_base64) envelope = parsed;
  } catch {}
  if (!envelope) {
    const match = text.match(/payload_base64\s*[:=]\s*([A-Za-z0-9+/=\r\n]+)/);
    if (match) envelope = { payload_base64: match[1].replace(/\s+/g, "") };
  }
  if (!envelope?.payload_base64) return null;
  const payload = decodeBase64Json(envelope.payload_base64, "task.description payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded task payload requires user_request and goal_prompt");
  return { payload, payload_base64: envelope.payload_base64, preview_text: envelope.preview_text || "" };
}

function decodeBase64Json(value, label) {
  let decoded = "";
  try {
    decoded = Buffer.from(String(value || ""), "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

function goalWorkspaceFiles(goal) {
  const dir = `.gptwork/goals/${goal.id}`;
  return {
    dir,
    goal_md: `${dir}/goal.md`,
    context_json: `${dir}/context.json`,
    transcript_md: `${dir}/transcript.md`,
    result_md: `${dir}/result.md`,
    payload_json: `${dir}/payload.json`,
    payload_base64: `${dir}/payload.base64`,
    bundle_zip: `${dir}/bundle.zip`,
    attachments_dir: `${dir}/attachments`
  };
}

async function writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, extras = {}, context = defaultTokenContext("system")) {
  const workspaceFiles = goalWorkspaceFiles(goal);
  const payload = extras.payload || {
    user_request: goal.user_request,
    goal_prompt: goal.goal_prompt,
    context_summary: goal.context_summary,
    mode: goal.mode,
    workspace_id: goal.workspace_id,
    messages: conversation?.messages || [],
    memories
  };
  const payloadJson = JSON.stringify(payload, null, 2);
  const payloadBase64 = extras.payload_base64 || Buffer.from(payloadJson, "utf8").toString("base64");
  const files = [
    { path: workspaceFiles.goal_md, content: renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) },
    { path: workspaceFiles.context_json, content: JSON.stringify({ goal, conversation, memories, task, workspace_files: workspaceFiles, codex_instruction: codexInstruction(goal) }, null, 2) },
    { path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) },
    { path: workspaceFiles.payload_json, content: payloadJson },
    { path: workspaceFiles.payload_base64, content: payloadBase64 }
  ];
  if (extras.initialize_result || typeof extras.result_content === "string") {
    files.push({ path: workspaceFiles.result_md, content: typeof extras.result_content === "string" ? extras.result_content : "# Result\n\nPending.\n" });
  }
  for (const file of files) {
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, file.path, file.content, context);
  }
  for (const bundle of Array.isArray(extras.bundles) ? extras.bundles : []) {
    if (!bundle?.zip_base64) continue;
    const name = safeBundleName(bundle.name || `bundle-${randomUUID()}.zip`);
    const zipPath = `${workspaceFiles.attachments_dir}/${name}`;
    await workspaceUploadBundleBase64(store, config, { path: zipPath, zip_base64: bundle.zip_base64, overwrite: true, extract: true, target_dir: `${workspaceFiles.attachments_dir}/${name.replace(/\.zip$/i, "")}`, sha256_expected: bundle.sha256, workspace_id: goal.workspace_id }, context);
  }
  return workspaceFiles;
}

async function writeWorkspaceTextInternal(store, config, workspaceId, path, content, context) {
  return workspaceWriteText(store, config, { path, content, overwrite: true, workspace_id: workspaceId }, context);
}

function renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) {
  return [
    `# GPTWork Goal ${goal.id}`,
    "",
    `Title: ${goal.title}`,
    `Status: ${goal.status}`,
    `Mode: ${goal.mode}`,
    `Workspace: ${goal.workspace_id}`,
    task ? `Task: ${task.id}` : "Task: none",
    "",
    "## User Request",
    "",
    goal.user_request || "(none)",
    "",
    "## GPTChat Preview",
    "",
    goal.preview_text || "(none)",
    "",
    "## Goal Prompt",
    "",
    goal.goal_prompt || "(none)",
    "",
    "## Context Summary",
    "",
    goal.context_summary || "(none)",
    "",
    "## Workspace Files",
    "",
    `- context: ${workspaceFiles.context_json}`,
    `- transcript: ${workspaceFiles.transcript_md}`,
    `- result: ${workspaceFiles.result_md}`,
    "",
    "## Memories",
    "",
    ...(memories.length ? memories.map((memory) => `- ${memory.key}: ${memory.value}`) : ["(none)"]),
    "",
    "## Execution Contract",
    "",
    "Read context.json and transcript.md before acting. Execute the goal prompt, update result.md, and append progress with append_goal_message."
  ].join("\n");
}

function renderTranscriptMarkdown(goal, conversation) {
  const messages = conversation?.messages || [];
  return [
    `# Transcript for ${goal.id}`,
    "",
    ...messages.flatMap((message) => [
      `## ${message.role} - ${message.created_at}`,
      "",
      message.content || "",
      ""
    ])
  ].join("\n");
}

function codexInstruction(goal) {
  const files = goalWorkspaceFiles(goal);
  return [
    "You are executing a GPTWork encoded/shared goal.",
    `Read ${files.goal_md}, ${files.context_json}, and ${files.transcript_md} before acting.`,
    "Follow goal.md exactly, write result.md, and append progress/results with append_goal_message."
  ].join("\n");
}

function safeBundleName(name) {
  return basename(String(name || "bundle.zip")).replace(/[^A-Za-z0-9._-]/g, "_") || "bundle.zip";
}

function buildGoalTask(goal, conversation, createdBy) {
  const now = goal.created_at;
  return {
    id: `task_${randomUUID()}`,
    project_id: goal.project_id,
    workspace_id: goal.workspace_id,
    goal_id: goal.id,
    conversation_id: conversation.id,
    title: goal.title,
    description: [
      `Goal ID: ${goal.id}`,
      `Conversation ID: ${conversation.id}`,
      `Mode: ${goal.mode}`,
      "",
      "User Request:",
      goal.user_request,
      "",
      "Goal Prompt:",
      goal.goal_prompt,
      "",
      "Context Summary:",
      goal.context_summary || "(none)",
      "",
      "Before acting, call get_goal_context with this goal_id and append progress with append_goal_message."
    ].join("\n"),
    created_by: createdBy,
    assignee: "codex",
    status: "assigned",
    mode: goal.mode,
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
}

function titleFromGoal(args) {
  const source = String(args.user_request || args.goal_prompt || "Codex goal").replace(/\s+/g, " ").trim();
  return source.length > 80 ? `${source.slice(0, 77)}...` : source || "Codex goal";
}

function normalizeGoalMessages(messages, now, userId) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => message && message.content).map((message) => normalizeGoalMessage(message, now, userId));
}

function normalizeGoalMessage(message, now, userId) {
  const role = String(message.role || "user").trim().toLowerCase();
  const allowedRoles = new Set(["user", "assistant", "chatgpt", "codex", "system", "tool"]);
  return {
    id: `msg_${randomUUID()}`,
    role: allowedRoles.has(role) ? role : "user",
    content: String(message.content || ""),
    author_id: message.author_id || userId,
    created_at: message.created_at || now
  };
}

function normalizeGoalMemories(memories, goalId, conversationId, now, userId) {
  if (!Array.isArray(memories)) return [];
  return memories.filter((memory) => memory && (memory.key || memory.value)).map((memory) => normalizeGoalMemory(memory, goalId, conversationId, now, userId));
}

function normalizeGoalMemory(memory, goalId, conversationId, now, userId) {
  return {
    id: `mem_${randomUUID()}`,
    goal_id: goalId,
    conversation_id: conversationId,
    key: String(memory.key || "note"),
    value: String(memory.value || ""),
    created_by: memory.created_by || userId,
    created_at: memory.created_at || now
  };
}

function normalizeCreatedTaskMode(args) {
  const mode = String(args.mode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode && !allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
  if (mode === "readonly") {
    return isCodexSessionInventoryTaskKind({
      title: args.title,
      description: args.description || "",
      assignee: "codex",
      status: "assigned",
      mode: "readonly"
    }) ? "readonly" : "builder";
  }
  return mode || "builder";
}

function normalizeAssignedTaskMode(task, requestedMode = "") {
  const mode = String(requestedMode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode) {
    if (!allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
    if (mode === "readonly" && !isCodexSessionInventoryTaskKind({ ...task, assignee: "codex", mode: "readonly" })) return "builder";
    return mode;
  }
  if (isCodexSessionInventoryTaskKind({ ...task, assignee: "codex" })) return "readonly";
  return task.mode && task.mode !== "readonly" ? task.mode : "builder";
}

async function listCodexSessionsMetadata(config, { year = "", month = "", day = "", limit = 50 }, context) {
  requireScope(context, "workspace:read");
  const sessionsRoot = join(config.codexHome, ".codex", "sessions");
  const parts = [year, month, day].filter(Boolean).map(validateDateSegment);
  const targetRoot = join(sessionsRoot, ...parts);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  const sessions = [];

  async function walk(dir) {
    if (sessions.length >= maxItems) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sessions.length >= maxItems) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const item = await stat(child);
        sessions.push({
          name: entry.name,
          relative_path: relative(sessionsRoot, child).replaceAll("\\", "/"),
          size: item.size,
          modified_at: item.mtime.toISOString()
        });
      }
    }
  }

  await walk(targetRoot);
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { root: sessionsRoot, target: relative(sessionsRoot, targetRoot).replaceAll("\\", "/") || ".", count: sessions.length, limit: maxItems, sessions };
}

function validateDateSegment(value) {
  const text = String(value || "").trim();
  if (!/^\d{2,4}$/.test(text)) throw new Error("invalid date segment");
  return text;
}

async function createCodexSessionInventoryTask(store, config, { limit = 50 } = {}, context = defaultTokenContext("system")) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const result = await createTask(store, config, {
    title: "List Codex session metadata",
    description: [
      "List Codex session file metadata under /home/a9017/.codex/sessions only.",
      `Return at most ${boundedLimit} files with relative_path, size, and modified_at.`,
      "Do not read session file contents.",
      "Do not inspect tokens, configs, cookies, cache files, memories, or shell snapshots."
    ].join("\n"),
    assignee: "codex",
    mode: "readonly"
  }, context);
  result.task.status = "assigned";
  result.task.updated_at = new Date().toISOString();
  const state = await store.load();
  state.activities.push({ time: result.task.updated_at, type: "task.assigned_codex", task_id: result.task.id, title: result.task.title });
  await store.save();
  return result;
}

async function runAssignedCodexTasks(store, config, github, { limit = 10, concurrency = 4 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  requireScope(context, "workspace:read");
  const maxTasks = Math.max(1, Math.min(Number(limit) || 10, 50));
  const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 16));
  const state = await store.load();
  await normalizeLegacyModes(store, state);
  const candidates = state.tasks
    .filter((task) => (task.assignee === "codex" || task.assignee === "") && (task.status === "assigned" || task.status === "queued" || task.status === "draft") && canAccessProject(context, task.project_id) && canAccessWorkspace(context, task.workspace_id))
    .slice(0, maxTasks);


  const results = await mapConcurrent(candidates, maxConcurrency, async (task) => {
    // Auto-promote queued tasks to assigned
    if (task.status === "queued" || task.status === "draft") {
      await updateTask(store, task.id, (t) => { t.status = "assigned"; if (!t.assignee) t.assignee = "codex"; t.logs.push({ time: new Date().toISOString(), message: `[worker] auto-assigned from ${task.status}` }); });
      task.status = "assigned";
    }
    if (isCodexSessionInventoryTask(task)) {
      const completed = await completeCodexSessionInventoryTask(store, config, github, task, context);
      return { task_id: completed.task.id, status: completed.task.status, kind: completed.task.result?.kind || "unknown", count: completed.task.result?.sessions?.count ?? 0 };
    }
    if (task.mode === "builder" || task.mode === "deploy" || task.mode === "admin") {
      return await processGeneralTask(store, config, task, context);
    }
    return { task_id: task.id, status: task.status, skipped: true, reason: "no safe built-in handler for this assigned task" };
  });

  return {
    ok: true,
    inspected: candidates.length,
    concurrency: maxConcurrency,
    completed: results.filter((item) => item.status === "completed").length,
    skipped: results.filter((item) => item.skipped).length,
    tasks: results
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isCodexSessionInventoryTask(task) {
  return task?.assignee === "codex"
    && task?.status === "assigned"
    && task?.mode === "readonly"
    && isCodexSessionInventoryTaskKind(task);
}

function isCodexSessionInventoryTaskKind(task) {
  return task?.assignee === "codex"
    && /Codex session metadata/i.test(task?.title || "")
    && /Do not read session file contents/i.test(task?.description || "");
}

async function completeCodexSessionInventoryTask(store, config, github, task, context) {
  const boundedLimit = extractTaskLimit(task.description, 50);
  const sessions = await listCodexSessionsMetadata(config, { limit: boundedLimit }, context);
  const now = new Date().toISOString();
  const result = await updateTask(store, task.id, (item) => {
    item.status = "completed";
    item.result = {
      kind: "codex_session_inventory",
      summary: `Listed ${sessions.count} Codex session metadata entries without reading session contents.`,
      sessions,
      completed_at: now
    };
    item.logs.push({ time: now, message: `Safe Codex worker completed session metadata inventory: ${sessions.count} files.` });
  });
  github.syncTask(result.task).catch(() => {});
  return result;
}

async function processGeneralTask(store, config, task, context) {
  const now = new Date().toISOString();
  await updateTask(store, task.id, (item) => {
    item.logs.push({ time: now, message: `[worker] started: ${task.title}` });
  });

  const workspace = await selectWorkspace(store, task.workspace_id, context);
  if (workspace.type !== "hosted") {
    await updateTask(store, task.id, (item) => {
      item.logs.push({ time: new Date().toISOString(), message: `[worker] skipped: unsupported workspace type ${workspace.type}` });
    });
    return { task_id: task.id, status: task.status, skipped: true, reason: `unsupported workspace type: ${workspace.type}` };
  }
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: true });
  const goal = linked.goal;
  const conversation = linked.conversation;
  const memories = linked.memories || [];
  const workspaceFiles = linked.workspace_files || goalWorkspaceFiles(goal);
  if (goal) {
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Starting Codex execution for task ${task.id}. Reading ${workspaceFiles.goal_md}.`
    }, context);
  }
  // Mark as running to prevent duplicate processing by subsequent ticks
  await updateTask(store, task.id, (item) => {
    item.status = "running";
    item.logs.push({ time: new Date().toISOString(), message: "[worker] codex exec started" });
  });

  const mode = task.mode || "builder";
  const promptFile = `/tmp/.gptwork-task-${task.id}.txt`;
  const separator = "=".repeat(60);
  const goalContext = goal ? JSON.stringify({ goal, conversation, memories, workspace_files: workspaceFiles }, null, 2) : "{}";
  const fullPrompt = `# Task: ${task.title}

${task.description || ""}

${goal ? `# GPTWork Goal Context

You are executing a GPTWork encoded/shared goal.

Read these files before acting:
- ${workspaceFiles.goal_md}
- ${workspaceFiles.context_json}
- ${workspaceFiles.transcript_md}

Follow ${workspaceFiles.goal_md} exactly.
Write final results to ${workspaceFiles.result_md}.
When complete, report a concise summary so GPTWork can call append_goal_message.

Structured context:
${goalContext}` : ""}

${separator}
Execute the EXACT steps above, in order. Do not skip, substitute, or improvise.
Use ${workspace.root} as the base directory for all file operations.

After completing ALL steps, output a structured report with these exact fields:
CREATED_PATH=<path to created directory or file, or "none">
DECODED_CONTENT=<content that was decoded, or "none">
CLEANUP_OK=<yes/no>
FULL_SUMMARY=<one line summary of what was done>
${separator}`;
  await writeFile(promptFile, fullPrompt, "utf8");
  let summary = "";
  try {
    const cmd = "codex exec " + config.codexExecArgs + " < " + promptFile;
    const cr = await runLocalShell(cmd, workspace.root, 60, 1000000);
    const out = (cr.stdout || "").trim();
    if (out) {
      const hdr = out.indexOf(separator);
      summary = hdr >= 0 ? out.substring(hdr) : out;
    }
    if (!summary && cr.stderr) summary = (cr.stderr || "").trim().slice(0, 10000);
    if (cr.timed_out) summary += "\n[TIMEOUT]";
  } catch (e) {
    summary = "[ERROR] " + e.message;
  } finally {
    try { await rm(promptFile, { force: true }); } catch {}
  }
  if (!summary) summary = "Task completed (no output captured)";
  const doneAt = new Date().toISOString();
  const result = await updateTask(store, task.id, (item) => {
    item.status = "completed";
    item.result = { summary, kind: "codex_executed", completed_at: doneAt };
    item.logs.push({ time: doneAt, message: "[worker] completed: task processed by Codex CLI" });
  });
  if (goal) {
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, workspaceFiles.result_md, `# Result\n\n${summary}\n\nCompleted at: ${doneAt}\n`, context);
    await appendGoalMessage(store, config, {
      goal_id: goal.id,
      role: "codex",
      content: `[worker] Completed task ${task.id}.\n\n${summary}`,
      memory_key: "codex_last_result",
      memory_value: summary.slice(0, 4000)
    }, context);
  }
  try { github.syncTask(result.task).catch(() => {}); } catch {}
  return { task_id: result.task.id, status: "completed", kind: "codex_executed" };
}

function emitTaskProgress(context, task, phase, message) {
  context.emitProgress?.({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      level: "info",
      logger: "gptwork.codex_worker",
      data: {
        phase,
        task_id: task.id,
        title: task.title,
        status: task.status,
        message
      }
    }
  });
}

function extractTaskLimit(description = "", fallback = 50) {
  const match = String(description).match(/Return at most\s+(\d+)\s+files/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(Number(match[1]) || fallback, 200));
}

async function findTask(store, task_id) {
  const state = await store.load();
  await normalizeLegacyModes(store, state);
  const task = state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  return task;
}

async function normalizeLegacyModes(store, state) {
  let changed = false;
  for (const task of state.tasks || []) {
    if (task.mode === "readonly" && !isCodexSessionInventoryTaskKind(task)) {
      task.mode = "builder";
      task.updated_at = task.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  for (const goal of state.goals || []) {
    if (goal.mode === "readonly") {
      goal.mode = "builder";
      goal.updated_at = goal.updated_at || new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await store.save();
}

async function updateTask(store, task_id, updater) {
  const state = await store.load();
  const task = state.tasks.find((item) => item.id === task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);
  updater(task);
  task.updated_at = new Date().toISOString();
  state.activities.push({ time: task.updated_at, type: "task.updated", task_id, status: task.status });
  await store.save();
  return { task };
}

async function createChatGptRequest(store, args) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const now = new Date().toISOString();
  const request = {
    id: `chatreq_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    task_id: args.task_id || null,
    title: args.title,
    prompt: args.prompt,
    source: args.source || "codex",
    status: "open",
    response: "",
    created_at: now,
    updated_at: now
  };
  state.chatgpt_requests.push(request);
  state.activities.push({ time: now, type: "chatgpt_request.created", request_id: request.id, title: request.title });
  await store.save();
  return { request };
}

async function findChatGptRequest(store, request_id) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  return request;
}

async function updateChatGptRequest(store, request_id, updater) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  updater(request);
  request.updated_at = new Date().toISOString();
  state.activities.push({ time: request.updated_at, type: "chatgpt_request.updated", request_id, status: request.status });
  await store.save();
  return { request };
}

async function resolvePath(store, config, args, context) {
  const workspace = await selectWorkspace(store, args.workspace_id, context);
  if (workspace.type === "ssh") {
    const base = workspace.root.replace(/\/+$/, "");
    const target = String(args.path || ".").replace(/\\/g, "/");
    const safePath = (base + "/" + (target === "." ? "" : target)).replace(/\/+/g, "/");
    if (!safePath.startsWith(base)) throw new Error("path is outside workspace root: " + target);
    return { workspace, path: safePath };
  }
  const resolved = await resolveWorkspacePath(workspace.root, args.path || ".");
  return { workspace, path: resolved.absolutePath };
}

async function workspaceListDir(store, config, { path = ".", recursive = false, limit = 500, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshListDir(workspace, path, 15);
  const items = [];
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (items.length >= limit) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      const childStat = await stat(childAbs);
      items.push({ path: childRel, name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: childStat.size, modified_at: childStat.mtime.toISOString() });
      if (recursive && entry.isDirectory()) await walk(childAbs, childRel);
    }
  }
  await walk(resolvedPath, path);
  return { path, recursive, count: items.length, limit, items };
}

async function workspaceStat(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshStat(workspace, resolvedPath, 10);
  const item = await stat(resolvedPath);
  return { path: args.path, type: item.isDirectory() ? "directory" : "file", size: item.size, modified_at: item.mtime.toISOString() };
}

async function workspaceReadText(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshReadTextFile(workspace, resolvedPath, 15);
    const max = max_bytes || config.maxReadBytes;
    return { path, size: result.stdout.length, truncated: Buffer.byteLength(result.stdout) > max, content: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content: bytes.subarray(0, max).toString("utf8") };
}

async function workspaceDownloadBase64(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "files:download");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshDownloadBase64(workspace, resolvedPath, 30);
    const max = max_bytes || config.maxReadBytes;
    return { path, truncated: result.stdout.length > max, content_base64: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content_base64: bytes.subarray(0, max).toString("base64") };
}

async function workspaceWriteText(store, config, { path, content, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshWriteTextFile(workspace, resolvedPath, content, 30);
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content, "utf8");
  return { ok: true, path, size: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) };
}

async function workspaceUploadBase64(store, config, { path, content_base64, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshUploadBase64(workspace, resolvedPath, content_base64, 60);
  const content = Buffer.from(content_base64, "base64");
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content);
  return { ok: true, path, size: content.length, sha256: sha256(content) };
}

async function workspaceUploadFromUrl(store, config, { url, path, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const response = await fetch(url);
  if (!response.ok) throw new Error("download failed: " + response.status);
  const content = Buffer.from(await response.arrayBuffer());
  return workspaceUploadBase64(store, config, { path, content_base64: content.toString("base64"), overwrite, workspace_id }, context);
}

async function workspaceUploadBundleBase64(store, config, { path, zip_base64, overwrite = false, extract = false, target_dir = "", sha256_expected = "", workspace_id }, context) {
  requireScope(context, "files:upload");
  const uploaded = await workspaceUploadBase64(store, config, { path, content_base64: zip_base64, overwrite, workspace_id }, context);
  if (sha256_expected && uploaded.sha256 !== sha256_expected) throw new Error(`bundle sha256 mismatch: expected ${sha256_expected}, got ${uploaded.sha256}`);
  let extracted = null;
  if (extract) {
    extracted = await workspaceShellZip(store, config, "extract", { zip_path: path, target_dir: target_dir || dirname(path), workspace_id }, context);
  }
  return { ok: true, path, size: uploaded.size, sha256: uploaded.sha256, extracted };
}

async function workspaceDownloadBundleBase64(store, config, { source_dir = "", paths = [], workspace_id }, context) {
  requireScope(context, "files:download");
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "ssh") throw new Error("download_bundle_base64 currently supports hosted workspaces only");
  const tmpRoot = await mkdtemp(join(tmpdir(), "gptwork-bundle-"));
  const bundlePath = join(tmpRoot, "bundle.zip");
  const source = source_dir || ".";
  if (Array.isArray(paths) && paths.length) {
    const staging = join(tmpRoot, "staging");
    await mkdir(staging, { recursive: true });
    for (const item of paths) {
      const resolved = await resolveWorkspacePath(workspace.root, item);
      const target = join(staging, resolved.relativePath);
      await ensureParent(target);
      await cp(resolved.absolutePath, target, { recursive: true, force: true });
    }
    await runZipCommand("create", staging, bundlePath, config.pythonCommand);
  } else {
    const resolved = await resolveWorkspacePath(workspace.root, source);
    await runZipCommand("create", resolved.absolutePath, bundlePath, config.pythonCommand);
  }
  const bytes = await readFile(bundlePath);
  await rm(tmpRoot, { recursive: true, force: true });
  return { ok: true, source_dir: source, paths, size: bytes.length, sha256: sha256(bytes), zip_base64: bytes.toString("base64") };
}

async function workspaceMkdir(store, config, args, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshMkdir(workspace, resolvedPath, 10);
  await mkdir(resolvedPath, { recursive: true });
  return { ok: true, path: args.path };
}

async function workspaceDelete(store, config, { path, recursive = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshDelete(workspace, resolvedPath, recursive, 15);
  await rm(resolvedPath, { recursive, force: false });
  return { ok: true, deleted: path, permanent: true };
}

async function workspaceMove(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshMove(workspace, srcPath, dstPath, 15);
  if (!overwrite) {
    try {
      await stat(dstPath);
      throw new Error("destination exists: " + dst);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(dstPath);
  await rename(srcPath, dstPath);
  return { ok: true, src, dst };
}

async function workspaceCopy(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshCopy(workspace, srcPath, dstPath, 30);
  await ensureParent(dstPath);
  await cp(srcPath, dstPath, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  return { ok: true, src, dst };
}

async function workspaceSearch(store, config, { q, path = ".", limit = 50, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshSearchFiles(workspace, q, resolvedPath, 60, limit);
  const results = [];
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else {
        const bytes = await readFile(childAbs);
        const text = bytes.toString("utf8");
        const matchedName = childRel.includes(q);
        const idx = text.indexOf(q);
        if (matchedName || idx !== -1) {
          results.push({ path: childRel, size: bytes.length, matched_name: matchedName, matched_content: idx !== -1, snippet: idx === -1 ? "" : text.slice(Math.max(0, idx - 40), idx + q.length + 40) });
        }
      }
    }
  }
  await walk(resolvedPath, path);
  return { q, path, count: results.length, results };
}

async function workspaceSha256(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") {
    const hash = await sshSha256(workspace, resolvedPath, 15);
    return { path: args.path, sha256: hash };
  }
  const bytes = await readFile(resolvedPath);
  return { path: args.path, size: bytes.length, sha256: sha256(bytes) };
}

async function workspaceShellExec(store, config, { command, cwd = ".", timeout, max_output_bytes, workspace_id }, context) {
  requireScope(context, "shell:exec");
  const workspace = await selectWorkspace(store, workspace_id, context);
  const sshCwd = cwd === "." ? "." : cwd.replace(/\\/g, "/");
  if (workspace.type === "ssh") return runSshExec(workspace, command, sshCwd, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
  const { path: resolvedPath } = await resolvePath(store, config, { path: cwd || ".", workspace_id }, context);
  await mkdir(resolvedPath, { recursive: true });
  return runLocalShell(command, resolvedPath, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
}

async function workspaceShellZip(store, config, mode, args, context) {
  const command = mode === "create"
    ? config.pythonCommand + " -m zipfile -c " + shellQuotee(args.zip_path) + " " + shellQuotee(args.source_dir)
    : config.pythonCommand + " -m zipfile -e " + shellQuotee(args.zip_path) + " " + shellQuotee(args.target_dir || ".");
  return workspaceShellExec(store, config, { command, cwd: ".", workspace_id: args.workspace_id }, context);
}

async function runZipCommand(mode, sourcePath, zipPath, pythonCommand = process.platform === "win32" ? "python" : "python3") {
  const command = mode === "create"
    ? pythonCommand + " -m zipfile -c " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath)
    : pythonCommand + " -m zipfile -e " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath);
  const result = await runLocalShell(command, dirname(zipPath), 60, 1000000);
  if (result.returncode !== 0) throw new Error(`zip command failed: ${result.stderr || result.stdout}`);
  return result;
}

function runLocalShell(command, cwd, timeout, maxOutputBytes) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = exec(command, { cwd, timeout: timeout * 1000, maxBuffer: maxOutputBytes }, (error, stdout, stderr) => {
      resolve({
        command,
        cwd,
        returncode: error?.code ?? 0,
        stdout,
        stderr,
        timed_out: error?.killed || false,
        duration_ms: Date.now() - started,
        stdout_truncated: Buffer.byteLength(stdout) >= maxOutputBytes,
        stderr_truncated: Buffer.byteLength(stderr) >= maxOutputBytes
      });
    });
    child.stdin?.end();
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuotee(value) {
  if (process.platform === "win32") return `"${String(value).replaceAll('"', '\\"')}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function endJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(status === 204 ? "" : JSON.stringify(body));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
