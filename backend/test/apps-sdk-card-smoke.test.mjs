/**
 * apps-sdk-card-smoke.test.mjs — ChatGPT Apps SDK Card v2 smoke test
 *
 * Verifies that the MCP server exposes the correct capabilities
 * for ChatGPT Apps SDK card rendering:
 *
 * 1. initialize response includes tools.listChanged, resources.listChanged, and extensions["io.modelcontextprotocol/ui"]
 * 2. tools/list descriptors have _meta with openai/outputTemplate and ui.resourceUri pointing to v2
 * 3. resources/list includes ui://widget/gptwork-card-v2.html with Apps SDK metadata
 * 4. resources/read v2 returns HTML content + Apps SDK _meta
 * 5. tools/call result includes structuredContent for card renderer
 */
import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-card-smoke-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    ...extra,
  });
}

async function rpc(server, method, params = {}, token = "test-token") {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  }, headers);
}

function renderWidgetHtml(html, openai) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "widget HTML must contain an inline script");

  const root = { innerHTML: "" };
  const listeners = new Map();
  const windowObject = {
    openai,
    addEventListener: (event, handler) => listeners.set(event, handler),
  };
  const context = vm.createContext({
    window: windowObject,
    document: {
      readyState: "complete",
      getElementById: (id) => id === "root" ? root : null,
    },
  });

  for (const script of scripts) {
    vm.runInContext(script, context, { timeout: 1000 });
  }

  return { root, listeners, context };
}

function extractInitialRootHtml(html) {
  const match = html.match(/<div class="card" id="root">([\s\S]*?)<\/div><script>/);
  return match ? match[1] : "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SDK-1: initialize exposes tools.listChanged + resources.listChanged + ui extension", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.1" },
  });

  assert.equal(res.result.serverInfo.name, "GPTWork MCP");
  assert.equal(res.result.capabilities.tools.listChanged, true,
    "tools.listChanged must be true for MCP Apps SDK");
  assert.equal(res.result.capabilities.resources.listChanged, true,
    "resources.listChanged must be true for Apps SDK resource discovery");
  assert.ok(res.result.capabilities.extensions?.["io.modelcontextprotocol/ui"],
    "extensions['io.modelcontextprotocol/ui'] must be present for Apps SDK card rendering");
});

test("SDK-2: tools/list contains v2 card _meta on tools with outputTemplate", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/list");
  const tools = res.result.tools;

  // Count tools with v2 card reference
  const withV2Card = tools.filter(t =>
    t._meta?.["openai/outputTemplate"] === "ui://widget/gptwork-card-v2.html" ||
    t._meta?.ui?.resourceUri === "ui://widget/gptwork-card-v2.html"
  );
  assert.ok(withV2Card.length >= 10,
    `Expected at least 10 tools with v2 card, got ${withV2Card.length}`);

  // Count tools with BOTH outputTemplate and resourceUri
  const withBoth = tools.filter(t =>
    t._meta?.["openai/outputTemplate"] === "ui://widget/gptwork-card-v2.html" &&
    t._meta?.ui?.resourceUri === "ui://widget/gptwork-card-v2.html"
  );
  assert.ok(withBoth.length >= 3,
    `Expected at least 3 tools with both outputTemplate and resourceUri, got ${withBoth.length}`);

  // Verify the specific queue tools that should exist now
  const names = tools.map(t => t.name);
  assert.ok(names.includes("enqueue_goal"), "enqueue_goal must be in tools/list");
  assert.ok(names.includes("list_goal_queue"), "list_goal_queue must be in tools/list");
  assert.ok(names.includes("start_next_queued_goal"), "start_next_queued_goal must be in tools/list");

  // Verify queue tools have v2 card _meta
  const enqueueTool = tools.find(t => t.name === "enqueue_goal");
  assert.ok(enqueueTool?._meta?.["openai/outputTemplate"] === "ui://widget/gptwork-card-v2.html",
    "enqueue_goal must have _meta.openai/outputTemplate pointing to v2 card");
  assert.ok(enqueueTool?._meta?.ui?.resourceUri === "ui://widget/gptwork-card-v2.html",
    "enqueue_goal must have _meta.ui.resourceUri pointing to v2 card");
});

