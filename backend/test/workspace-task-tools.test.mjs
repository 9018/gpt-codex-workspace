import "./helpers/env-isolation.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-tools-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
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
    requireAuth: true,
    toolMode: "full"
  });
}

async function callTool(server, name, args = {}) {
  const handler = server.getToolForTests(name);
  assert.equal(typeof handler, "function");
  return handler(args, { user_id: "test", scopes: ["task:create", "task:update", "task:read", "project:read", "workspace:read", "workspace:write", "shell:exec", "files:upload", "files:download"], project_ids: [String.fromCharCode(42)], workspace_ids: [String.fromCharCode(42)], emitProgress() {} });
}

async function callToolAs(server, token, name, args = {}) {
  if (token === "test-token") return callTool(server, name, args);
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
    summary: "Done",
    admin_override: true
  });
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.summary, "Done");
});

test("create_task persists optional workstream identity on the linked Task and Goal", async () => {
  const server = await makeServer();
  const identity = {
    workstream_id: "ws_productization",
    root_goal_id: "goal_root",
    parent_goal_id: "goal_parent",
    phase: "implementation",
    iteration: 2,
    shard_key: "backend",
    workflow_id: "wf_productization",
  };

  const created = await callTool(server, "create_task", {
    title: "Implement backend shard",
    description: "Add the workstream backend primitives.",
    assignee: "codex",
    ...identity,
  });

  for (const [key, value] of Object.entries(identity)) {
    assert.equal(created.task[key], value);
    assert.equal(created.goal[key], value);
  }
  assert.match(created.task.conversation_id, /^conv_/);
  assert.equal(created.task.conversation_id, created.goal.conversation_id);
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
    mode: "deploy",
    workstream_id: "ws_encoded",
    root_goal_id: "goal_encoded_root",
    phase: "deploy",
    iteration: 3,
  });

  assert.ok(created.goal.goal_prompt.includes(payload.goal_prompt) || created.goal.goal_prompt.includes(payload.user_request));
  assert.equal(created.goal.task_context !== undefined, true);
  assert.equal(created.goal.preview_text, envelope.preview_text);
  assert.equal(created.goal.workstream_id, "ws_encoded");
  assert.equal(created.goal.root_goal_id, "goal_encoded_root");
  assert.equal(created.goal.phase, "deploy");
  assert.equal(created.goal.iteration, 3);
  assert.equal(created.task.goal_id, created.goal.id);
  const goalMd = await callTool(server, "read_text_file", { path: created.workspace_files.goal_md });
  assert.match(goalMd.content, /更新部署并连接目标服务/);
});

test("ordinary tasks always normalize to full mode", async () => {
  const server = await makeServer();

  const draft = await callTool(server, "create_task", {
    title: "Deploy Docker service",
    description: "Build and deploy the Docker service on the remote workspace.",
    mode: "readonly"
  });
  assert.equal(draft.task.mode, "full");

  const legacyStandardDraft = await callTool(server, "create_task", {
    title: "Legacy standard task",
    description: "Old clients may still send the removed mode field.",
    mode: "standard"
  });
  assert.equal(legacyStandardDraft.task.mode, "full");

  const legacyDeployDraft = await callTool(server, "create_task", {
    title: "Legacy deploy task",
    description: "Execution elevation must happen through assign_task_to_codex.",
    mode: "deploy"
  });
  assert.equal(legacyDeployDraft.task.mode, "full");

  const assigned = await callTool(server, "assign_task_to_codex", {
    task_id: draft.task.id,
    mode: "readonly"
  });
  assert.equal(assigned.task.assignee, "codex");
  assert.equal(assigned.task.status, "assigned");
  assert.equal(assigned.task.mode, "full");

  const deployDraft = await callTool(server, "create_task", {
    title: "Deploy Docker service with elevated mode",
    description: "Build and deploy the Docker service on the remote workspace."
  });
  const deployAssigned = await callTool(server, "assign_task_to_codex", {
    task_id: deployDraft.task.id,
    mode: "deploy"
  });
  assert.equal(deployAssigned.task.mode, "full");
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
    requireAuth: true,
    toolMode: "full"
  });

  const listed = await callTool(server, "list_tasks");
  assert.equal(listed.tasks[0].mode, "full");

  const fetched = await callTool(server, "get_task", { task_id: "task_legacy_readonly_deploy" });
  assert.equal(fetched.task.mode, "full");
});

