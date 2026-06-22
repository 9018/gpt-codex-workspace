/**
 * apps-sdk-card-smoke.test.mjs — ChatGPT Apps SDK tool card smoke test
 *
 * Verifies that the MCP server exposes the correct capabilities
 * for ChatGPT Apps SDK card rendering:
 *
 * 1. initialize response includes tools.listChanged, resources.listChanged, and extensions["io.modelcontextprotocol/ui"]
 * 2. tools/list descriptors have _meta with openai/outputTemplate and ui.resourceUri pointing to the tool card
 * 3. resources/list includes the versioned GPTWork tool card with Apps SDK metadata
 * 4. resources/read returns HTML content + Apps SDK _meta
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

const TOOL_CARD_URI = "ui://widget/gptwork-tool-card-v2.html";
const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

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
    addEventListener: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    dispatchEvent: (event) => {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
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

  return { root, listeners, context, windowObject };
}

function dispatchWidgetEvent(rendered, type, event = {}) {
  for (const handler of rendered.listeners.get(type) || []) handler({ type, ...event });
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

test("SDK-2: tools/list contains tool card _meta on tools with outputTemplate", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/list");
  const tools = res.result.tools;

  // Count tools with tool card reference
  const withV2Card = tools.filter(t =>
    t._meta?.["openai/outputTemplate"] === TOOL_CARD_URI ||
    t._meta?.ui?.resourceUri === TOOL_CARD_URI
  );
  assert.ok(withV2Card.length >= 10,
    `Expected at least 10 tools with tool card, got ${withV2Card.length}`);

  // Count tools with BOTH outputTemplate and resourceUri
  const withBoth = tools.filter(t =>
    t._meta?.["openai/outputTemplate"] === TOOL_CARD_URI &&
    t._meta?.ui?.resourceUri === TOOL_CARD_URI
  );
  assert.ok(withBoth.length >= 3,
    `Expected at least 3 tools with both outputTemplate and resourceUri, got ${withBoth.length}`);

  // Verify the specific queue tools that should exist now
  const names = tools.map(t => t.name);
  assert.ok(names.includes("enqueue_goal"), "enqueue_goal must be in tools/list");
  assert.ok(names.includes("list_goal_queue"), "list_goal_queue must be in tools/list");
  assert.ok(names.includes("start_next_queued_goal"), "start_next_queued_goal must be in tools/list");

  // Verify queue tools have tool card _meta
  const enqueueTool = tools.find(t => t.name === "enqueue_goal");
  assert.ok(enqueueTool?._meta?.["openai/outputTemplate"] === TOOL_CARD_URI,
    "enqueue_goal must have _meta.openai/outputTemplate pointing to tool card");
  assert.ok(enqueueTool?._meta?.ui?.resourceUri === TOOL_CARD_URI,
    "enqueue_goal must have _meta.ui.resourceUri pointing to tool card");
});

test("SDK-2b: required card-enabled tools expose exact tool card descriptor metadata", async () => {
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
    "update_goal_queue_item",
    "cancel_goal_queue_item",
  ];

  for (const name of requiredCardTools) {
    const descriptor = toolsByName.get(name);
    assert.ok(descriptor, `${name} must be visible in standard tools/list`);
    assert.deepEqual(descriptor._meta, {
      ui: { resourceUri: TOOL_CARD_URI },
      "openai/outputTemplate": TOOL_CARD_URI,
    }, `${name} must expose the exact CodexPro-style descriptor _meta`);
  }
});

test("SDK-3: resources/list includes tool card with Apps SDK metadata", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/list");
  const resources = res.result.resources || [];
  const uris = resources.map(r => r.uri);

  assert.ok(uris.includes(TOOL_CARD_URI),
    "resources/list must include tool card URI");

  const card = resources.find(r => r.uri === TOOL_CARD_URI);
  assert.ok(card, "tool card resource must have an entry");
  assert.equal(card.mimeType, TOOL_CARD_MIME_TYPE,
    `tool card mimeType should be text/html;profile=mcp-app, got ${card.mimeType}`);
  assert.ok(card["openai/widgetDescription"],
    "tool card resource must have openai/widgetDescription");
  assert.equal(card["openai/widgetPrefersBorder"], true,
    "tool card resource must have openai/widgetPrefersBorder: true");
  assert.equal(card.ui?.prefersBorder, true);
  assert.equal(typeof card.ui?.domain, "string");
  assert.match(card.ui.domain, /^https:\/\//, "ui.domain must be a safe hosted domain string");
  assert.deepEqual(card.ui?.csp, { connectDomains: [], resourceDomains: [] });
  assert.equal(card["openai/widgetDomain"], card.ui.domain);
  assert.deepEqual(card["openai/widgetCSP"], { connect_domains: [], resource_domains: [] });
});

test("SDK-4: resources/read tool card returns HTML with Apps SDK _meta", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const content = res.result.contents[0];

  assert.equal(content.uri, TOOL_CARD_URI);
  assert.equal(content.mimeType, TOOL_CARD_MIME_TYPE,
    "tool card readResource should return Apps SDK card mimeType");

  // Check HTML content
  assert.ok(content.text.includes("<!doctype html>") || content.text.startsWith("<!doctype html>"),
    "tool card HTML must start with doctype");
  assert.ok(content.text.includes("GPTWork"), "tool card HTML must contain GPTWork");
  assert.ok(content.text.includes("renderCard"), "tool card HTML must include renderCard function");
  assert.ok(content.text.includes("structuredContent"), "tool card HTML must reference structuredContent");
  assert.ok(content.text.includes("toolOutput"), "tool card HTML must reference toolOutput");
  assert.ok(content.text.includes("Show raw JSON"), "tool card HTML must have JSON fallback toggle");
  assert.ok(content.text.includes("GPTWork card loaded. Waiting for tool result..."),
    "tool card HTML must include a visible no-payload fallback");
  assert.ok(content.text.includes("window.openai keys"),
    "tool card HTML must include safe renderer diagnostics for missing payloads");
  assert.ok(content.text.includes("try{") || content.text.includes("try {"),
    "tool card HTML must include an error boundary");

  // Check Apps SDK _meta in readResource response
  assert.ok(content._meta, "tool card resource content should have _meta");
  assert.ok(content._meta["openai/widgetDescription"],
    "tool card resource content _meta should have widgetDescription");
  assert.ok(content._meta["openai/widgetPrefersBorder"] === true,
    "tool card resource content _meta should have widgetPrefersBorder: true");
  assert.equal(content._meta.ui?.prefersBorder, true);
  assert.equal(typeof content._meta.ui?.domain, "string");
  assert.match(content._meta.ui.domain, /^https:\/\//);
  assert.deepEqual(content._meta.ui?.csp, { connectDomains: [], resourceDomains: [] });
  assert.equal(content._meta["openai/widgetDomain"], content._meta.ui.domain);
  assert.deepEqual(content._meta["openai/widgetCSP"], { connect_domains: [], resource_domains: [] });
});

test("SDK-4a: v2 initial HTML has visible fallback before JavaScript runs", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const html = res.result.contents[0].text;
  const initialRoot = extractInitialRootHtml(html);

  assert.match(initialRoot, /GPTWork Card/,
    "initial #root markup must identify the card before JavaScript runs");
  assert.match(initialRoot, /GPTWork card loaded\. Waiting for tool result/,
    "initial #root markup must show a readable no-payload fallback before JavaScript runs");
  assert.match(initialRoot, /resource loaded/,
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

test("SDK-4b: tool card HTML is self-contained and avoids external assets", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const html = res.result.contents[0].text;

  assert.equal(/<script\b[^>]*\bsrc\s*=/.test(html), false,
    "tool card HTML must not load external scripts");
  assert.equal(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html), false,
    "tool card HTML must not load external stylesheets");
  assert.equal(/<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html), false,
    "tool card HTML must not load external images");
});

test("SDK-4c: tool card HTML renders visible fallback with no window.openai", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const { root } = renderWidgetHtml(res.result.contents[0].text, undefined);

  assert.match(root.innerHTML, /GPTWork Card/);
  assert.match(root.innerHTML, /GPTWork card loaded\. Waiting for tool result/);
  assert.match(root.innerHTML, /source: fallback/);
  assert.match(root.innerHTML, /renders: 1/);
  assert.doesNotMatch(root.innerHTML, /Loading\.\.\./);
});

test("SDK-4c2: tool card HTML renders visible fallback when payload access throws", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const openai = {};
  Object.defineProperty(openai, "structuredContent", {
    get() {
      throw new Error("synthetic payload failure");
    },
  });
  const { root } = renderWidgetHtml(res.result.contents[0].text, openai);

  assert.match(root.innerHTML, /GPTWork Card/);
  assert.match(root.innerHTML, /Renderer error:/);
  assert.match(root.innerHTML, /synthetic payload failure/);
  assert.doesNotMatch(root.innerHTML, /Loading\.\.\./);
});

test("SDK-4d: tool card HTML renders structuredContent and toolOutput payloads", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
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

test("SDK-4e: tool card HTML restores second-open snapshot from widgetState", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  let persistCount = 0;
  const rendered = renderWidgetHtml(res.result.contents[0].text, {
    widgetState: {
      lastToolResult: {
        summary: "Restored runtime snapshot",
        status: "ok",
        keyValues: { source: "widget-state" },
      },
    },
    setWidgetState: () => { persistCount += 1; },
  });

  assert.match(rendered.root.innerHTML, /Restored runtime snapshot/);
  assert.match(rendered.root.innerHTML, /widget-state/);
  assert.match(rendered.root.innerHTML, /source: widgetState/);
  assert.equal(persistCount, 0, "widgetState-only second open must not persist again");
});

test("SDK-4f: tool card HTML renders toolResponseMetadata mcp_tool_result structuredContent", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const rendered = renderWidgetHtml(res.result.contents[0].text, {
    toolResponseMetadata: {
      mcp_tool_result: {
        structuredContent: {
          summary: "Metadata runtime snapshot",
          status: "running",
          keyValues: { source: "metadata" },
        },
      },
    },
  });

  assert.match(rendered.root.innerHTML, /Metadata runtime snapshot/);
  assert.match(rendered.root.innerHTML, /metadata/);
  assert.match(rendered.root.innerHTML, /source: toolResponseMetadata/);
});

test("SDK-4g: tool card HTML persists compact widgetState after successful render", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  let savedState = null;
  renderWidgetHtml(res.result.contents[0].text, {
    toolOutput: { summary: "Persist me", status: "ok", keyValues: { id: "snapshot-1" } },
    setWidgetState: (next) => { savedState = next; },
  });

  assert.equal(savedState?.lastToolResult?.summary, "Persist me");
  assert.equal(savedState?.lastToolResult?.keyValues?.id, "snapshot-1");
  assert.equal(savedState?.lastSource, "toolOutput");
});

test("SDK-4g2: setWidgetState echo does not trigger a render loop", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  let persistCount = 0;
  let savedState = null;
  const openai = {
    toolOutput: { summary: "Echo-safe runtime", status: "ok", keyValues: { id: "echo-1" } },
    setWidgetState: (next) => {
      persistCount += 1;
      savedState = next;
    },
  };

  const rendered = renderWidgetHtml(res.result.contents[0].text, openai);
  assert.equal(persistCount, 1, "initial real tool output should persist once");

  openai.toolOutput = undefined;
  openai.widgetState = savedState;
  rendered.windowObject.dispatchEvent({ type: "openai:set_globals", detail: { widgetState: savedState } });

  assert.match(rendered.root.innerHTML, /Echo-safe runtime/);
  assert.doesNotMatch(rendered.root.innerHTML, /Maximum call stack size exceeded/);
  assert.doesNotMatch(rendered.root.innerHTML, /Renderer error/);
  assert.ok(persistCount <= 1, `setWidgetState echo must not persist recursively; got ${persistCount}`);
  assert.doesNotMatch(rendered.root.innerHTML, /renders: [1-9][0-9]{2,}/,
    "render count must remain bounded after setWidgetState echo");
});

test("SDK-4g3: cyclic payload can render and persist a compact acyclic snapshot", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  let savedState = null;
  const cyclic = {
    summary: "Cyclic runtime",
    status: "ok",
    keyValues: { id: "cyclic-1" },
  };
  cyclic.self = cyclic;

  const rendered = renderWidgetHtml(res.result.contents[0].text, {
    toolOutput: cyclic,
    setWidgetState: (next) => { savedState = next; },
  });

  assert.match(rendered.root.innerHTML, /Cyclic runtime/);
  assert.doesNotMatch(rendered.root.innerHTML, /Renderer error/);
  assert.equal(savedState?.lastToolResult?.summary, "Cyclic runtime");
  assert.equal(savedState?.lastToolResult?.keyValues?.id, "cyclic-1");
  assert.equal(savedState?.lastToolResult?.self, undefined,
    "persisted widgetState snapshot must not include cyclic metadata");
});

test("SDK-4h: delayed openai:set_globals event rehydrates the card", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const openai = {};
  const rendered = renderWidgetHtml(res.result.contents[0].text, openai);
  assert.match(rendered.root.innerHTML, /Waiting for tool result/);

  openai.toolOutput = { summary: "Delayed runtime", status: "ok", keyValues: { event: "set_globals" } };
  dispatchWidgetEvent(rendered, "openai:set_globals", { detail: { toolOutput: openai.toolOutput } });

  assert.match(rendered.root.innerHTML, /Delayed runtime/);
  assert.match(rendered.root.innerHTML, /set_globals/);
  assert.match(rendered.root.innerHTML, /source: toolOutput/);
});

test("SDK-4i: ui notifications tool-result message rehydrates the card", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "resources/read", { uri: TOOL_CARD_URI });
  const rendered = renderWidgetHtml(res.result.contents[0].text, {});

  dispatchWidgetEvent(rendered, "message", {
    data: {
      method: "ui/notifications/tool-result",
      params: {
        result: {
          structuredContent: {
            summary: "Notification runtime",
            status: "ok",
            keyValues: { event: "tool-result" },
          },
        },
      },
    },
  });

  assert.match(rendered.root.innerHTML, /Notification runtime/);
  assert.match(rendered.root.innerHTML, /tool-result/);
  assert.match(rendered.root.innerHTML, /source: event/);
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

test("SDK-5b: card tool result includes tagged structuredContent and non-secret _meta", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/call", {
    name: "runtime_status",
    arguments: {},
  });

  assert.ok(res.result.content?.[0]?.text, "card result must include compact text content");
  assert.equal(res.result.structuredContent?.gptwork_tool, "runtime_status");
  assert.equal(res.result.structuredContent?.gptwork_type, "tool_result");
  assert.ok(res.result.structuredContent?.gptwork_title, "card result must include a display title");
  assert.equal(res.result._meta?.resourceUri, TOOL_CARD_URI);
  assert.equal(res.result._meta?.tool, "runtime_status");
});

test("SDK-6: minimal tool mode still has tool card resource", async () => {
  const server = await makeServer({ toolMode: "minimal" });
  const res = await rpc(server, "resources/list");
  const uris = res.result.resources.map(r => r.uri);
  assert.ok(uris.includes(TOOL_CARD_URI),
    "tool card must be available even in minimal tool mode");
});

test("SDK-7: minimal tool mode hides queue tools but shows tool card for allowed tools", async () => {
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
    t._meta?.["openai/outputTemplate"] === TOOL_CARD_URI
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

test("SDK-10: resources/read tool card widgetDomain includes all queue tools", async () => {
  const server = await makeServer({ toolMode: "standard" });
  const res = await rpc(server, "tools/list");
  const toolsByName = new Map(res.result.tools.map((tool) => [tool.name, tool]));

  const queueTools = ["enqueue_goal", "list_goal_queue", "get_goal_queue",
    "start_next_queued_goal", "update_goal_queue_item", "cancel_goal_queue_item"];
  for (const tool of queueTools) {
    const descriptor = toolsByName.get(tool);
    assert.ok(descriptor, `${tool} must be visible in standard tools/list`);
    assert.equal(descriptor._meta?.["openai/outputTemplate"], TOOL_CARD_URI);
    assert.equal(descriptor._meta?.ui?.resourceUri, TOOL_CARD_URI);
  }

  const callRes = await rpc(server, "tools/call", { name: "list_goal_queue", arguments: {} });
  assert.equal(callRes.result.structuredContent?.gptwork_tool, "list_goal_queue");
  assert.ok(callRes.result.content?.[0]?.text, "list_goal_queue must remain callable");
});
