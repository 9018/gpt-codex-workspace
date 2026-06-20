import test from "node:test";
import assert from "node:assert/strict";
import { createChatGptRequestToolsGroup } from "../src/tool-groups/chatgpt-request-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

test("chatgpt request tool group exposes stable public tool names and schemas", () => {
  const tools = createChatGptRequestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: { syncChatGptRequest: async () => {} },
  });

  assert.deepEqual(Object.keys(tools), [
    "create_chatgpt_request",
    "list_chatgpt_requests",
    "get_chatgpt_request",
    "answer_chatgpt_request",
  ]);

  // create_chatgpt_request: required = ['title', 'prompt']
  assert.deepEqual(tools.create_chatgpt_request.inputSchema.required, ["title", "prompt"]);
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.title, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.prompt, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.source, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.task_id, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.workspace_id, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.escalation_category, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.why_subagents_cannot_decide, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.options_considered, "string");
  assert.equal(tools.create_chatgpt_request.inputSchema.properties.default_if_no_response, "string");

  // list_chatgpt_requests: all optional, status/source/limit
  assert.deepEqual(tools.list_chatgpt_requests.inputSchema.required, []);
  assert.equal(tools.list_chatgpt_requests.inputSchema.properties.status, "string");
  assert.equal(tools.list_chatgpt_requests.inputSchema.properties.source, "string");
  assert.equal(tools.list_chatgpt_requests.inputSchema.properties.limit, "integer");

  // get_chatgpt_request: required = ['request_id']
  assert.deepEqual(tools.get_chatgpt_request.inputSchema.required, ["request_id"]);
  assert.equal(tools.get_chatgpt_request.inputSchema.properties.request_id, "string");

  // answer_chatgpt_request: required = ['request_id', 'response']
  assert.deepEqual(tools.answer_chatgpt_request.inputSchema.required, ["request_id", "response"]);
  assert.equal(tools.answer_chatgpt_request.inputSchema.properties.request_id, "string");
  assert.equal(tools.answer_chatgpt_request.inputSchema.properties.response, "string");
});

test("chatgpt request tool handlers exist", () => {
  const tools = createChatGptRequestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: { syncChatGptRequest: async () => {} },
  });

  assert.equal(typeof tools.create_chatgpt_request.handler, "function");
  assert.equal(typeof tools.list_chatgpt_requests.handler, "function");
  assert.equal(typeof tools.get_chatgpt_request.handler, "function");
  assert.equal(typeof tools.answer_chatgpt_request.handler, "function");
});

test("create_chatgpt_request handler returns warning when escalation is missing", async () => {
  let savedStore = null;
  const tools = createChatGptRequestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {
      load: async () => ({ chatgpt_requests: [], tasks: [], goals: [], activities: [] }),
      save: async (state) => { savedStore = state; },
    },
    github: { syncChatGptRequest: async () => {} },
  });

  const result = await tools.create_chatgpt_request.handler({
    title: "Test question",
    prompt: "What do you think?",
    source: "codex",
  });

  assert.ok(result.warnings, "warnings should be present when escalation is missing");
  assert.ok(result.warnings.length > 0, "at least one warning should describe missing escalation");
  assert.match(result.warnings[0], /escalation/i, "warning should mention escalation");
  assert.equal(result.request.status, "open");
  assert.equal(result.request.source, "codex");
});

test("list_chatgpt_requests handler filters and reverses requests", async () => {
  const mockRequests = [
    { id: "r1", status: "open", source: "codex" },
    { id: "r2", status: "answered", source: "codex" },
    { id: "r3", status: "open", source: "chatgpt" },
  ];

  const tools = createChatGptRequestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {
      load: async () => ({ chatgpt_requests: mockRequests }),
    },
    github: { syncChatGptRequest: async () => {} },
  });

  const allResult = await tools.list_chatgpt_requests.handler({});
  assert.equal(allResult.requests.length, 3);

  const openResult = await tools.list_chatgpt_requests.handler({ status: "open" });
  assert.equal(openResult.requests.length, 2);

  const codexResult = await tools.list_chatgpt_requests.handler({ source: "codex" });
  assert.equal(codexResult.requests.length, 2);

  const limitResult = await tools.list_chatgpt_requests.handler({ limit: 1 });
  assert.equal(limitResult.requests.length, 1);
  assert.equal(limitResult.requests[0].id, "r3"); // reversed = last one first
});

test("create_chatgpt_request description matches expected text", () => {
  const tools = createChatGptRequestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    github: { syncChatGptRequest: async () => {} },
  });

  assert.match(tools.create_chatgpt_request.description, /Ask ChatGPT a question/);
  assert.match(tools.list_chatgpt_requests.description, /coordination requests/);
  assert.match(tools.get_chatgpt_request.description, /Return a ChatGPT coordination request/);
  assert.match(tools.answer_chatgpt_request.description, /Record ChatGPT response/);
});
