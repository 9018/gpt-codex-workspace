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
