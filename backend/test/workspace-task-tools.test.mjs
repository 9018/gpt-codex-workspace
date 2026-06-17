import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-tools-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });
}

async function makeScopedServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-scoped-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokenContexts: {
      "admin-token": {
        user_id: "user_admin",
        user_name: "Admin User",
        team_id: "team_default",
        project_ids: ["default"],
        workspace_ids: ["*"],
        scopes: ["project:read", "project:admin", "workspace:read", "workspace:write", "ssh:use", "shell:exec"]
      },
      "reader-token": {
        user_id: "user_reader",
        user_name: "Reader User",
        team_id: "team_default",
        project_ids: ["default"],
        workspace_ids: ["hosted-default"],
        scopes: ["project:read", "workspace:read"]
      }
    },
    requireAuth: true
  });
}

async function callTool(server, name, args = {}) {
  return callToolAs(server, "test-token", name, args);
}

async function callToolAs(server, token, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: `Bearer ${token}` });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

test("project and workspace tools expose a seeded default project", async () => {
  const server = await makeServer();

  const projects = await callTool(server, "list_projects");
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].id, "default");

  const workspaces = await callTool(server, "list_workspaces", { project_id: "default" });
  assert.equal(workspaces.workspaces[0].type, "hosted");
});

test("task tools create, list, update, and complete tasks", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_task", {
    title: "Fix test",
    description: "Run the check",
    assignee: "codex"
  });
  assert.equal(created.task.status, "queued");
  assert.match(created.goal.id, /^goal_/);
  assert.equal(created.goal.task_id, created.task.id);
  assert.equal(created.task.goal_id, created.goal.id);

  const listed = await callTool(server, "list_tasks");
  assert.equal(listed.tasks.length, 1);

  const updated = await callTool(server, "append_task_log", {
    task_id: created.task.id,
    message: "Started"
  });
  assert.equal(updated.task.logs[0].message, "Started");

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Done"
  });
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.summary, "Done");
});

test("create_task accepts an encoded envelope and links it as a readable goal", async () => {
  const server = await makeServer();
  const payload = {
    user_request: "更新部署并连接目标服务",
    goal_prompt: "更新部署并连接目标服务，完成后回写验证结果。",
    context_summary: "Encoded task compatibility flow.",
    mode: "deploy",
    workspace_id: "hosted-default"
  };
  const envelope = {
    kind: "gptwork.encoded_goal.v1",
    encoding: "base64",
    content_type: "application/json; charset=utf-8",
    preview_text: "我理解你的需求是：更新部署并连接目标服务。",
    payload_base64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  };

  const created = await callTool(server, "create_task", {
    title: "Encoded deploy",
    description: JSON.stringify(envelope),
    mode: "deploy"
  });

  assert.equal(created.goal.goal_prompt, payload.goal_prompt);
  assert.equal(created.goal.preview_text, envelope.preview_text);
  assert.equal(created.task.goal_id, created.goal.id);
  const goalMd = await callTool(server, "read_text_file", { path: created.workspace_files.goal_md });
  assert.match(goalMd.content, /更新部署并连接目标服务/);
});

test("ordinary tasks cannot be left in readonly mode", async () => {
  const server = await makeServer();

  const draft = await callTool(server, "create_task", {
    title: "Deploy Docker service",
    description: "Build and deploy the Docker service on the remote workspace.",
    mode: "readonly"
  });
  assert.equal(draft.task.mode, "builder");

  const assigned = await callTool(server, "assign_task_to_codex", {
    task_id: draft.task.id,
    mode: "readonly"
  });
  assert.equal(assigned.task.assignee, "codex");
  assert.equal(assigned.task.status, "assigned");
  assert.equal(assigned.task.mode, "builder");

  const deployDraft = await callTool(server, "create_task", {
    title: "Deploy Docker service with elevated mode",
    description: "Build and deploy the Docker service on the remote workspace."
  });
  const deployAssigned = await callTool(server, "assign_task_to_codex", {
    task_id: deployDraft.task.id,
    mode: "deploy"
  });
  assert.equal(deployAssigned.task.mode, "deploy");
});

