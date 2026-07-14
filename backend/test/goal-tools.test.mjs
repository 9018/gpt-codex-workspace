import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-goals-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });
}

async function callTool(server, name, args = {}) {
  const handler = server.getToolForTests(name);
  assert.equal(typeof handler, "function");
  return handler(args, { user_id: "test", scopes: ["task:create", "task:update", "task:read", "project:read", "workspace:read", "workspace:write"], project_ids: [String.fromCharCode(42)], workspace_ids: [String.fromCharCode(42)], emitProgress() {} });
}

test("ChatGPT can create a Codex goal with shared conversation memory and linked task", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "部署 Docker 服务并返回端口和验证结果",
    goal_prompt: "Goal: Deploy the Docker service. Preserve context, verify the container, report ports and logs, and do not expose secrets.",
    context_summary: "用户希望 GPTChat 把自然语言需求整理成 Codex 可执行 goal，并保留共享上下文。",
    workspace_id: "hosted-default",
    mode: "deploy",
    assign_to_codex: true,
    messages: [
      { role: "user", content: "部署 Docker 服务" },
      { role: "assistant", content: "我会创建 deploy goal 并分配给 Codex。" }
    ],
    memories: [
      { key: "routing", value: "Public MCP is https://mcp.gptwork.cc.cd/mcp/dev-token" }
    ]
  });

  assert.match(created.goal.id, /^goal_/);
  assert.equal(created.goal.status, "assigned");
  assert.equal(created.goal.assignee, "codex");
  assert.equal(created.goal.mode, "full");
  assert.equal(created.goal.workspace_id, "hosted-default");
  assert.equal(created.goal.user_request, "部署 Docker 服务并返回端口和验证结果");
  assert.ok(created.goal.goal_prompt.trim().length > 0);
  assert.match(created.goal.goal_prompt, /Deploy|Docker|部署/i);
  assert.match(created.goal.context_summary, /Objective:/);
  assert.doesNotMatch(created.goal.context_summary, /GPTChat 把自然语言需求整理/);
  assert.equal(created.conversation.id, created.goal.conversation_id);
  assert.equal(created.conversation.messages.length, 2);
  assert.equal(created.memories[0].goal_id, created.goal.id);
  assert.equal(created.memories[0].key, "routing");
  assert.equal(created.task.goal_id, created.goal.id);
  assert.equal(created.task.conversation_id, created.conversation.id);
  assert.equal(created.task.assignee, "codex");
  assert.equal(created.task.status, "assigned");
  assert.equal(created.task.mode, "full");
  assert.match(created.task.description, /Goal ID:/);
  assert.match(created.task.description, /Goal Prompt:/);

  const listed = await callTool(server, "list_goals", { assignee: "codex", status: "assigned" });
  assert.equal(listed.goals.length, 1);
  assert.equal(listed.goals[0].id, created.goal.id);

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.equal(context.goal.id, created.goal.id);
  assert.equal(context.task.id, created.task.id);
  assert.equal(context.conversation.messages[0].role, "user");
  assert.equal(context.memories[0].value, "Public MCP is https://mcp.gptwork.cc.cd/mcp/dev-token");
  assert.match(context.workspace_files.goal_md, /^\.gptwork\/goals\/goal_/);
  const goalMd = await callTool(server, "read_text_file", { path: context.workspace_files.goal_md });
  assert.match(goalMd.content, /## Goal Prompt/);
});