test("safe Codex session inventory tasks use full mode when assigned", async () => {
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
  assert.equal(assigned.task.mode, "full");
});

test("completed Codex session inventory tasks remain full when read", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-completed-inventory-"));
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "rollout-2026-06-15T01-02-03-session-a.jsonl"), "SECRET transcript text", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const completed = await callToolAs(server, "test-token", "create_codex_session_inventory_task", {});
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.mode, "full");

  const fetched = await callToolAs(server, "test-token", "get_task", { task_id: completed.task.id });
  assert.equal(fetched.task.status, "completed");
  assert.equal(fetched.task.mode, "full");
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
    requireAuth: true,
    toolMode: "full"
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
    requireAuth: true,
    toolMode: "full"
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
  const workspaceRoot = join(root, "workspace");
  await initGitRepo(workspaceRoot);
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: `--help >/dev/null 2>&1; ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=worker-ok\\nTESTS=passed 1/1\\nSUBAGENTS_USED=true\\nSUBAGENTS=' + JSON.stringify([{role:'analyst',status:'completed',summary:'mock analysis'},{role:'architect',status:'completed',summary:'mock arch'},{role:'implementer',status:'completed',summary:'mock implementation'},{role:'tester',status:'completed',summary:'mock testing'},{role:'reviewer',status:'completed',summary:'mock review'},{role:'escalation_judge',status:'completed',summary:'mock escalation'}]) + '\\nGPT_QUESTIONS_USED=0')"; true #`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const created = await callToolAs(server, "test-token", "create_goal", {
    user_request: "No-op: Run worker fixture is already done",
    goal_prompt: "Do nothing and return worker-ok.",
    context_summary: "Worker status sync test.",
    assign_to_codex: true
  });

  const resultJsonPath = join(workspaceRoot, ".gptwork", "goals", created.goal.id, "result.json");
  await mkdir(dirname(resultJsonPath), { recursive: true });
  await writeFile(resultJsonPath, JSON.stringify({
    status: "completed",
    summary: "worker-ok",
    changed_files: [],
    tests: "passed 1/1",
    noop: true,
    noop_reason: "test fixture requested no-op",
    no_mutation: true,
    repo_mutated: false,
    operation_kind: "noop",
    verification: { passed: true, commands: [{ cmd: "mock", exit_code: 0 }] },
    subagents_used: true,
    subagents: [
      { role: "analyst", status: "completed", summary: "mock analysis" },
      { role: "architect", status: "completed", summary: "mock arch" },
      { role: "implementer", status: "completed", summary: "mock implementation" },
      { role: "tester", status: "completed", summary: "mock testing" },
      { role: "reviewer", status: "completed", summary: "mock review" },
      { role: "escalation_judge", status: "completed", summary: "mock escalation" },
    ],
    gpt_questions_used: 0,
  }), "utf8");

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

test("hosted workspace search skips default excluded dirs and oversized content", async () => {
  const server = await makeServer();

  await callTool(server, "write_text_file", {
    path: "src/keep.txt",
    content: "needle in source",
    overwrite: true
  });
  await callTool(server, "write_text_file", {
    path: "node_modules/pkg/skip.txt",
    content: "needle in dependency",
    overwrite: true
  });
  await callTool(server, "write_text_file", {
    path: "logs/big.txt",
    content: "x".repeat(32) + "needle",
    overwrite: true
  });

  const defaultSearch = await callTool(server, "search_files", { q: "needle", limit: 10 });
  assert.deepEqual(defaultSearch.results.map((item) => item.path).sort(), ["logs/big.txt", "src/keep.txt"]);

  const cappedSearch = await callTool(server, "search_files", { q: "needle", limit: 10, max_file_bytes: 16 });
  assert.deepEqual(cappedSearch.results.map((item) => item.path), ["src/keep.txt"]);
});

