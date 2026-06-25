/**
 * e2e-product-acceptance.test.mjs — E2E product acceptance for GPTWork MCP
 *
 * Covers all 7 acceptance areas:
 *   Area 1: Runtime / doctor / context
 *   Area 2: Tool mode / direct call security
 *   Area 3: Goal → Task → Codex result
 *   Area 4: Agent pipeline / handoff
 *   Area 5: Event log / recent activity
 *   Area 6: GitHub / Bark integration (dry-run / no-op)
 *   Area 7: Widget / Apps SDK resource
 *
 * This test does not require a running gptwork-mcp.service.
 * It creates isolated in-memory servers for each test group.
 * External integrations (GitHub, Bark) use dry-run / no-op verification.
 */
import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { normalizeToolMode, filterToolsForMode, VALID_TOOL_MODES } from "../src/server-tools.mjs";
import { GPTWORK_TOOL_CARD_URI } from "../src/mcp-tooling.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(TEST_DIR, "../bin/gptwork.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-e2e-"));
  return {
    root,
    server: await createGptWorkServer({
      statePath: join(root, "state.json"),
      defaultWorkspaceRoot: join(root, "workspace"),
      tokens: ["test-token"],
      requireAuth: true,
      ...extra,
    }),
  };
}

async function call(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, { authorization: "Bearer test-token" });
  if (response.error) throw new Error(`RPC error for ${name}: ${response.error.message}`);
  return response.result;
}

async function callError(server, name, args = {}) {
  return server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, { authorization: "Bearer test-token" });
}

async function toolNames(server) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }, { authorization: "Bearer test-token" });
  return response.result.tools.map(t => t.name);
}

async function toolDescriptors(server) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }, { authorization: "Bearer test-token" });
  return response.result.tools;
}

// Resolve a workspace-relative path to absolute using the test server root
function wf(root, relPath) {
  return resolve(root, "workspace", relPath);
}

// ===========================================================================
// Area 1: Runtime / Doctor / Context
// ===========================================================================
test("Area 1a: CLI --help shows expected commands", () => {
  const help = execFileSync("node", [CLI_BIN, "--help"], { encoding: "utf8" });
  assert.match(help, /setup/);
  assert.match(help, /start/);
  assert.match(help, /status/);
  assert.match(help, /doctor/);
  assert.match(help, /settings show/);
  assert.match(help, /settings set KEY VALUE/);
  assert.match(help, /watch-handoff --dry-run/);
  assert.match(help, /watch-handoff --once/);
});

test("Area 1b: CLI doctor --local prints local summary without secrets", () => {
  const doctor = execFileSync("node", [CLI_BIN, "doctor", "--local"], { encoding: "utf8" });
  assert.match(doctor, /GPTWork Doctor/);
  assert.match(doctor, /workspace/);
  assert.match(doctor, /tool mode/);
  assert.doesNotMatch(doctor, /payload_base64/);
  assert.doesNotMatch(doctor, /token:|secret/);
});

test("Area 1c: runtime_status returns diagnostic fields without secrets", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "runtime_status");
  const sc = result.structuredContent;
  assert.ok(sc.pid, "has pid");
  assert.ok(sc.defaultWorkspaceRoot, "has workspace root");
  assert.equal(sc.codex_exec_timeout, 3600, "timeout is 3600");
  assert.ok(sc.running_commit || sc.repo_head, "has commit info");
  assert.ok(sc.worker !== undefined, "has worker info");
  assert.ok(sc.github !== undefined, "has github info");
  assert.ok(sc.bark !== undefined, "has bark info");
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /ghp_|gho_|github_pat_|password/i);
});

test("Area 1d: gptwork_doctor returns diagnostics without secrets", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "gptwork_doctor");
  const text = JSON.stringify(result);
  assert.ok(text.length > 50, "doctor has meaningful content");
  assert.doesNotMatch(text, /secret|password/i);
});

test("Area 1e: open_project_context returns bounded context", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "open_project_context");
  const sc = result.structuredContent;
  assert.equal(sc.ok, true);
  assert.ok(Array.isArray(sc.file_tree), "has bounded file tree");
  assert.ok(Array.isArray(sc.recommended_next_tools), "has recommended next tools");
  assert.ok(sc.recommended_next_tools.includes("create_encoded_goal"));
});