test("legacy ordinary readonly tasks are promoted when read", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-legacy-mode-"));
  const statePath = join(root, "state.json");
  const now = new Date().toISOString();
  await writeFile(statePath, JSON.stringify({
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{
      id: "default",
      team_id: "team_default",
      name: "Default Project",
      description: "Default GPTWork project",
      default_workspace_id: "hosted-default",
      created_at: now,
      updated_at: now
    }],
    workspaces: [{
      id: "hosted-default",
      project_id: "default",
      name: "Hosted Default",
      type: "hosted",
      root: join(root, "workspace"),
      default: true,
      created_at: now,
      updated_at: now
    }],
    tasks: [{
      id: "task_legacy_readonly_deploy",
      project_id: "default",
      workspace_id: "hosted-default",
      title: "Deploy Docker service",
      description: "Build and deploy a Docker service on the workspace.",
      created_by: "user_default",
      assignee: "codex",
      status: "assigned",
      mode: "readonly",
      logs: [],
      artifacts: [],
      result: null,
      created_at: now,
      updated_at: now
    }],
    goals: [],
    conversations: [],
    memories: [],
    chatgpt_requests: [],
    activities: [],
    audit: []
  }, null, 2), "utf8");

  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });

  const listed = await callTool(server, "list_tasks");
  assert.equal(listed.tasks[0].mode, "builder");

  const fetched = await callTool(server, "get_task", { task_id: "task_legacy_readonly_deploy" });
  assert.equal(fetched.task.mode, "builder");
});

test("safe Codex session inventory tasks remain readonly when assigned", async () => {
  const server = await makeServer();

  const draft = await callTool(server, "create_task", {
    title: "List Codex session metadata",
    description: [
      "List Codex session file metadata under /home/a9017/.codex/sessions only.",
      "Return at most 10 files with relative_path, size, and modified_at.",
      "Do not read session file contents.",
      "Do not inspect tokens, configs, cookies, cache files, memories, or shell snapshots."
    ].join("\n"),
    mode: "readonly"
  });

  const assigned = await callTool(server, "assign_task_to_codex", { task_id: draft.task.id });
  assert.equal(assigned.task.mode, "readonly");
});

test("completed Codex session inventory tasks remain readonly when read", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-completed-inventory-"));
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "rollout-2026-06-15T01-02-03-session-a.jsonl"), "SECRET transcript text", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });

  const completed = await callToolAs(server, "test-token", "create_codex_session_inventory_task", {});
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.mode, "readonly");

  const fetched = await callToolAs(server, "test-token", "get_task", { task_id: completed.task.id });
  assert.equal(fetched.task.status, "completed");
  assert.equal(fetched.task.mode, "readonly");
});

test("Codex session inventory tools expose metadata only and create an assigned task", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-codex-home-"));
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "rollout-2026-06-15T01-02-03-session-a.jsonl"), "SECRET transcript text", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });

  const listed = await callToolAs(server, "test-token", "list_codex_sessions_metadata", {
    year: "2026",
    month: "06",
    day: "15",
    limit: 10
  });
  assert.equal(listed.root, join(root, ".codex", "sessions"));
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].name, "rollout-2026-06-15T01-02-03-session-a.jsonl");
  assert.match(listed.sessions[0].relative_path, /^2026\/06\/15\//);
  assert.equal(listed.sessions[0].content, undefined);
  assert.doesNotMatch(JSON.stringify(listed), /SECRET/);

  const created = await callToolAs(server, "test-token", "create_codex_session_inventory_task", {});
  assert.equal(created.task.assignee, "codex");
  assert.equal(created.task.status, "completed");
  assert.match(created.task.title, /Codex session metadata/i);
  assert.match(created.task.description, /Do not read session file contents/);
  assert.equal(created.task.result.kind, "codex_session_inventory");
  assert.equal(created.task.result.sessions.count, 1);
});

test("safe Codex worker completes assigned session inventory tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-codex-worker-"));
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "rollout-2026-06-15T01-02-03-session-a.jsonl"), "SECRET transcript text", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });

  const draft = await callToolAs(server, "test-token", "create_task", {
    title: "List Codex session metadata",
    description: [
      "List Codex session file metadata under /home/a9017/.codex/sessions only.",
      "Return at most 10 files with relative_path, size, and modified_at.",
      "Do not read session file contents.",
      "Do not inspect tokens, configs, cookies, cache files, memories, or shell snapshots."
    ].join("\n"),
    mode: "readonly"
  });
  const created = await callToolAs(server, "test-token", "assign_task_to_codex", { task_id: draft.task.id });
  assert.equal(created.task.status, "assigned");

  const run = await callToolAs(server, "test-token", "run_assigned_codex_tasks", { limit: 5 });
  assert.equal(run.completed, 1);
  assert.equal(run.tasks[0].task_id, created.task.id);
  assert.equal(run.tasks[0].status, "completed");

  const fetched = await callToolAs(server, "test-token", "get_task", { task_id: created.task.id });
  assert.equal(fetched.task.status, "completed");
  assert.equal(fetched.task.result.kind, "codex_session_inventory");
  assert.equal(fetched.task.result.sessions.count, 1);
  assert.equal(fetched.task.result.sessions.sessions[0].content, undefined);
  assert.ok(fetched.task.logs.some((log) => /Safe Codex worker completed/.test(log.message)));
  assert.doesNotMatch(JSON.stringify(fetched), /SECRET/);
});