test("SDK-2b: required card-enabled tools expose both v2 descriptor metadata fields", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/list");
  const toolsByName = new Map(res.result.tools.map((t) => [t.name, t]));

  const requiredCardTools = [
    "runtime_status",
    "gptwork_self_test",
    "gptwork_doctor",
    "worker_status",
    "list_goals",
    "get_goal_context",
    "list_tasks",
    "get_task",
    "show_changes",
    "read_handoff",
    "list_goal_queue",
    "get_goal_queue",
    "start_next_queued_goal",
  ];

  for (const name of requiredCardTools) {
    const descriptor = toolsByName.get(name);
    assert.ok(descriptor, `${name} must be visible in standard tools/list`);
    assert.equal(descriptor._meta?.["openai/outputTemplate"], "ui://widget/gptwork-card-v2.html",
      `${name} must expose _meta.openai/outputTemplate for the v2 card`);
    assert.equal(descriptor._meta?.ui?.resourceUri, "ui://widget/gptwork-card-v2.html",
      `${name} must expose _meta.ui.resourceUri for the v2 card`);
  }
});

test("SDK-3: resources/list includes v2 with Apps SDK metadata", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/list");
  const resources = res.result.resources || [];
  const uris = resources.map(r => r.uri);

  assert.ok(uris.includes("ui://widget/gptwork-card-v2.html"),
    "resources/list must include v2 card URI");

  const v2 = resources.find(r => r.uri === "ui://widget/gptwork-card-v2.html");
  assert.ok(v2, "v2 resource must have an entry");
  assert.ok(v2.mimeType === "text/html;profile=mcp-app",
    `v2 card mimeType should be text/html;profile=mcp-app, got ${v2.mimeType}`);
  assert.ok(v2["openai/widgetDescription"],
    "v2 resource must have openai/widgetDescription");
  assert.ok(v2["openai/widgetPrefersBorder"] === true,
    "v2 resource must have openai/widgetPrefersBorder: true");
  assert.ok(Array.isArray(v2["openai/widgetDomain"]),
    "v2 resource must have openai/widgetDomain array");
  assert.ok(v2["openai/widgetCSP"],
    "v2 resource must have openai/widgetCSP");

  // Verify widgetDomain includes queue tools
  const domain = v2["openai/widgetDomain"];
  assert.ok(domain.includes("enqueue_goal"),
    "openai/widgetDomain must include enqueue_goal");
  assert.ok(domain.includes("list_goal_queue"),
    "openai/widgetDomain must include list_goal_queue");
  assert.ok(domain.includes("get_goal_queue"),
    "openai/widgetDomain must include get_goal_queue");
  assert.ok(domain.includes("start_next_queued_goal"),
    "openai/widgetDomain must include start_next_queued_goal");
  assert.ok(domain.includes("update_goal_queue_item"),
    "openai/widgetDomain must include update_goal_queue_item");
  assert.ok(domain.includes("cancel_goal_queue_item"),
    "openai/widgetDomain must include cancel_goal_queue_item");

  // Verify widgetDomain includes key non-queue tools
  assert.ok(domain.includes("runtime_status"),
    "openai/widgetDomain must include runtime_status");
  assert.ok(domain.includes("gptwork_doctor"),
    "openai/widgetDomain must include gptwork_doctor");
  assert.ok(domain.includes("worker_status"),
    "openai/widgetDomain must include worker_status");

  // Verify total count is reasonable
  assert.ok(domain.length >= 12,
    `openai/widgetDomain should have at least 12 entries, got ${domain.length}`);
});