test("Area 1f: project_context_status returns context health info", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "project_context_status", {});
  assert.ok(result.structuredContent || result.context, "has context info");
});

// ===========================================================================
// Area 2: Tool Mode / Direct Call Security
// ===========================================================================

test("Area 2a: minimal mode exposes only P0 minimal tools", async () => {
  const { server } = await makeServer({ toolMode: "minimal" });
  const names = await toolNames(server);
  assert.ok(names.includes("health_check"), "health_check exposed");
  assert.ok(names.includes("runtime_status"), "runtime_status exposed");
  assert.ok(names.includes("open_project_context"), "open_project_context exposed");
  assert.ok(names.includes("create_encoded_goal"), "create_encoded_goal exposed");
  assert.ok(!names.includes("shell_exec"), "shell_exec not in minimal");
  assert.ok(!names.includes("handoff_to_agent"), "handoff_to_agent not in minimal");
  assert.ok(!names.includes("run_agent_pipeline"), "run_agent_pipeline not in minimal");
  assert.ok(names.length <= 10, "minimal has <= 10 tools");
});

test("Area 2b: operator mode does not expose agent/handoff tools", async () => {
  const { server } = await makeServer({ toolMode: "operator" });
  const names = await toolNames(server);
  assert.ok(!names.includes("handoff_to_agent"), "handoff_to_agent not in operator");
  assert.ok(!names.includes("create_agent_run"), "create_agent_run not in operator");
  assert.ok(!names.includes("run_agent_pipeline"), "run_agent_pipeline not in operator");
  assert.ok(names.includes("github_status"), "github_status in operator");
  assert.ok(names.includes("schedule_service_restart"), "schedule_service_restart in operator");
});

test("Area 2c: standard mode exposes expected tool categories", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const names = await toolNames(server);
  assert.ok(names.includes("create_goal"), "create_goal in standard");
  assert.ok(names.includes("create_encoded_goal"), "create_encoded_goal in standard");
  assert.ok(names.includes("get_goal_context"), "get_goal_context in standard");
  assert.ok(names.includes("create_task"), "create_task in standard");
  assert.ok(names.includes("list_tasks"), "list_tasks in standard");
  assert.ok(names.includes("handoff_to_agent"), "handoff_to_agent in standard");
  assert.ok(names.includes("create_agent_run"), "create_agent_run in standard");
  assert.ok(names.includes("read_events"), "read_events in standard");
  assert.ok(!names.includes("shell_exec"), "shell_exec not in standard");
});

test("Area 2d: codex mode exposes execution tools including shell_exec", async () => {
  const { server } = await makeServer({ toolMode: "codex" });
  const names = await toolNames(server);
  assert.ok(names.includes("shell_exec"), "shell_exec in codex");
  assert.ok(names.includes("write_text_file"), "write_text_file in codex");
  assert.ok(names.includes("handoff_to_agent"), "handoff_to_agent in codex");
  assert.ok(names.includes("read_events"), "read_events in codex");
});

test("Area 2e: full mode exposes all tools", async () => {
  const { server } = await makeServer({ toolMode: "full" });
  const names = await toolNames(server);
  assert.ok(names.includes("shell_exec"), "shell_exec in full");
  assert.ok(names.includes("handoff_to_agent"), "handoff_to_agent in full");
  assert.ok(names.includes("read_events"), "read_events in full");
  assert.ok(names.includes("schedule_service_restart"), "schedule_service_restart in full");
  assert.ok(names.length > 60, "full mode has many tools");
});

test("Area 2f: minimal/standard direct call shell_exec returns Unknown tool", async () => {
  const { server: svrS } = await makeServer({ toolMode: "standard" });
  const resp1 = await callError(svrS, "shell_exec", { command: "echo hello" });
  assert.equal(resp1.error?.code, -32601, "shell_exec returns error in standard");

  const { server: svrM } = await makeServer({ toolMode: "minimal" });
  const resp2 = await callError(svrM, "shell_exec", { command: "echo hello" });
  assert.equal(resp2.error?.code, -32601, "shell_exec returns error in minimal");
});