test("explicit task context packet is the execution authority", async () => {
  const server = await makeServer();
  const packet = {
    schema_version: "gptwork.task_context.v1",
    identity: {
      workstream_id: "ws_authority",
      goal_id: null,
      task_id: null,
      context_revision: 1
    },
    objective: "Implement the compiled objective only",
    background: ["Compiled background"],
    confirmed_findings: [],
    scope: { include: ["backend/src/**"], exclude: ["frontend/**"] },
    required_changes: ["Use the structured packet"],
    acceptance_criteria: [
      { id: "compiled_ac", description: "Compiled acceptance passes", blocking: true, verification_hint: null }
    ],
    constraints: ["Do not use raw process chatter"],
    open_questions: [],
    carry_forward: [],
    source_provenance: [],
    raw_conversation_policy: {
      stored: true,
      indexed: false,
      injected: false,
      targeted_lookup_allowed: true
    }
  };

  const created = await callTool(server, "create_goal", {
    user_request: "raw user request",
    goal_prompt: "RAW PROCESS CHATTER SHOULD NOT EXECUTE",
    context_summary: "RAW SUMMARY SHOULD NOT EXECUTE",
    workstream_id: "ws_authority",
    task_context_packet: packet,
    assign_to_codex: true
  });

  assert.equal(created.goal.user_request, packet.objective);
  assert.match(created.goal.goal_prompt, /Implement the compiled objective only/);
  assert.doesNotMatch(created.goal.goal_prompt, /RAW PROCESS CHATTER/);
  assert.match(created.goal.context_summary, /Background: 1 items/);
  assert.doesNotMatch(created.goal.context_summary, /RAW SUMMARY/);
  assert.equal(created.goal.task_context.contract_digest, created.task.task_context_digest);
  assert.equal(created.workspace_files.task_context_json, `.gptwork/goals/${created.goal.id}/task.context.json`);
  const storedPacket = await callTool(server, "read_text_file", { path: created.workspace_files.task_context_json });
  const parsedPacket = JSON.parse(storedPacket.content);
  assert.equal(parsedPacket.identity.goal_id, created.goal.id);
  assert.equal(parsedPacket.identity.task_id, created.task.id);
  assert.equal(parsedPacket.objective, packet.objective);
  const storedDigest = await callTool(server, "read_text_file", { path: `.gptwork/goals/${created.goal.id}/task.context.digest` });
  assert.equal(storedDigest.content.trim(), created.task.task_context_digest);
  const preview = await callTool(server, "preview_codex_context", { task_id: created.task.id });
  assert.equal(preview.context_v2.task_context.present, true);
  assert.equal(preview.context_v2.task_context.objective, packet.objective);
});

test("invalid explicit task context packet blocks goal creation", async () => {
  const server = await makeServer();

  await assert.rejects(
    callTool(server, "create_goal", {
      user_request: "raw request",
      goal_prompt: "raw prompt",
      task_context_packet: {
        schema_version: "gptwork.task_context.v1",
        identity: { workstream_id: "ws_bad", goal_id: null, task_id: null, context_revision: 1 },
        objective: "",
        background: [],
        confirmed_findings: [],
        scope: { include: [], exclude: [] },
        required_changes: [],
        acceptance_criteria: [],
        constraints: [],
        open_questions: [],
        carry_forward: [],
        source_provenance: [],
        raw_conversation_policy: {
          stored: true,
          indexed: false,
          injected: false,
          targeted_lookup_allowed: true
        }
      }
    }),
    /task_context_packet/
  );
});