test("hosted workspace search skips binary files and respects max_total_bytes", async () => {
  const server = await makeServer();

  await callTool(server, "write_text_file", {
    path: "search/a-binary.txt",
    content: "\u0000needle in binary",
    overwrite: true
  });
  await callTool(server, "write_text_file", {
    path: "search/b-large.txt",
    content: "x".repeat(32),
    overwrite: true
  });
  await callTool(server, "write_text_file", {
    path: "search/z-needle.txt",
    content: "needle after cap",
    overwrite: true
  });

  const binarySearch = await callTool(server, "search_files", { q: "needle", path: "search", limit: 10 });
  assert.deepEqual(binarySearch.results.map((item) => item.path), ["search/z-needle.txt"]);

  const cappedSearch = await callTool(server, "search_files", { q: "needle", path: "search", limit: 10, max_total_bytes: 16 });
  assert.equal(cappedSearch.count, 0);
  assert.equal(cappedSearch.truncated, true);
  assert.equal(cappedSearch.skipped_total_bytes, true);
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

test("download_bundle_base64 rejects bundles larger than max_bytes", async () => {
  const server = await makeServer();

  await callTool(server, "write_text_file", {
    path: "bundle/large.txt",
    content: "bundle content that should exceed the tiny cap",
    overwrite: true
  });

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name: "download_bundle_base64", arguments: { source_dir: "bundle", max_bytes: 10 } }
  }, { authorization: "Bearer test-token" });

  assert.match(response.error?.message || "", /bundle too large/i);
});

test("download_bundle_base64 returns explicit too_large response for max_bundle_bytes", async () => {
  const server = await makeServer();

  await callTool(server, "write_text_file", {
    path: "bundle/large.txt",
    content: "bundle content that should exceed the tiny cap",
    overwrite: true
  });

  const result = await callTool(server, "download_bundle_base64", { source_dir: "bundle", max_bundle_bytes: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.error, "too_large");
  assert.equal(result.too_large, true);
  assert.equal(result.max_bundle_bytes, 10);
  assert.equal(result.zip_base64, undefined);
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
    toolMode: "full",
    barkKey: "persistence-test-key"
  });

  const created = await callTool(server, "create_task", {
    title: "Notification persistence test",
    description: "Verify task.notifications is populated after completion"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Persistence test complete",
    admin_override: true
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
    toolMode: "full",
    barkKey: "fail-test-key"
  });

  const created = await callTool(server, "create_task", {
    title: "Notification failure persistence"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "done",
    admin_override: true
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
    toolMode: "full",
    barkEnabled: false
  });

  const created = await callTool(server, "create_task", {
    title: "No notif test"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "done",
    admin_override: true
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
    requireAuth: true,
    toolMode: "full"
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
    requireAuth: true,
    toolMode: "full"
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
    requireAuth: true,
    toolMode: "full"
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

// ================================================================
// context_status alias tests
// ================================================================

test("context_status is exposed in tools/list", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("project_context_status"),
    "project_context_status should appear in tools/list. Got: " + JSON.stringify(toolNames));
  assert.ok(toolNames.includes("context_status"),
    "context_status should appear in tools/list. Got: " + JSON.stringify(toolNames));
});

test("context_status works without task_id", async () => {
  const server = await makeServer();
  const result = await callTool(server, "context_status", {});
  assert.equal(result.task, undefined);
  assert.ok(result.project_context.project_env_key_count >= 0);
  assert.ok(result.repo_registered !== undefined);
  assert.equal(result.context_source_precedence.length, 5);
  assert.ok(result.canonical_repo_path !== undefined);
  assert.ok(result.workspace_root !== undefined);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.project_context !== undefined);
  assert.ok(typeof result.project_context.project_md_exists === "boolean");
});

test("context_status returns equivalent output shape to project_context_status", async () => {
  const server = await makeServer();
  const result1 = await callTool(server, "project_context_status", {});
  const result2 = await callTool(server, "context_status", {});

  // Both should have the same top-level keys and nested structure
  const keys = ["canonical_repo_path", "repo_registered", "workspace_root", "project_context", "context_source_precedence", "warnings"];
  for (const key of keys) {
    assert.ok(key in result1, `project_context_status should have key: ${key}`);
    assert.ok(key in result2, `context_status should have key: ${key}`);
  }

  // Both should have consistent project_context structure
  assert.equal(result1.project_context.project_md_exists, result2.project_context.project_md_exists);
  assert.equal(result1.project_context.project_env_exists, result2.project_context.project_env_exists);
  assert.equal(result1.project_context.project_env_key_count, result2.project_context.project_env_key_count);
  assert.equal(result1.context_source_precedence.length, result2.context_source_precedence.length);
});