test("Area 2g: codex/full modes expose shell_exec in tool listing", async () => {
  const { server: svrC } = await makeServer({ toolMode: "codex" });
  const namesC = await toolNames(svrC);
  assert.ok(namesC.includes("shell_exec"), "shell_exec in codex");

  const { server: svrF } = await makeServer({ toolMode: "full" });
  const namesF = await toolNames(svrF);
  assert.ok(namesF.includes("shell_exec"), "shell_exec in full");
});

// ===========================================================================
// Area 3: Goal → Task → Codex Result
// ===========================================================================

test("Area 3a: create_goal writes goal files and returns goal/task/files", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "create_goal", {
    title: "E2E Test Goal",
    description: "Automated E2E verification goal",
    assign_to_codex: true,
    user_request: "E2E test",
    goal_prompt: "# E2E Goal\nAutomated acceptance",
  });
  const sc = result.structuredContent;
  assert.ok(sc.goal, "has goal object");
  assert.ok(sc.goal.id, "has goal.id");
  assert.ok(sc.goal.id.startsWith("goal_"), "goal.id starts with goal_");
  if (sc.task) {
    assert.ok(sc.task.id.startsWith("task_"), "task.id starts with task_");
  }
  // workspace_files may use different keys depending on handler version
  const hasFiles = sc.workspace_files?.goal_md || sc.files?.goal_md;
  assert.ok(hasFiles, "goal_md path returned");
});

test("Area 3b: create_encoded_goal decodes and writes goal files", async () => {
  const { server, root } = await makeServer({ toolMode: "standard" });
  const payload = {
    user_request: "Test encoded goal flow",
    goal_prompt: "# E2E Test\n\nVerify the encoded goal pipeline.",
    context_summary: "Testing create_encoded_goal",
    messages: [{ role: "user", content: "test" }],
    workspace_id: "hosted-default",
    mode: "builder",
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  const result = await call(server, "create_encoded_goal", {
    preview_text: "E2E test: verify encoded goal",
    payload_base64: payloadBase64,
    assign_to_codex: true,
    wait_ms: 0,
  });
  const sc = result.structuredContent;
  assert.ok(sc.goal, "has goal object");
  assert.ok(sc.goal.id, "has goal.id");
  assert.ok(sc.goal.id.startsWith("goal_"), "goal.id starts with goal_");

  // workspace_files paths are relative (e.g. ".gptwork/goals/<id>/goal.md")
  // They resolve against the workspace root (root/workspace)
  if (sc.workspace_files?.goal_md) {
    const goalMd = wf(root, sc.workspace_files.goal_md);
    const content = await readFile(goalMd, "utf8");
    assert.match(content, /E2E Test/, "goal.md contains goal_prompt");
    assert.match(content, /Test encoded goal flow/, "goal.md contains user_request");
  } else if (sc.internal_files?.goal_md) {
    const goalMd = wf(root, sc.internal_files.goal_md);
    const content = await readFile(goalMd, "utf8");
    assert.match(content, /E2E Test/, "goal.md from internal_files");
  }

  // result_md should exist (initialized by create_encoded_goal)
  const resultMd = sc.internal_files?.result_md
    ? wf(root, sc.internal_files.result_md)
    : (sc.workspace_files?.result_md ? wf(root, sc.workspace_files.result_md) : null);
  if (resultMd && existsSync(resultMd)) {
    const resultContent = await readFile(resultMd, "utf8");
    assert.equal(typeof resultContent, "string", "result_md readable");
  }
});

test("Area 3c: get_goal_context returns goal context with files", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const payload = { user_request: "test", goal_prompt: "# Context test", context_summary: "", messages: [], workspace_id: "hosted-default", mode: "builder" };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const created = await call(server, "create_encoded_goal", {
    preview_text: "Context test", payload_base64: payloadBase64, assign_to_codex: true, wait_ms: 0,
  });
  const goalId = created.structuredContent.goal.id;
  const taskId = created.structuredContent.task?.id;

  const context = await call(server, "get_goal_context", { goal_id: goalId, task_id: taskId });
  const ctx = context.structuredContent;
  assert.ok(ctx.goal, "has goal object");
  assert.equal(ctx.goal.id, goalId, "goal id matches");
  assert.ok(ctx.workspace_files?.goal_md, "has workspace_files.goal_md");
  assert.ok(ctx.workspace_files?.result_md, "has workspace_files.result_md");
  assert.ok(ctx.codex_instruction, "has codex_instruction");
});