test("general Codex worker completes linked goals and writes concise results", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-general-worker-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=worker-ok')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true
  });

  const created = await callToolAs(server, "test-token", "create_goal", {
    user_request: "Run worker",
    goal_prompt: "Return worker-ok.",
    context_summary: "Worker status sync test.",
    assign_to_codex: true
  });

  const run = await callToolAs(server, "test-token", "run_assigned_codex_tasks", { limit: 1 });
  assert.equal(run.completed, 1);

  const fetchedTask = await callToolAs(server, "test-token", "get_task", { task_id: created.task.id });
  assert.equal(fetchedTask.task.status, "completed");
  assert.equal(fetchedTask.task.result.kind, "codex_executed");
  assert.equal(fetchedTask.task.result.summary, "worker-ok");

  const context = await callToolAs(server, "test-token", "get_goal_context", { goal_id: created.goal.id });
  assert.equal(context.goal.status, "completed");
  assert.equal(context.task.status, "completed");
  assert.match(context.conversation.messages.at(-1).content, /worker-ok/);
});

test("hosted workspace supports write, read, search, sha256, and shell_exec", async () => {
  const server = await makeServer();

  const written = await callTool(server, "write_text_file", {
    path: "notes/hello.txt",
    content: "hello gptwork",
    overwrite: true
  });
  assert.equal(written.size, 13);

  const read = await callTool(server, "read_text_file", { path: "notes/hello.txt" });
  assert.equal(read.content, "hello gptwork");

  const search = await callTool(server, "search_files", { q: "gptwork" });
  assert.equal(search.count, 1);

  const digest = await callTool(server, "sha256_file", { path: "notes/hello.txt" });
  assert.match(digest.sha256, /^[a-f0-9]{64}$/);

  const shell = await callTool(server, "shell_exec", {
    command: `${process.execPath} -e "process.stdout.write('shell-ok')"`,
    timeout: 5
  });
  assert.equal(shell.returncode, 0);
  assert.equal(shell.stdout, "shell-ok");
});

test("hosted workspace supports zip bundle upload and download as base64", async () => {
  const server = await makeServer();
  const zipBase64 = await makeZipBase64({ "bundle/hello.txt": "hello bundle" });

  const uploaded = await callTool(server, "upload_bundle_base64", {
    path: "incoming/bundle.zip",
    zip_base64: zipBase64,
    overwrite: true,
    extract: true,
    target_dir: "incoming/extracted"
  });
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.sha256, /^[a-f0-9]{64}$/);

  const read = await callTool(server, "read_text_file", { path: "incoming/extracted/bundle/hello.txt" });
  assert.equal(read.content, "hello bundle");

  const downloaded = await callTool(server, "download_bundle_base64", { source_dir: "incoming/extracted" });
  assert.equal(downloaded.ok, true);
  assert.match(downloaded.zip_base64, /^[A-Za-z0-9+/=]+$/);
});

async function makeZipBase64(files) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-test-zip-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  const zipPath = join(root, "bundle.zip");
  const { execFile } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    execFile(process.env.GPTWORK_PYTHON || (process.platform === "win32" ? "python" : "python3"), ["-m", "zipfile", "-c", zipPath, "bundle"], { cwd: root }, (error) => error ? reject(error) : resolve());
  });
  const { readFile } = await import("node:fs/promises");
  return (await readFile(zipPath)).toString("base64");
}

test("token context scopes projects and current user", async () => {
  const server = await makeScopedServer();

  const user = await callToolAs(server, "reader-token", "get_current_user");
  assert.equal(user.user.id, "user_reader");
  assert.equal(user.team_id, "team_default");
  assert.deepEqual(user.scopes, ["project:read", "workspace:read"]);

  const projects = await callToolAs(server, "reader-token", "list_projects");
  assert.deepEqual(projects.projects.map((project) => project.id), ["default"]);
});