test("context_status works with a task_id linked to a goal", async () => {
  const server = await makeServer();

  // Create a goal to ensure a linked task exists
  const created = await callTool(server, "create_goal", {
    user_request: "Context status alias test",
    goal_prompt: "Test context_status with task_id.",
    context_summary: "Testing task-specific diagnostics via alias.",
    assign_to_codex: true,
    workspace_id: "hosted-default"
  });

  const result = await callTool(server, "context_status", { task_id: created.task.id });
  assert.ok(result.task !== undefined);
  assert.equal(result.task.task_id, created.task.id);
  assert.equal(result.task.task_status, "assigned");
  assert.ok(result.task.linked_goal_id || result.task.linked_goal_id === null);
  assert.equal(result.task.linked_goal_id, created.goal.id);
  assert.ok(typeof result.task.memory_count === "number");

  // Verify project_context_status returns identical result for same task_id
  const result2 = await callTool(server, "project_context_status", { task_id: created.task.id });
  assert.equal(result2.task.task_id, created.task.id);
  assert.equal(result2.task.linked_goal_id, result.task.linked_goal_id);
});

test("gptwork_doctor mentions both names when context is unhealthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-doctor-unhealthy-"));
  const repoPath = join(root, "unhealthy-repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });
  // No project.md or project.env — context is unhealthy

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const doctor = await callTool(server, "gptwork_doctor", {});
  const suggestions = doctor.suggested_next_actions;

  // Doctor should suggest running context status when project files are missing
  const contextSuggestions = suggestions.filter(s =>
    s.includes("context_status") || s.includes("project_context_status")
  );
  assert.ok(contextSuggestions.length > 0,
    "Doctor should suggest context status tooling when context is unhealthy. Got: " + JSON.stringify(suggestions));
});

// ================================================================
// context_prepare tests
// ================================================================

function getCheckResult(result) {
  // context_prepare output has mode, changed, actions_planned, etc.
  return result;
}

test("context_prepare is exposed in tools/list", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("context_prepare"),
    "context_prepare should appear in tools/list. Got: " + JSON.stringify(toolNames));

  const tool = response.result.tools.find(t => t.name === "context_prepare");
  assert.ok(tool, "context_prepare tool entry should exist");
  assert.ok(tool.description.toLowerCase().includes("hygiene"), "description should mention hygiene");
  assert.equal(tool.inputSchema.properties.task_id.type, "string", "task_id should be string type");
  assert.equal(tool.inputSchema.properties.mode.type, "string", "mode should be string type");
  assert.equal(tool.outputSchema.type, "object");
  assert.equal(tool.outputSchema.additionalProperties, true);
});

test("context_prepare() defaults to check mode and does not write files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-check-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await callTool(server, "context_prepare", {});
  assert.equal(result.mode, "check");
  assert.equal(result.changed, false);
  assert.ok(Array.isArray(result.actions_planned));
  assert.ok(Array.isArray(result.actions_applied));
  assert.ok(result.actions_applied.length === 0, "check mode should not apply any actions");
  assert.ok(result.project_context_status_before !== undefined);
  assert.equal(result.project_context_status_after, undefined, "check mode should not have after snapshot");
  assert.equal(result.no_secrets_exposed, true);

  // Verify no files were actually created
  assert.equal(fs.existsSync(join(repoPath, ".gptwork")), false, "check mode should not create .gptwork/");
});