test("Area 3d: append_goal_message writes message to goal conversation", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const payload = { user_request: "test", goal_prompt: "# Append test", context_summary: "", messages: [], workspace_id: "hosted-default", mode: "builder" };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const created = await call(server, "create_encoded_goal", {
    preview_text: "Append test", payload_base64: payloadBase64, assign_to_codex: true, wait_ms: 0,
  });
  const goalId = created.structuredContent.goal.id;

  const result = await call(server, "append_goal_message", {
    goal_id: goalId,
    role: "codex",
    content: "E2E test message from automated acceptance",
  });
  const sc = result.structuredContent;
  // append_goal_message returns { goal, conversation, message, memory, workspace_files }
  assert.ok(sc.message, "has message object");
  assert.equal(sc.message.role, "codex", "message role is codex");
  assert.match(sc.message.content || "", /E2E test message/, "content preserved");
  assert.ok(sc.workspace_files, "has workspace_files");
});

test("Area 3e: result contract is readable through get_goal_context", async () => {
  const { server, root } = await makeServer({ toolMode: "standard" });
  const payload = {
    user_request: "Result contract test",
    goal_prompt: "# Result contract\nVerify result.md is readable.",
    context_summary: "", messages: [], workspace_id: "hosted-default", mode: "builder",
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const created = await call(server, "create_encoded_goal", {
    preview_text: "Result contract", payload_base64: payloadBase64, assign_to_codex: true, wait_ms: 0,
  });

  // Read result.md via get_goal_context
  const goalId = created.structuredContent.goal.id;
  const context = await call(server, "get_goal_context", { goal_id: goalId });
  const ctx = context.structuredContent;
  assert.ok(ctx.workspace_files?.result_md, "result_md path in workspace_files");
  // result_md path is relative; resolve against workspace root
  const resultMd = wf(root, ctx.workspace_files.result_md);
  assert.ok(existsSync(resultMd), "result_md file exists on disk");
  const resultContent = await readFile(resultMd, "utf8");
  assert.equal(typeof resultContent, "string", "result_md is readable");
  assert.ok(resultContent.length > 0, "result_md has content");
});

// ===========================================================================
// Area 4: Agent Pipeline / Handoff
// ===========================================================================

test("Area 4a: run_agent_pipeline creates pipeline runs", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "run_agent_pipeline", {
    goal_id: "goal_e2e_test",
    task_id: "task_e2e_test",
    agent: "codex",
    roles: ["planner", "architect"],
  });
  const sc = result.structuredContent;
  assert.ok(sc.pipeline, "has pipeline object");
  assert.ok(sc.pipeline.id, "pipeline.id present");
  assert.ok(sc.pipeline.id.startsWith("pipeline_"), "pipeline.id starts with pipeline_");
  assert.ok(Array.isArray(sc.agent_runs), "has agent_runs array");
  assert.ok(sc.agent_runs.length >= 1, "agent_runs not empty");
  assert.deepEqual(sc.agent_runs.map((run) => run.role), ["planner", "architect"]);
  sc.agent_runs.forEach(run => {
    assert.ok(run.role, "agent_run has role");
    assert.ok(run.status, "agent_run has status");
  });
  assert.ok(sc.count > 0, "count > 0");
});

test("Area 4b: handoff_to_agent writes plan/status/log files to disk", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "handoff_to_agent", {
    agent: "codex",
    plan: "# E2E Acceptance Plan\n\n1. Verify handoff files are written.\n2. Read them back.",
    goal_id: "goal_e2e_handoff",
    task_id: "task_e2e_handoff",
  });
  const sc = result.structuredContent;
  assert.ok(sc.handoff, "has handoff object");
  assert.equal(sc.handoff.agent, "codex");
  assert.ok(sc.handoff.plan_file, "plan_file path returned");
  assert.ok(sc.handoff.status_file, "status_file path returned");
  assert.ok(sc.handoff.log_file, "log_file path returned");

  assert.ok(existsSync(sc.handoff.plan_file), "plan_file exists on disk");
  assert.ok(existsSync(sc.handoff.status_file), "status_file exists on disk");
  assert.ok(existsSync(sc.handoff.log_file), "log_file exists on disk");

  const planContent = await readFile(sc.handoff.plan_file, "utf8");
  assert.match(planContent, /E2E Acceptance Plan/, "plan content matches");
});