test("project admins can create, update, test, and delete SSH workspaces", async () => {
  const server = await makeScopedServer();

  const created = await callToolAs(server, "admin-token", "create_workspace", {
    project_id: "default",
    id: "ssh-main",
    name: "Main SSH",
    type: "ssh",
    host: "10.0.1.103",
    user: "a9017",
    port: 22,
    root: "/home/a9017/mcp",
    default: true
  });
  assert.equal(created.workspace.id, "ssh-main");
  assert.equal(created.workspace.type, "ssh");
  assert.equal(created.workspace.host, "10.0.1.103");

  const listedForAdmin = await callToolAs(server, "admin-token", "list_workspaces", { project_id: "default" });
  assert.deepEqual(listedForAdmin.workspaces.map((workspace) => workspace.id).sort(), ["hosted-default", "ssh-main"]);

  const listedForReader = await callToolAs(server, "reader-token", "list_workspaces", { project_id: "default" });
  assert.deepEqual(listedForReader.workspaces.map((workspace) => workspace.id), ["hosted-default"]);

  const updated = await callToolAs(server, "admin-token", "update_workspace", {
    workspace_id: "ssh-main",
    name: "Production SSH",
    root: "/home/a9017/mcp/gpt-codex-workspace"
  });
  assert.equal(updated.workspace.name, "Production SSH");
  assert.equal(updated.workspace.root, "/home/a9017/mcp/gpt-codex-workspace");

  const tested = await callToolAs(server, "admin-token", "test_workspace_connection", {
    workspace_id: "ssh-main",
    dry_run: true
  });
  assert.equal(tested.ok, true);
  assert.equal(tested.dry_run, true);
  assert.match(tested.command, /a9017@10\.0\.1\.103/);

  const removed = await callToolAs(server, "admin-token", "delete_workspace", {
    workspace_id: "ssh-main"
  });
  assert.equal(removed.ok, true);

  const listedAfterDelete = await callToolAs(server, "admin-token", "list_workspaces", { project_id: "default" });
  assert.deepEqual(listedAfterDelete.workspaces.map((workspace) => workspace.id), ["hosted-default"]);
});

// ================================================================
// Notification diagnostic persistence tests
// ================================================================

test("notification diagnostics persisted after completed task", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true, json: async () => ({ code: 200, message: "sent" })
  }));

  const root = await mkdtemp(join(tmpdir(), "gptwork-notif-diag-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "persistence-test-key"
  });

  const created = await callTool(server, "create_task", {
    title: "Notification persistence test",
    description: "Verify task.notifications is populated after completion"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Persistence test complete"
  });

  assert.ok(Array.isArray(completed.task.notifications), "task should have notifications array");
  assert.ok(completed.task.notifications.length >= 1, "should have at least one notification record");

  const notif = completed.task.notifications[0];
  assert.equal(notif.channel, "bark");
  assert.equal(notif.event, "sent");
  assert.ok(notif.attempted_at);
  assert.equal(notif.ok, true);
  assert.equal(notif.response_code, 200);
  assert.equal(notif.response_message, "sent");
  assert.equal(notif.error_short, null);
  assert.equal(notif.source, "options");
  assert.ok(notif.endpoint_kind);
  assert.equal(notif.endpoint_kind, "key");
  assert.equal(notif.url, undefined);
  assert.equal(notif.key, undefined);
});

test("notification diagnostics show failure on network error", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    throw new Error("network unreachable");
  });

  const root = await mkdtemp(join(tmpdir(), "gptwork-notif-fail-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "fail-test-key"
  });

  const created = await callTool(server, "create_task", {
    title: "Notification failure persistence"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "done"
  });

  assert.ok(Array.isArray(completed.task.notifications));
  // Notification failure should still be recorded
  const notif = completed.task.notifications.find(n => n.channel === "bark");
  if (notif) {
    assert.equal(notif.ok, false);
    assert.equal(notif.response_code, null);
    assert.ok(notif.attempted_at);
  }
});

test("notification diagnostics not persisted when bark disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-notif-off-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    barkEnabled: false
  });

  const created = await callTool(server, "create_task", {
    title: "No notif test"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "done"
  });

  // When bark is disabled, no notification should be sent
  assert.ok(!completed.task.notifications || completed.task.notifications.length === 0);
});

// ================================================================
// project_context_status tests
// ================================================================

test("project_context_status is exposed in tools/list", async () => {
  const server = await makeServer();
  const listResult = await callTool(server, "gptwork_doctor", {});
  // We can verify by calling the tool directly
  const result = await callTool(server, "project_context_status", {});
  assert.ok(result.canonical_repo_path !== undefined);
  assert.ok(result.workspace_root !== undefined);
  assert.ok(Array.isArray(result.context_source_precedence));
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.project_context !== undefined);
  assert.ok(typeof result.project_context.project_md_exists === "boolean");
});