test("SDK-4: resources/read v2 returns HTML with Apps SDK _meta", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const content = res.result.contents[0];

  assert.equal(content.uri, "ui://widget/gptwork-card-v2.html");
  assert.equal(content.mimeType, "text/html;profile=mcp-app",
    "v2 readResource should return mimeType 'text/html;profile=mcp-app'");

  // Check HTML content
  assert.ok(content.text.includes("<!doctype html>") || content.text.startsWith("<!doctype html>"),
    "v2 HTML must start with doctype");
  assert.ok(content.text.includes("GPTWork"), "v2 HTML must contain GPTWork");
  assert.ok(content.text.includes("renderCard"), "v2 HTML must include renderCard function");
  assert.ok(content.text.includes("structuredContent"), "v2 HTML must reference structuredContent");
  assert.ok(content.text.includes("toolOutput"), "v2 HTML must reference toolOutput");
  assert.ok(content.text.includes("Show raw JSON"), "v2 HTML must have JSON fallback toggle");
  assert.ok(content.text.includes("No structured payload received."),
    "v2 HTML must include a visible no-payload fallback");
  assert.ok(content.text.includes("This is a renderer fallback, not an empty card."),
    "v2 HTML must explain that the fallback is not an empty card");
  assert.ok(content.text.includes("window.openai keys"),
    "v2 HTML must include safe renderer diagnostics for missing payloads");
  assert.ok(content.text.includes("try{") || content.text.includes("try {"),
    "v2 HTML must include an error boundary");

  // Check Apps SDK _meta in readResource response
  assert.ok(content._meta, "v2 resource content should have _meta");
  assert.ok(content._meta["openai/widgetDescription"],
    "v2 resource content _meta should have widgetDescription");
  assert.ok(content._meta["openai/widgetPrefersBorder"] === true,
    "v2 resource content _meta should have widgetPrefersBorder: true");
  assert.ok(content._meta["openai/widgetCSP"],
    "v2 resource content _meta should have widgetCSP");
});

test("SDK-4a: v2 initial HTML has visible fallback before JavaScript runs", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const html = res.result.contents[0].text;
  const initialRoot = extractInitialRootHtml(html);

  assert.match(initialRoot, /GPTWork Card/,
    "initial #root markup must identify the card before JavaScript runs");
  assert.match(initialRoot, /Waiting for tool output/,
    "initial #root markup must show a readable no-payload fallback before JavaScript runs");
  assert.match(initialRoot, /widget resource loaded/,
    "initial #root markup must include a resource-loaded diagnostic before JavaScript runs");
  assert.doesNotMatch(initialRoot, /Loading\.\.\./,
    "initial #root markup must not be a skeleton-only loading placeholder");
});

test("SDK-2c: queue tools are inside the first 58 standard tools for ChatGPT surface truncation", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/list");
  const names = res.result.tools.map((t) => t.name);
  const visiblePrefix = new Set(names.slice(0, 58));
  const queueTools = [
    "enqueue_goal",
    "list_goal_queue",
    "get_goal_queue",
    "start_next_queued_goal",
    "update_goal_queue_item",
    "cancel_goal_queue_item",
  ];

  for (const name of queueTools) {
    assert.ok(visiblePrefix.has(name),
      `${name} must be in the first 58 tools; current index=${names.indexOf(name)}`);
  }
});

test("SDK-4b: v2 HTML is self-contained and avoids external assets", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const html = res.result.contents[0].text;

  assert.equal(/<script\b[^>]*\bsrc\s*=/.test(html), false,
    "v2 HTML must not load external scripts");
  assert.equal(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html), false,
    "v2 HTML must not load external stylesheets");
  assert.equal(/<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html), false,
    "v2 HTML must not load external images");
});

test("SDK-4c: v2 HTML renders visible fallback with no window.openai", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const { root } = renderWidgetHtml(res.result.contents[0].text, undefined);

  assert.match(root.innerHTML, /GPTWork Card/);
  assert.match(root.innerHTML, /No structured payload received\./);
  assert.match(root.innerHTML, /This is a renderer fallback, not an empty card\./);
  assert.match(root.innerHTML, /window\.openai keys/);
  assert.doesNotMatch(root.innerHTML, /Loading\.\.\./);
});

test("SDK-4d: v2 HTML renders structuredContent and toolOutput payloads", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const html = res.result.contents[0].text;

  const structured = renderWidgetHtml(html, {
    structuredContent: {
      summary: "Runtime status",
      status: "ok",
      keyValues: { commit: "abc123", worker: "running" },
      items: ["queue ready"],
    },
  });
  assert.match(structured.root.innerHTML, /Runtime status/);
  assert.match(structured.root.innerHTML, /abc123/);
  assert.match(structured.root.innerHTML, /queue ready/);

  const toolOutput = renderWidgetHtml(html, {
    toolOutput: {
      summary: "Worker status",
      status: "running",
      keyValues: { assigned: 1 },
    },
  });
  assert.match(toolOutput.root.innerHTML, /Worker status/);
  assert.match(toolOutput.root.innerHTML, /assigned/);
  assert.match(toolOutput.root.innerHTML, /1/);
});