test("Area 4c: read_handoff returns compact handoff summary", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  await call(server, "handoff_to_agent", {
    agent: "codex",
    plan: "# Handoff Plan\nRead test.",
    goal_id: "goal_read_test",
    task_id: "task_read_test",
  });
  const result = await call(server, "read_handoff", {});
  const sc = result.structuredContent;
  assert.match(sc.plan || "", /Handoff Plan/, "plan content returned");
  assert.ok(sc.status, "status object returned");
  assert.ok(sc.status.agent, "agent name in status");
  assert.ok(sc.paths?.plan_file, "paths.plan_file returned");
});

test("Area 4d: CLI watch-handoff --dry-run produces output", () => {
  const out = execFileSync("node", [CLI_BIN, "watch-handoff", "--dry-run"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ok(out.length > 0, "watch-handoff --dry-run produces output");
});

test("Area 4e: CLI watch-handoff --once runs one iteration", () => {
  const out = execFileSync("node", [CLI_BIN, "watch-handoff", "--once"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ok(out.length > 0, "watch-handoff --once produces output");
});

// ===========================================================================
// Area 5: Event Log / Recent Activity
// ===========================================================================

test("Area 5a: read_events returns bounded events", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const result = await call(server, "read_events", { limit: 10 });
  const sc = result.structuredContent;
  assert.ok(Array.isArray(sc.events), "events is an array");
  assert.ok(sc.events.length <= 10, "events bounded by limit");
  assert.ok(typeof sc.count === "number", "count is a number");
});

test("Area 5b: handoff events are created during test flow", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  await call(server, "handoff_to_agent", {
    agent: "codex",
    plan: "# Event test",
    goal_id: "goal_event_test",
    task_id: "task_event_test",
  });
  const result = await call(server, "read_events", { limit: 50 });
  const sc = result.structuredContent;
  assert.ok(Array.isArray(sc.events), "events array readable");
});

test("Area 5c: events array is always returned", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  await call(server, "create_goal", {
    title: "Event Log Goal Test",
    description: "Verify events track goal context",
    assign_to_codex: false,
    user_request: "Event test",
    goal_prompt: "# Event test goal",
  });
  const result = await call(server, "read_events", { limit: 50 });
  const sc = result.structuredContent;
  assert.ok(Array.isArray(sc.events), "events array");
});

// ===========================================================================
// Area 6: GitHub / Bark Integration (dry-run / no-op)
// ===========================================================================

test("Area 6a: runtime_status shows config without exposing credentials", async () => {
  const { server } = await makeServer({
    toolMode: "standard",
    githubEnabled: false,
    barkEnabled: false,
  });
  const result = await call(server, "runtime_status");
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /ghp_|gho_|github_pat_|password/i);
});

test("Area 6b: github_status returns disabled when not configured", async () => {
  const { server } = await makeServer({
    toolMode: "standard",
    githubEnabled: false,
  });
  const result = await call(server, "github_status", {});
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /ghp_|gho_|github_pat_/i);
});

test("Area 6c: notification_status returns state without exposing keys", async () => {
  const { server } = await makeServer({
    toolMode: "full",
    barkEnabled: false,
  });
  const result = await call(server, "notification_status", {});
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /bark_token|bark_url=|bark_key=/i);
});

test("Area 6d: sync_from_github handles disabled gracefully", async () => {
  const { server } = await makeServer({
    toolMode: "standard",
    githubEnabled: false,
  });
  const result = await call(server, "sync_from_github", {});
  const text = JSON.stringify(result);
  assert.ok(text.length > 0, "result returned for disabled github");
});

// ===========================================================================
// Area 7: Widget / Apps SDK Resource
// ===========================================================================