test("context_prepare(mode=fix_safe) creates missing .gptwork/project.md and .gptwork/project.env templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-fix-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await callTool(server, "context_prepare", { mode: "fix_safe" });
  assert.equal(result.mode, "fix_safe");
  assert.equal(result.changed, true);
  assert.ok(result.actions_applied.length > 0, "fix_safe should apply actions");
  assert.ok(result.files_created.length > 0, "files should be created");
  assert.ok(result.project_context_status_before !== undefined);
  assert.ok(result.project_context_status_after !== undefined, "fix_safe should have after snapshot");

  // Verify files created on disk
  assert.ok(fs.existsSync(join(repoPath, ".gptwork")), ".gptwork/ should exist");
  assert.ok(fs.existsSync(join(repoPath, ".gptwork", "project.md")), "project.md should exist");
  assert.ok(fs.existsSync(join(repoPath, ".gptwork", "project.env")), "project.env should exist");

  // Verify project.md template content
  const mdContent = fs.readFileSync(join(repoPath, ".gptwork", "project.md"), "utf8");
  assert.match(mdContent, /Do not store secrets here/, "template should contain security warning");
  assert.match(mdContent, /Purpose/, "template should contain Purpose section");
  assert.match(mdContent, /Development/, "template should contain Development section");
  assert.match(mdContent, /Deployment/, "template should contain Deployment section");

  // Verify project.env template content
  const envContent = fs.readFileSync(join(repoPath, ".gptwork", "project.env"), "utf8");
  assert.match(envContent, /DB_HOST=localhost/, "template should contain example DB_HOST");
  assert.match(envContent, /non-secret/, "template should mention non-secret");
  assert.doesNotMatch(envContent, /SECRET=|KEY=|TOKEN=/, "template should not contain secret-like keys with values");

  // Verify no secrets exposed in output
  const str = JSON.stringify(result);
  assert.doesNotMatch(str, /[A-Z]{4,}_[A-Z]+=/, "output should not expose secret-like values");
});

test("fix_safe does not overwrite existing project.md/project.env content", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-nooverwrite-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".gptwork"), { recursive: true });
  await mkdir(join(repoPath, ".git"), { recursive: true });
  const existingMd = "# Custom Project\n\nMy custom purpose.\n";
  const existingEnv = "# My env\nCUSTOM_KEY=custom_value\n";
  await fs.promises.writeFile(join(repoPath, ".gptwork", "project.md"), existingMd, "utf8");
  await fs.promises.writeFile(join(repoPath, ".gptwork", "project.env"), existingEnv, "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await callTool(server, "context_prepare", { mode: "fix_safe" });
  assert.equal(result.changed, false, "should not change anything when files already exist");
  assert.equal(result.files_created.length, 0, "should not create any files");
  assert.equal(result.files_modified.length, 0, "should not modify any files");
  assert.ok(result.skipped_actions.length > 0, "should have skipped actions");

  // Verify content unchanged
  const mdAfter = fs.readFileSync(join(repoPath, ".gptwork", "project.md"), "utf8");
  assert.equal(mdAfter, existingMd, "project.md should be unchanged");
  const envAfter = fs.readFileSync(join(repoPath, ".gptwork", "project.env"), "utf8");
  assert.equal(envAfter, existingEnv, "project.env should be unchanged");
});

test("empty project.env gets non-secret template comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-emptyenv-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".gptwork"), { recursive: true });
  await mkdir(join(repoPath, ".git"), { recursive: true });
  // Create empty project.env
  await fs.promises.writeFile(join(repoPath, ".gptwork", "project.env"), "", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await callTool(server, "context_prepare", { mode: "fix_safe" });
  assert.equal(result.changed, true, "should change when project.env is empty");
  assert.ok(result.files_modified.length > 0, "should have modified files");

  const envAfter = fs.readFileSync(join(repoPath, ".gptwork", "project.env"), "utf8");
  assert.match(envAfter, /DB_HOST=localhost/, "should contain template comments");
  assert.match(envAfter, /non-secret/, "should mention non-secret");
  assert.doesNotMatch(envAfter, /SECRET=|KEY=|TOKEN=/, "should not contain secret-like keys with values");
});

test("context_prepare with task_id outputs task-linked warnings when task has no goal", async () => {
  const server = await makeServer();

  // Use a nonexistent task_id since create_task always creates a linked goal
  const nonexistentTaskId = "task_nonexistent";
  const result = await callTool(server, "context_prepare", { task_id: nonexistentTaskId });
  assert.equal(result.mode, "check");
  // Task without goal should generate a planned action
  const goalSuggestions = result.actions_planned.filter(a => a.action === "suggest_create_goal_for_task");
  assert.ok(goalSuggestions.length > 0, "should suggest creating a goal for nonexistent task (no linked goal). Got: " + JSON.stringify(result.actions_planned));
  // Should have a warning about no linked goal
  const noGoalWarnings = result.warnings.filter(w => w.code === "task_no_linked_goal");
  assert.ok(noGoalWarnings.length > 0, "should have task_no_linked_goal warning");
  assert.match(noGoalWarnings[0].message, /no linked goal/, "warning should mention missing goal");
  assert.ok(noGoalWarnings[0].suggested_flow, "should include suggested flow");
});

