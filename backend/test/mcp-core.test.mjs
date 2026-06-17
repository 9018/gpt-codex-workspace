import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer, startCodexWorker } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-ws-"));
  const statePath = join(root, "state.json");
  return createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true
  });
}

test("initialize returns MCP server metadata", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" }
    }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "GPTWork MCP");
  assert.equal(response.result.capabilities.tools.listChanged, true);
});

test("tools/list exposes project, task, workspace, shell, and browser tools", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("list_projects"));
  assert.ok(names.includes("create_encoded_goal"));
  assert.ok(names.includes("create_goal"));
  assert.ok(names.includes("list_goals"));
  assert.ok(names.includes("get_goal_context"));
  assert.ok(names.includes("append_goal_message"));
  assert.ok(names.includes("create_task"));
  assert.ok(names.includes("write_text_file"));
  assert.ok(names.includes("upload_bundle_base64"));
  assert.ok(names.includes("download_bundle_base64"));
  assert.ok(names.includes("shell_exec"));
  assert.ok(names.includes("browser_goto"));
  for (const tool of response.result.tools) {
    assert.equal(tool.outputSchema.type, "object");
    assert.equal(tool.outputSchema.additionalProperties, true);
  }
});

test("tools/list does not expose placeholder tools by default", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((tool) => tool.name);
  const hidden = ["init_chunk_upload", "upload_file_chunk", "finish_chunk_upload", "abort_chunk_upload",
    "browser_screenshot", "browser_set_input_files", "browser_click_and_download", "browser_evaluate"];
  for (const h of hidden) {
    assert.equal(names.includes(h), false, "placeholder tool " + h + " should be hidden by default");
  }
});

test("tools/list exposes gptwork_doctor tool", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("gptwork_doctor"), "gptwork_doctor should be exposed");
});

test("tools/list exposes placeholder tools when GPTWORK_EXPOSE_PLACEHOLDER_TOOLS is set", async () => {
  const oldVal = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
  process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = "true";
  let names;
  try {
    const server = await makeServer();
    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, { authorization: "Bearer test-token" });
    names = response.result.tools.map((tool) => tool.name);
  } finally {
    delete process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS;
    if (oldVal !== undefined) process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS = oldVal;
  }
  assert.ok(names.includes("init_chunk_upload"), "init_chunk_upload should be exposed when flag is set");
  assert.ok(names.includes("browser_screenshot"), "browser_screenshot should be exposed when flag is set");
  assert.ok(names.includes("browser_set_input_files"), "browser_set_input_files should be exposed when flag is set");
  assert.ok(names.includes("browser_click_and_download"), "browser_click_and_download should be exposed when flag is set");
  assert.ok(names.includes("browser_evaluate"), "browser_evaluate should be exposed when flag is set");
  assert.ok(names.includes("upload_file_chunk"), "upload_file_chunk should be exposed when flag is set");
  assert.ok(names.includes("finish_chunk_upload"), "finish_chunk_upload should be exposed when flag is set");
  assert.ok(names.includes("abort_chunk_upload"), "abort_chunk_upload should be exposed when flag is set");
});


test("tools/call rejects missing bearer token when auth is required", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} }
  }, {});

  assert.equal(response.error.code, -32001);
  assert.match(response.error.message, /token/i);
});

test("GET /mcp opens an SSE stream for MCP clients", async () => {
  const app = await makeServer();
  const httpServer = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const address = httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      headers: { Accept: "text/event-stream" }
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /mcp/:token authenticates MCP requests from the path", async () => {
  const app = await makeServer();
  const httpServer = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const address = httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp/test-token`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "health_check", arguments: {} }
      })
    });

    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(body, /"id":4/);
    assert.match(body, /"ok":true/);
    assert.doesNotMatch(body, /Missing or invalid bearer token/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("POST /mcp streams progress notifications before the final tool result", async () => {
  const app = await makeServer();
  const httpServer = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const address = httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp/test-token`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "create_codex_session_inventory_task", arguments: { limit: 1 } }
      })
    });

    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(body, /notifications\/message/);
    assert.match(body, /started/);
    assert.match(body, /completed/);
    assert.match(body, /"id":6/);
    assert.match(body, /"status":"completed"/);
    assert.ok(body.indexOf("notifications/message") < body.indexOf('"id":6'));
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});


test("tools/list exposes preview_codex_context tool", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("preview_codex_context"), "preview_codex_context should be in tools/list");

  const tool = response.result.tools.find(t => t.name === "preview_codex_context");
  assert.ok(tool, "preview_codex_context tool entry should exist");
  assert.ok(tool.description.toLowerCase().includes("codex"), "description should mention Codex");
  assert.ok(tool.inputSchema.required.includes("task_id"), "task_id should be required");
  assert.equal(tool.inputSchema.properties.task_id.type, "string", "task_id should be string type");
  assert.equal(tool.outputSchema.type, "object");
  assert.equal(tool.outputSchema.additionalProperties, true);
});

test("preview_codex_context is discoverable by keyword search in description", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const tools = response.result.tools;
  const previewMatch = tools.filter(t => t.name.includes("preview") || t.description.toLowerCase().includes("preview"));
  assert.ok(previewMatch.some(t => t.name === "preview_codex_context"),
    "preview_codex_context should be discoverable by preview keyword");

  const contextMatch = tools.filter(t => t.name.includes("context") || t.description.toLowerCase().includes("context"));
  assert.ok(contextMatch.some(t => t.name === "preview_codex_context"),
    "preview_codex_context should be discoverable by context keyword");
});

test("preview_codex_context returns safe context preview with full structure", async () => {
  const server = await makeServer();

  // Create a task
  const createResult = await server.handleRpc({
    jsonrpc: "2.0", id: 1,
    method: "tools/call",
    params: { name: "create_task", arguments: { title: "preview test task" } }
  }, { authorization: "Bearer test-token" });
  const taskId = createResult.result.structuredContent.task.id;
  assert.ok(taskId, "task should be created");

  // Now call preview_codex_context
  const previewResult = await server.handleRpc({
    jsonrpc: "2.0", id: 2,
    method: "tools/call",
    params: { name: "preview_codex_context", arguments: { task_id: taskId } }
  }, { authorization: "Bearer test-token" });

  assert.equal(previewResult.error, undefined, "preview_codex_context should not error");
  const sc = previewResult.result.structuredContent;

  // Check top-level fields
  assert.ok(sc.context, "should have context object");
  assert.ok(sc.preview, "should have preview text string");
  assert.ok(sc.preview_text, "should have preview_text for backward compat");
  assert.equal(sc.preview, sc.preview_text, "preview and preview_text should match");

  const ctx = sc.context;
  assert.ok(ctx.task, "context should have task");
  assert.equal(ctx.task.id, taskId, "task.id should match");
  assert.equal(ctx.task.title, "preview test task", "task.title should match");
  assert.ok(ctx.built_at, "context should have built_at timestamp");

  // Check all required sections exist
  for (const section of ["goal", "workspace", "canonical_repo", "project_context", "size_metrics", "warnings"]) {
    assert.ok(section in ctx, `context should have ${section} field`);
  }
});
test("Codex worker interval uses safe assigned task runner with configured concurrency", async () => {
  let calls = 0;
  const seen = [];
  const handle = startCodexWorker({
    intervalMs: 5,
    async runAssignedCodexTasks(args) {
      calls += 1;
      seen.push(args);
      return { completed: 0 };
    }
  }, { concurrency: 3, limit: 9 });

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(calls >= 1);
    assert.equal(seen[0].concurrency, 3);
    assert.equal(seen[0].limit, 9);
  } finally {
    handle.stop();
  }
});