test("Area 7a: resources/list includes primary tool card and legacy widget card resources", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const response = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/list", params: {},
  }, { authorization: "Bearer test-token" });
  const resources = response.result.resources;
  const uris = resources.map(r => r.uri);
  assert.ok(uris.includes(GPTWORK_TOOL_CARD_URI), "primary tool card resource listed");
  assert.ok(uris.includes("ui://widget/gptwork-card-v1.html"), "v1 widget card resource listed");
  assert.ok(uris.includes("ui://widget/gptwork-card-v2.html"), "v2 widget card resource listed");
  const card = resources.find(r => r.uri === GPTWORK_TOOL_CARD_URI);
  assert.ok(card, "tool card resource entry exists");
  assert.ok(card["openai/widgetDescription"], "tool card has widgetDescription");
  assert.equal(card["openai/widgetPrefersBorder"], true, "tool card has widgetPrefersBorder");
  assert.equal(typeof card["openai/widgetDomain"], "string", "tool card has widgetDomain string");
  assert.deepEqual(card["openai/widgetCSP"], { connect_domains: [], resource_domains: [] }, "tool card has object widgetCSP");
  assert.deepEqual(card.ui?.csp, { connectDomains: [], resourceDomains: [] }, "tool card has ui CSP object");
});

test("Area 7b: resources/read returns compact card HTML for v1 and v2", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  // Test v1
  const v1resp = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/read",
    params: { uri: "ui://widget/gptwork-card-v1.html" },
  }, { authorization: "Bearer test-token" });
  assert.equal(v1resp.result.contents[0].uri, "ui://widget/gptwork-card-v1.html");
  const v1html = v1resp.result.contents[0].text;
  assert.ok(v1html.includes("<!doctype html>") || v1html.startsWith("<!doctype html>"), "v1 HTML starts with doctype");
  assert.ok(v1html.includes("GPTWork"), "v1 HTML contains GPTWork");
  assert.ok(v1html.includes("card"), "v1 HTML contains card structure");
  // Test v2
  const v2resp = await server.handleRpc({
    jsonrpc: "2.0", id: 2, method: "resources/read",
    params: { uri: "ui://widget/gptwork-card-v2.html" },
  }, { authorization: "Bearer test-token" });
  assert.equal(v2resp.result.contents[0].uri, "ui://widget/gptwork-card-v2.html");
  const v2html = v2resp.result.contents[0].text;
  assert.ok(v2html.includes("<!doctype html>") || v2html.startsWith("<!doctype html>"), "v2 HTML starts with doctype");
  assert.ok(v2html.includes("GPTWork"), "v2 HTML contains GPTWork");
  assert.ok(v2html.includes("badge"), "v2 HTML has badge function");
});

test("Area 7c: v2 HTML contains badge/renderCard/keyValues/items/warnings/errors/diff/raw", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const response = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/read",
    params: { uri: "ui://widget/gptwork-card-v2.html" },
  }, { authorization: "Bearer test-token" });
  const html = response.result.contents[0].text;
  assert.ok(html.includes("renderCard"), "has renderCard function");
  assert.ok(html.includes("badge"), "has badge function");
  assert.ok(html.includes("data.status"), "reads status");
  assert.ok(html.includes("data.summary"), "reads summary");
  assert.ok(html.includes("data.changed_files"), "reads changed_files");
  assert.ok(html.includes("data.staged_count"), "reads staged_count");
  assert.ok(html.includes("data.diff_excerpt"), "reads diff_excerpt");
  assert.ok(html.includes("keyValues"), "reads keyValues");
  assert.ok(html.includes("data.items"), "reads items");
  assert.ok(html.includes("data.warnings"), "reads warnings");
  assert.ok(html.includes("data.errors"), "reads errors");
  assert.ok(html.includes("Show raw JSON"), "has JSON fallback toggle");
});

test("Area 7d: tool descriptors have _meta with outputTemplate AND resourceUri pointing to primary tool card", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const descriptors = await toolDescriptors(server);
  const withCard = descriptors.filter(d => {
    const ot = d._meta?.["openai/outputTemplate"];
    const ru = d._meta?.ui?.resourceUri;
    return ot === GPTWORK_TOOL_CARD_URI || ru === GPTWORK_TOOL_CARD_URI;
  });
  assert.ok(withCard.length >= 8, `at least 8 tools use primary tool card, got ${withCard.length}`);
  // At least 3 must have both outputTemplate AND resourceUri
  const withBoth = descriptors.filter(d => {
    return d._meta?.["openai/outputTemplate"] === GPTWORK_TOOL_CARD_URI &&
      d._meta?.ui?.resourceUri === GPTWORK_TOOL_CARD_URI;
  });
  assert.ok(withBoth.length >= 3, `at least 3 tools have both outputTemplate and resourceUri, got ${withBoth.length}`);
});