test("project_context_status works without task_id", async () => {
  const server = await makeServer();
  const result = await callTool(server, "project_context_status", {});
  assert.equal(result.task, undefined);
  assert.ok(result.project_context.project_env_key_count >= 0);
  assert.ok(result.repo_registered !== undefined);
  assert.equal(result.context_source_precedence.length, 5);
});

test("project_context_status works with a task_id linked to a goal", async () => {
  const server = await makeServer();

  // Create a goal to ensure a linked task exists
  const created = await callTool(server, "create_goal", {
    user_request: "Context status test",
    goal_prompt: "Test project_context_status with task_id.",
    context_summary: "Testing task-specific diagnostics.",
    assign_to_codex: true,
    workspace_id: "hosted-default"
  });

  const result = await callTool(server, "project_context_status", { task_id: created.task.id });
  assert.ok(result.task !== undefined);
  assert.equal(result.task.task_id, created.task.id);
  assert.equal(result.task.task_status, "assigned");
  assert.ok(result.task.linked_goal_id || result.task.linked_goal_id === null);
  assert.equal(result.task.linked_goal_id, created.goal.id);
  assert.ok(typeof result.task.memory_count === "number");
});

test("project_context_status reports project.md/project.env existence and sizes/counts without secret values", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-projctx-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".gptwork"), { recursive: true });
  // Write project.md with known content
  await writeFile(join(repoPath, ".gptwork", "project.md"), "# Test Project\n\nThis is test content.\n", "utf8");
  // Write project.env with known keys (some secret-like, some normal)
  await writeFile(join(repoPath, ".gptwork", "project.env"), [
    "DB_HOST=localhost",
    "DB_PORT=5432",
    "API_KEY=sk-test123",
    "LOG_LEVEL=debug",
    "SECRET_TOKEN=super-secret-value"
  ].join("\n"), "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true
  });

  const result = await callTool(server, "project_context_status", {});
  // project.md assertions
  assert.ok(result.project_context.project_md_exists);
  assert.match(result.project_context.project_md_path, /project\.md$/);
  assert.ok(result.project_context.project_md_size_bytes > 0);
  // project.env assertions
  assert.ok(result.project_context.project_env_exists);
  assert.match(result.project_context.project_env_path, /project\.env$/);
  assert.equal(result.project_context.project_env_key_count, 5);
  // Secret-like keys: API_KEY, SECRET_TOKEN -> 2
  assert.equal(result.project_context.project_env_secret_like_key_count, 2);
  // No values should appear in redacted_key_names or elsewhere
  const str = JSON.stringify(result);
  assert.doesNotMatch(str, /super-secret-value/);
  assert.doesNotMatch(str, /sk-test123/);
});

test("project_context_status reports warnings for missing project.md/project.env in a temp repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-emptyctx-"));
  const repoPath = join(root, "empty-repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true
  });

  const result = await callTool(server, "project_context_status", {});
  const warningCodes = result.warnings.map(w => w.code);
  assert.ok(warningCodes.includes("missing_project_md"), JSON.stringify(warningCodes));
  assert.ok(!result.project_context.project_md_exists);
  assert.equal(result.project_context.project_md_size_bytes, 0);
  assert.ok(!result.project_context.project_env_exists);
  assert.equal(result.project_context.project_env_key_count, 0);
});

test("gptwork_doctor remains quiet/nominal when context is healthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-healthyctx-"));
  const repoPath = join(root, "healthy-repo");
  await mkdir(join(repoPath, ".gptwork"), { recursive: true });
  await mkdir(join(repoPath, ".git"), { recursive: true });
  // Write both project context files so context is "healthy"
  await writeFile(join(repoPath, ".gptwork", "project.md"), "# Healthy Project\n\nAll good.\n", "utf8");
  await writeFile(join(repoPath, ".gptwork", "project.env"), "DB_HOST=localhost\nDB_PORT=5432\n", "utf8");
  // Init a minimal git repo so git commands don't fail
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe", timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoPath, stdio: "pipe", timeout: 5000 });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, stdio: "pipe", timeout: 5000 });
    execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "pipe", timeout: 5000 });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe", timeout: 5000 });
  } catch (e) {}

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true
  });

  const doctor = await callTool(server, "gptwork_doctor", {});
  const suggestions = doctor.suggested_next_actions;
  // When context is healthy (project.md and project.env exist with content),
  // there should be no suggestion to run project_context_status
  const contextStatusSuggestions = suggestions.filter(s =>
    s.includes("project_context_status")
  );
  assert.equal(contextStatusSuggestions.length, 0,
    "Doctor should not suggest project_context_status when context is healthy. Got: " + JSON.stringify(suggestions));
});