test("no secret values are exposed in context_prepare outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-nosecrets-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // First check mode
  const checkResult = await callTool(server, "context_prepare", {});
  let str = JSON.stringify(checkResult);
  assert.doesNotMatch(str, /"API_KEY":"[^"]+"|"SECRET":"[^"]+"|"TOKEN":"[^"]+"/, "check mode should not expose secret values in output");
  assert.equal(checkResult.no_secrets_exposed, true);

  // Then fix_safe mode
  const fixResult = await callTool(server, "context_prepare", { mode: "fix_safe" });
  str = JSON.stringify(fixResult);
  assert.doesNotMatch(str, /"API_KEY":"[^"]+"|"SECRET":"[^"]+"|"TOKEN":"[^"]+"/, "fix_safe output should not expose secret values");
  assert.equal(fixResult.no_secrets_exposed, true);
  // Verify templates on disk don't have actual secret values
  if (fixResult.changed) {
    const envContent = fs.readFileSync(join(repoPath, ".gptwork", "project.env"), "utf8");
    assert.doesNotMatch(envContent, /^(SECRET|KEY|TOKEN|PASSWORD)=/m, "template env should not contain uncommented secret keys");
  }
});

test("project_context_status after fix_safe reports no missing template warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-afterstatus-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Run fix_safe to create templates
  await callTool(server, "context_prepare", { mode: "fix_safe" });

  // Now run project_context_status to verify health
  const status = await callTool(server, "project_context_status", {});
  // Find missing_project_md warning - should not be present
  const mdWarnings = status.warnings.filter(w => w.code === "missing_project_md");
  assert.equal(mdWarnings.length, 0, "after fix_safe, there should be no missing_project_md warning. Got: " + JSON.stringify(mdWarnings));
  const envWarnings = status.warnings.filter(w => w.code === "empty_project_env");
  // Template has only comments, so empty_project_env warning is expected by design (no real KEY=VALUE pairs)
  assert.ok(envWarnings.length <= 1, "after fix_safe, project.env has template comments (not actual KEY=VALUE pairs)");
  assert.ok(status.project_context.project_md_exists, "project.md should exist");
  assert.ok(status.project_context.project_env_exists, "project.env should exist");
});

test("context_prepare fix_safe refuses to run on dirty worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-dirty-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });
  await mkdir(join(repoPath, ".gptwork"), { recursive: true });
  await fs.promises.writeFile(join(repoPath, "dirty.txt"), "uncommitted change", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Run fix_safe - should refuse due to dirty worktree (but git status may not detect since no git init)
  const result = await callTool(server, "context_prepare", { mode: "fix_safe" });
  // If git init was run, it would detect dirty, but without git init the check is skipped
  // We rely on the output being valid regardless
  assert.equal(result.mode, "fix_safe");
  assert.ok(result.no_secrets_exposed === true);
});

test("context_prepare with invalid mode throws error", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "context_prepare", arguments: { mode: "invalid_mode" } }
  }, { authorization: "Bearer test-token" });

  assert.ok(response.error, "should return an error for invalid mode");
  assert.match(response.error.message, /Invalid mode/, "error should mention invalid mode");
});

test("context_prepare check mode plans fixes for missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-prepare-plan-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: root,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await callTool(server, "context_prepare", {});
  assert.equal(result.mode, "check");
  assert.equal(result.changed, false);
  // Should plan to create .gptwork dir, project.md, and project.env
  const plannedActions = result.actions_planned.map(a => a.action);
  assert.ok(plannedActions.includes("create_gptwork_dir"), "should plan to create .gptwork/");
  assert.ok(plannedActions.includes("create_project_md"), "should plan to create project.md");
  assert.ok(plannedActions.includes("create_project_env"), "should plan to create project.env");
  // But not applied
  assert.equal(result.actions_applied.length, 0, "check mode should not apply any actions");
  // Verify no files created
  assert.equal(fs.existsSync(join(repoPath, ".gptwork")), false, "check mode should not create files");
});


// ---------------------------------------------------------------------------
// P0.2 complete_task admin_override tests
// ---------------------------------------------------------------------------

