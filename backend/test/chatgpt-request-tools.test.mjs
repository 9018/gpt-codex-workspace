import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-chat-"));
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

test("Codex can create a ChatGPT coordination request and ChatGPT can answer it", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_chatgpt_request", {
    title: "Analyze auth approach",
    prompt: "Please compare token and OAuth for this repo.",
    source: "codex"
  });

  assert.equal(created.request.status, "open");
  assert.equal(created.request.source, "codex");

  const listed = await callTool(server, "list_chatgpt_requests", { status: "open" });
  assert.equal(listed.requests.length, 1);

  const answered = await callTool(server, "answer_chatgpt_request", {
    request_id: created.request.id,
    response: "Use token for v1 and OAuth later."
  });

  assert.equal(answered.request.status, "answered");
  assert.equal(answered.request.response, "Use token for v1 and OAuth later.");
});
