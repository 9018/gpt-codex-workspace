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
    requireAuth: true
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
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
  assert.equal(created.goal.mode, "deploy");
  assert.equal(created.goal.workspace_id, "hosted-default");
  assert.equal(created.goal.user_request, "部署 Docker 服务并返回端口和验证结果");
  assert.match(created.goal.goal_prompt, /Deploy the Docker service/);
  assert.match(created.goal.context_summary, /共享上下文/);
  assert.equal(created.conversation.id, created.goal.conversation_id);
  assert.equal(created.conversation.messages.length, 2);
  assert.equal(created.memories[0].goal_id, created.goal.id);
  assert.equal(created.memories[0].key, "routing");
  assert.equal(created.task.goal_id, created.goal.id);
  assert.equal(created.task.conversation_id, created.conversation.id);
  assert.equal(created.task.assignee, "codex");
  assert.equal(created.task.status, "assigned");
  assert.equal(created.task.mode, "deploy");
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
    requireAuth: true
  });

  const listed = await callTool(server, "list_goals", { assignee: "codex" });
  assert.equal(listed.goals[0].mode, "builder");

  const context = await callTool(server, "get_goal_context", { goal_id: "goal_legacy_readonly" });
  assert.equal(context.goal.mode, "builder");
  assert.equal(context.task.mode, "builder");
});