test("ChatGPT can create an encoded goal and the backend writes readable workspace context files", async () => {
  const server = await makeServer();
  const preview = "我理解你的需求是：部署新版本并验证服务状态。";
  const payload = {
    user_request: "部署新版本到测试环境",
    goal_prompt: "部署新版本到测试环境，完成后验证端口、日志和健康检查。",
    context_summary: "GPTChat translated the user request before base64 transport.",
    mode: "deploy",
    workspace_id: "hosted-default",
    messages: [
      { role: "user", content: "部署新版本到测试环境" }
    ],
    memories: [{ key: "env", value: "test" }]
  };

  const created = await callTool(server, "create_encoded_goal", {
    preview_text: preview,
    payload_base64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    assign_to_codex: true
  });

  assert.equal(created.goal.user_request, payload.user_request);
  assert.ok(created.goal.goal_prompt.includes(payload.user_request));
  assert.equal(created.goal.preview_text, preview);
  assert.equal(created.task.assignee, "codex");
  assert.equal(created.workspace_files.goal_md, `.gptwork/goals/${created.goal.id}/goal.md`);
  assert.equal(created.workspace_files.result_md, `.gptwork/goals/${created.goal.id}/result.md`);
  assert.equal(created.workspace_files.payload_json, undefined);
  assert.equal(created.workspace_files.payload_base64, undefined);
  assert.equal(created.workspace_files.bundle_zip, undefined);
  assert.equal(created.workspace_files.attachments_dir, undefined);
  assert.equal(created.internal_files.payload_json, `.gptwork/goals/${created.goal.id}/payload.json`);

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.equal(context.workspace_files.payload_json, `.gptwork/goals/${created.goal.id}/payload.json`);
  assert.match(context.codex_instruction, /Read \.gptwork\/goals\//);
  assert.equal(context.conversation.messages.at(-1).content, payload.user_request);
  const payloadJson = await callTool(server, "read_text_file", { path: context.workspace_files.payload_json });
  assert.match(payloadJson.content, /部署新版本到测试环境/);
});

test("create_encoded_goal can wait briefly and returns execution status without a second task lookup", async () => {
  const server = await makeServer();
  const payload = {
    user_request: "Run a short Codex goal",
    goal_prompt: "Write a concise result.",
    context_summary: "Testing immediate status shape.",
    workspace_id: "hosted-default"
  };

  const created = await callTool(server, "create_encoded_goal", {
    preview_text: "I will run a short Codex goal.",
    payload_base64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    assign_to_codex: true,
    wait_ms: 1
  });

  assert.equal(created.execution.status, "assigned");
  assert.equal(created.execution.task.id, created.task.id);
  assert.equal(created.execution.result, null);
  assert.ok(Array.isArray(created.execution.messages_tail));
});

test("Codex can append progress to the shared goal conversation", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "修复 MCP 插件安装问题",
    goal_prompt: "Goal: Fix the Codex MCP plugin installer path and verify Codex can read this goal context.",
    context_summary: "Codex 插件需要能看到 GPTChat 创建的 goal。",
    assign_to_codex: true
  });

  const appended = await callTool(server, "append_goal_message", {
    goal_id: created.goal.id,
    role: "codex",
    content: "已读取 goal context，开始检查插件 MCP 代理。",
    memory_key: "codex_progress",
    memory_value: "Codex started plugin MCP proxy inspection."
  });

  assert.equal(appended.message.role, "codex");
  assert.match(appended.message.content, /开始检查插件/);
  assert.equal(appended.memory.key, "codex_progress");

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.equal(context.conversation.messages.at(-1).role, "codex");
  assert.equal(context.memories.at(-1).value, "Codex started plugin MCP proxy inspection.");
  assert.equal(context.workspace_files.transcript_md, `.gptwork/goals/${created.goal.id}/transcript.md`);
});

test("append_goal_message refreshes context files without overwriting result.md", async () => {
  const server = await makeServer();
  const created = await callTool(server, "create_goal", {
    user_request: "Preserve final result",
    goal_prompt: "Write a result and then append progress.",
    assign_to_codex: true
  });

  await callTool(server, "write_text_file", {
    path: created.workspace_files.result_md,
    content: "# Result\n\nFinal summary stays here.\n",
    overwrite: true
  });
  await callTool(server, "append_goal_message", {
    goal_id: created.goal.id,
    role: "codex",
    content: "Progress appended after result was written."
  });

  const resultMd = await callTool(server, "read_text_file", { path: created.workspace_files.result_md });
  assert.match(resultMd.content, /Final summary stays here/);
  assert.doesNotMatch(resultMd.content, /Pending/);
});

test("legacy readonly goals and linked ordinary tasks are promoted when read", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-legacy-goals-"));
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
    goals: [{
      id: "goal_legacy_readonly",
      project_id: "default",
      workspace_id: "hosted-default",
      conversation_id: "conv_legacy_readonly",
      task_id: "task_legacy_goal_readonly",
      user_request: "Deploy Docker service",
      goal_prompt: "Deploy Docker service and verify it is running.",
      context_summary: "Legacy goal created before readonly promotion.",
      title: "Deploy Docker service",
      created_by: "user_default",
      assignee: "codex",
      status: "assigned",
      mode: "readonly",
      created_at: now,
      updated_at: now
    }],
    conversations: [{
      id: "conv_legacy_readonly",
      goal_id: "goal_legacy_readonly",
      project_id: "default",
      workspace_id: "hosted-default",
      messages: [],
      created_at: now,
      updated_at: now
    }],
    memories: [],
    tasks: [{
      id: "task_legacy_goal_readonly",
      project_id: "default",
      workspace_id: "hosted-default",
      goal_id: "goal_legacy_readonly",
      conversation_id: "conv_legacy_readonly",
      title: "Deploy Docker service",
      description: "Deploy Docker service and verify it is running.",
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
    chatgpt_requests: [],
    activities: [],
    audit: []
  }, null, 2), "utf8");

  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const listed = await callTool(server, "list_goals", { assignee: "codex" });
  assert.equal(listed.goals[0].mode, "full");

  const context = await callTool(server, "get_goal_context", { goal_id: "goal_legacy_readonly" });
  assert.equal(context.goal.mode, "full");
  assert.equal(context.task.mode, "full");
});