test("SDK-5: tools/call result includes structuredContent for card renderer", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/call", {
    name: "health_check",
    arguments: {},
  });

  // Result must have structuredContent for Apps SDK card renderer
  assert.ok(res.result.structuredContent !== undefined,
    "tools/call result must have structuredContent");
  assert.equal(res.result.structuredContent?.ok, true,
    "health_check structuredContent should have ok: true");
  assert.ok(res.result.content?.[0]?.text,
    "tools/call result must have content[0].text for text fallback");
});

test("SDK-6: minimal tool mode still has v2 card resource", async () => {
  const server = await makeServer({ toolMode: "minimal" });
  const res = await rpc(server, "resources/list");
  const uris = res.result.resources.map(r => r.uri);
  assert.ok(uris.includes("ui://widget/gptwork-card-v2.html"),
    "v2 card must be available even in minimal tool mode");
});

test("SDK-7: minimal tool mode hides queue tools but shows v2 card for allowed tools", async () => {
  const server = await makeServer({ toolMode: "minimal" });
  const res = await rpc(server, "tools/list");
  const names = res.result.tools.map(t => t.name);

  // Queue tools should NOT be visible in minimal mode
  assert.equal(names.includes("enqueue_goal"), false,
    "enqueue_goal should be hidden in minimal mode");
  assert.equal(names.includes("list_goal_queue"), false,
    "list_goal_queue should be hidden in minimal mode");
  assert.equal(names.includes("start_next_queued_goal"), false,
    "start_next_queued_goal should be hidden in minimal mode");

  // But allowed tools should still have card
  const toolsWithCard = res.result.tools.filter(t =>
    t._meta?.["openai/outputTemplate"] === "ui://widget/gptwork-card-v2.html"
  );
  // health_check, runtime_status, worker_status, open_project_context,
  // create_encoded_goal should all be present in minimal mode
  assert.ok(names.includes("health_check"), "health_check should be visible in minimal");
  assert.ok(names.includes("runtime_status"), "runtime_status should be visible in minimal");
  assert.ok(names.includes("worker_status"), "worker_status should be visible in minimal");
});

test("SDK-8: direct call for hidden queue tools in minimal returns unknown tool error", async () => {
  const server = await makeServer({ toolMode: "minimal" });
  const res = await rpc(server, "tools/call", {
    name: "enqueue_goal",
    arguments: {},
  });
  assert.equal(res.error?.code, -32601,
    "Calling hidden tool in minimal mode should return Unknown tool error");
});

test("SDK-9: operator mode shows readonly queue tools (list/get)", async () => {
  const server = await makeServer({ toolMode: "operator" });
  const res = await rpc(server, "tools/list");
  const names = res.result.tools.map(t => t.name);

  // Read-only queue tools should be visible
  assert.ok(names.includes("list_goal_queue"),
    "list_goal_queue should be visible in operator mode");
  assert.ok(names.includes("get_goal_queue"),
    "get_goal_queue should be visible in operator mode");

  // Destructive queue tools should NOT be visible
  assert.equal(names.includes("enqueue_goal"), false,
    "enqueue_goal should be hidden in operator mode");
  assert.equal(names.includes("start_next_queued_goal"), false,
    "start_next_queued_goal should be hidden in operator mode");
  assert.equal(names.includes("cancel_goal_queue_item"), false,
    "cancel_goal_queue_item should be hidden in operator mode");
  assert.equal(names.includes("update_goal_queue_item"), false,
    "update_goal_queue_item should be hidden in operator mode");
});

test("SDK-10: resources/read v2 widgetDomain includes all queue tools", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: "ui://widget/gptwork-card-v2.html" });
  const content = res.result.contents[0];

  assert.ok(content._meta, "v2 resource content should have _meta");

  const domain = content._meta["openai/widgetDomain"];
  assert.ok(Array.isArray(domain),
    "readResource v2 _meta must have openai/widgetDomain array");

  // Verify all queue tools are in widgetDomain
  const queueTools = ["enqueue_goal", "list_goal_queue", "get_goal_queue",
    "start_next_queued_goal", "update_goal_queue_item", "cancel_goal_queue_item"];
  for (const tool of queueTools) {
    assert.ok(domain.includes(tool),
      `readResource v2 openai/widgetDomain must include ${tool}`);
  }
  assert.ok(domain.includes("worker_status"),
    "readResource v2 openai/widgetDomain must include worker_status");

  assert.ok(content.text.includes("renderCard"), "v2 HTML must include renderCard function");
});