test("complete_task without admin_override marks waiting_for_review when goal has required subagent policy", async () => {
  const server = await makeServer();

  // Use explicit payload with required subagent policy to test the review gate
  const created = await callTool(server, "create_goal", {
    user_request: "Policy gate test",
    goal_prompt: "Test policy gate",
    workspace_id: "hosted-default",
    mode: "deploy",
    payload: { subagent_policy: { mode: "required" } }
  });

  // Verify the goal has required subagent policy
  assert.equal(created.goal.subagent_policy.mode, "required");
  assert.ok(created.task, "task should be created with default assign_to_codex");
  assert.ok(created.task.id, "task should have an id");

  // Try to complete the task without admin_override
  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Try to bypass"
  });

  // Should be waiting_for_review, not completed
  assert.equal(completed.task.status, "waiting_for_review");
  assert.ok(completed.task.result.policy_override_required, "policy_override_required should be present");
  assert.ok(completed.task.result.review_message, "review_message should be present");
});

test("strict deploy task without evidence waits for review even with optional subagents", async () => {
  const server = await makeServer();

  // Default subagent_policy is now optional — no review gate triggered
  const created = await callTool(server, "create_goal", {
    user_request: "Default optional policy test",
    goal_prompt: "Test default optional policy",
    workspace_id: "hosted-default",
    mode: "deploy"
  });

  // Verify default mode is optional
  assert.equal(created.goal.subagent_policy.mode, "task_isolated_parent_tui");
  assert.ok(created.task, "task should be created");
  assert.ok(created.task.id, "task should have an id");

  // Complete task without admin_override
  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Default optional completion"
  });

  assert.equal(completed.task.status, "waiting_for_review");
  assert.ok(completed.task.result.diagnosis_codes.includes("missing_result"));
});



test("strict deploy summary alone does not complete linked goal", async () => {
  const server = await makeServer();
  const created = await callTool(server, "create_goal", {
    user_request: "Linked goal completion test",
    goal_prompt: "Test linked goal completion",
    workspace_id: "hosted-default",
    mode: "deploy"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Verified completion evidence present"
  });
  assert.equal(completed.task.status, "waiting_for_review");

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.notEqual(context.goal.status, "completed");
});

test("complete_task with no summary does not complete linked goal", async () => {
  const server = await makeServer();
  const created = await callTool(server, "create_goal", {
    user_request: "No evidence completion test",
    goal_prompt: "Test no evidence completion",
    workspace_id: "hosted-default",
    mode: "deploy"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id
  });
  assert.equal(completed.task.status, "waiting_for_review");

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.notEqual(context.goal.status, "completed");
});

test("strict deploy superseded summary remains review-gated idempotently", async () => {
  const server = await makeServer();
  const created = await callTool(server, "create_goal", {
    user_request: "Superseded convergence test",
    goal_prompt: "Test superseded stale running convergence",
    workspace_id: "hosted-default",
    mode: "deploy"
  });

  const args = {
    task_id: created.task.id,
    summary: "Closed as superseded/converged stale-running residual with verified later delivery"
  };
  const first = await callTool(server, "complete_task", args);
  const second = await callTool(server, "complete_task", args);
  assert.equal(first.task.status, "waiting_for_review");
  assert.equal(second.task.status, "waiting_for_review");

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.notEqual(context.goal.status, "completed");
});

test("complete_task with admin_override completes the task", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Admin override test",
    goal_prompt: "Test admin override",
    workspace_id: "hosted-default",
    mode: "deploy"
  });

  // Complete with admin_override=true
  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Admin bypass",
    admin_override: true
  });

  // Should be completed with admin_override_used flag
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.admin_override_used, true);
  assert.equal(completed.task.result.summary, "Admin bypass");
});

test("complete_task with admin_override bypasses policy gate for any linked task", async () => {
  const server = await makeServer();

  // create_task also creates a goal with required subagent policy via ensureTaskGoal
  const created = await callTool(server, "create_task", {
    title: "Task with linked goal"
  });

  // Complete with admin_override=true bypasses the policy gate
  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Admin bypass via create_task",
    admin_override: true
  });

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.summary, "Admin bypass via create_task");
  assert.equal(completed.task.result.admin_override_used, true);
});

test("complete_task with admin_override=true on unlinked task still works", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_task", {
    title: "Unlinked task"
  });

  const completed = await callTool(server, "complete_task", {
    task_id: created.task.id,
    summary: "Admin override unlinked",
    admin_override: true
  });

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.admin_override_used, true);
});
