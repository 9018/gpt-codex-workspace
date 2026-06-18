import "./helpers/env-isolation.mjs";
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

test("create_chatgpt_request schema exposes escalation fields", async () => {
  const server = await makeServer();

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined);
  const tools = response.result.tools;
  const chatgptTool = tools.find(t => t.name === "create_chatgpt_request");
  assert.ok(chatgptTool, "create_chatgpt_request tool should exist");
  const props = chatgptTool.inputSchema.properties;
  assert.ok(props, "should have inputSchema.properties");
  assert.equal(props.escalation_category.type, "string", "escalation_category should be a string");
  assert.equal(props.why_subagents_cannot_decide.type, "string", "why_subagents_cannot_decide should be a string");
  assert.equal(props.options_considered.type, "string", "options_considered should be a string");
  assert.equal(props.default_if_no_response.type, "string", "default_if_no_response should be a string");
});

test("missing escalation returns warning", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_chatgpt_request", {
    title: "Test without escalation",
    prompt: "This request lacks escalation data."
  });

  assert.ok(created.warnings, "warnings should be present when escalation is missing");
  assert.ok(created.warnings.length > 0, "at least one warning should describe missing escalation");
  assert.match(created.warnings[0], /escalation/i, "warning should mention escalation");
  assert.equal(created.request.status, "open");
});

test("provided escalation suppresses missing-escalation warning", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_chatgpt_request", {
    title: "Test with escalation",
    prompt: "This request includes escalation data.",
    escalation_category: "technical_uncertainty",
    why_subagents_cannot_decide: "Need product direction on auth approach.",
    options_considered: '["option_a", "option_b"]',
    default_if_no_response: "option_a"
  });

  assert.ok(!created.warnings || created.warnings.length === 0,
    "no warnings when escalation is provided. Got: " + JSON.stringify(created.warnings));
  assert.equal(created.request.status, "open");
});