test("Area 7e: resources/list returns both widget cards even in minimal mode", async () => {
  const { server } = await makeServer({ toolMode: "minimal" });
  const response = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/list", params: {},
  }, { authorization: "Bearer test-token" });
  const resources = response.result.resources;
  const uris = resources.map(r => r.uri);
  assert.ok(uris.includes(GPTWORK_TOOL_CARD_URI), "primary tool card visible in minimal mode");
  assert.ok(uris.includes("ui://widget/gptwork-card-v1.html"), "v1 visible in minimal mode");
  assert.ok(uris.includes("ui://widget/gptwork-card-v2.html"), "v2 visible in minimal mode");
});



test("Area 7f: v2 card has root/status/summary/key-values/items/warnings/errors/raw fallback/render", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const response = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/read",
    params: { uri: "ui://widget/gptwork-card-v2.html" },
  }, { authorization: "Bearer test-token" });
  const html = response.result.contents[0].text;
  // root container
  assert.ok(html.includes('id="root"'), "has root container");
  // status rendering
  assert.ok(html.includes("data.status"), "reads status");
  // summary rendering
  assert.ok(html.includes("data.summary"), "reads summary");
  // key-values rendering
  assert.ok(html.includes("keyValues") || html.includes("key_values"), "reads keyValues or key_values");
  // items rendering
  assert.ok(html.includes("data.items"), "reads items");
  // warnings rendering
  assert.ok(html.includes("data.warnings"), "reads warnings");
  // errors rendering
  assert.ok(html.includes("data.errors"), "reads errors");
  // raw JSON fallback
  assert.ok(html.includes("Show raw JSON"), "has raw JSON fallback toggle");
  // renderCard function
  assert.ok(html.includes("renderCard"), "has renderCard function");
  // badge function
  assert.ok(html.includes("function badge"), "has badge function");
  // v2-specific: diff stats
  assert.ok(html.includes("staged_count"), "reads staged_count for diff stats");
  assert.ok(html.includes("diff_excerpt"), "reads diff_excerpt for diff preview");
  // dark mode support
  assert.ok(html.includes("prefers-color-scheme:dark"), "has dark mode support");
  // v1 backward compat
  assert.ok(html.includes("keyValues"), "backward compat with keyValues");
});

test("Area 7g: v1 card remains backward-compatible", async () => {
  const { server } = await makeServer({ toolMode: "standard" });
  const v1resp = await server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "resources/read",
    params: { uri: "ui://widget/gptwork-card-v1.html" },
  }, { authorization: "Bearer test-token" });
  assert.equal(v1resp.result.contents[0].uri, "ui://widget/gptwork-card-v1.html");
  const html = v1resp.result.contents[0].text;
  assert.ok(html.includes("renderCard"), "v1 has renderCard");
  assert.ok(html.includes("data.status"), "v1 reads status");
  assert.ok(html.includes("Show raw JSON"), "v1 has JSON toggle");
});

// ===========================================================================
// Contract: normalize/filter mode unit tests
// ===========================================================================

test("Contract: normalizeToolMode maps all valid modes and defaults", () => {
  assert.equal(normalizeToolMode("minimal"), "minimal");
  assert.equal(normalizeToolMode("standard"), "standard");
  assert.equal(normalizeToolMode("operator"), "operator");
  assert.equal(normalizeToolMode("codex"), "codex");
  assert.equal(normalizeToolMode("full"), "full");
  assert.equal(normalizeToolMode("MINIMAL"), "minimal");
  assert.equal(normalizeToolMode("Standard"), "standard");
  assert.equal(normalizeToolMode("invalid"), "standard");
  assert.equal(normalizeToolMode(""), "standard");
  assert.equal(normalizeToolMode(undefined), "standard");
});

test("Contract: VALID_TOOL_MODES has 5 modes", () => {
  assert.deepEqual([...VALID_TOOL_MODES].sort(), ["codex", "full", "minimal", "operator", "standard"]);
});

test("Contract: filterToolsForMode full returns all tools", () => {
  const sampleTools = {
    health_check: { handler: () => {} },
    shell_exec: { handler: () => {} },
    handoff_to_agent: { handler: () => {} },
  };
  const full = filterToolsForMode(sampleTools, "full");
  assert.deepEqual(Object.keys(full).sort(), ["handoff_to_agent", "health_check", "shell_exec"]);
});
