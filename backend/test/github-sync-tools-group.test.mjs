import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubSyncToolsGroup } from "../src/tool-groups/github-sync-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const expectedToolNames = [
  "import_task_handoffs",
  "sync_from_github",
  "sync_to_github",
];

function createGroup(withHandlers = false) {
  const store = withHandlers
    ? {
        load: async () => ({
          tasks: [
            { id: "t1", title: "Task 1", status: "open" },
            { id: "t2", title: "Task 2", status: "completed" },
          ],
          chatgpt_requests: [
            { id: "r1", status: "open" },
            { id: "r2", status: "answered" },
          ],
        }),
      }
    : { load: async () => ({ tasks: [], chatgpt_requests: [] }) };

  const github = withHandlers
    ? {
        enabled: true,
        syncAllTasks: async (tasks) => tasks.map((t) => ({ id: t.id, title: t.title, synced: true })),
        syncAllRequests: async (requests) => requests.map((r) => ({ id: r.id, synced: true })),
        importFromIssues: async () => [],
        importResponsesFromComments: async () => [],
        getSyncDiagnostics: () => ({
          last_sync_at: null,
          last_sync_ok: null,
          last_sync_error: null,
          last_raw_api_issue_count: 5,
          last_imported_tasks: 0,
          last_imported_responses: 0,
          last_scanned_issue_count: 3,
          skipped_reasons: [{ reason: "test_skip", details: null, time: new Date().toISOString() }],
        }),
      }
    : {};

  return createGithubSyncToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    github,
  });
}

test("github sync tool group exposes sync_to_github and sync_from_github", () => {
  const tools = createGroup();
  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("github sync tool tools have empty schemas (no params)", () => {
  const tools = createGroup();

  // Both tools have schema({}) — no properties, no required
  assert.deepEqual(tools.sync_to_github.inputSchema.required, []);
  assert.deepEqual(tools.sync_to_github.inputSchema.properties, {});

  assert.deepEqual(tools.sync_from_github.inputSchema.required, []);
  assert.deepEqual(tools.sync_from_github.inputSchema.properties, {});
});

test("github sync tool tools have meaningful descriptions", () => {
  const tools = createGroup();

  assert.equal(typeof tools.sync_to_github.description, "string");
  assert.ok(tools.sync_to_github.description.length > 10);
  assert.match(tools.sync_to_github.description, /sync/i);

  assert.equal(typeof tools.sync_from_github.description, "string");
  assert.ok(tools.sync_from_github.description.length > 10);
  assert.match(tools.sync_from_github.description, /import/i);
});

test("github sync tool handlers are callable functions", () => {
  const tools = createGroup();

  assert.equal(typeof tools.sync_to_github.handler, "function");
  assert.equal(typeof tools.sync_from_github.handler, "function");
});

test("sync_to_github handler returns expected shape", async () => {
  const tools = createGroup(true);
  const result = await tools.sync_to_github.handler();

  assert.ok(result.options !== undefined);
  assert.ok("github_repo" in result.options);
  assert.ok("github_enabled" in result.options);
  assert.equal(result.synced_tasks, 1); // only open tasks
  assert.equal(result.synced_requests, 1); // only open requests
  assert.ok(Array.isArray(result.taskResults));
  assert.ok(Array.isArray(result.requestResults));
});

test("sync_from_github handler returns expected shape", async () => {
  const tools = createGroup(true);
  const result = await tools.sync_from_github.handler();

  assert.equal(typeof result.imported_tasks, "number");
  assert.ok(Array.isArray(result.tasks));
  assert.equal(typeof result.imported_responses, "number");
  assert.ok(Array.isArray(result.responses));
  // Enhanced diagnostics fields
  assert.ok("last_sync_at" in result);
  assert.ok("last_sync_ok" in result);
  assert.ok("last_sync_error" in result);
  assert.ok("last_imported_tasks" in result);
  assert.ok("last_imported_responses" in result);
  assert.ok("last_scanned_issue_count" in result);
  assert.ok("last_raw_api_issue_count" in result);
  assert.ok("skipped_reasons" in result);
  assert.ok(Array.isArray(result.skipped_reasons));
  assert.equal(result.last_raw_api_issue_count, 5);
  assert.equal(result.last_scanned_issue_count, 3);
});

// =========================================================================
// import_task_handoffs: Schema validation
// =========================================================================

test("import_task_handoffs is in tool group", () => {
  const tools = createGroup();
  assert.ok(tools.import_task_handoffs !== undefined, "import_task_handoffs should be exposed");
});

test("import_task_handoffs has correct schema fields", () => {
  const tools = createGroup();
  const schema = tools.import_task_handoffs.inputSchema;
  assert.ok(schema, "should have inputSchema");
  assert.equal(schema.type, "object");
  // source: enum with github|request|inbox|all
  assert.ok(schema.properties.source, "should have source property");
  assert.equal(schema.properties.source.type, "string");
  assert.ok(Array.isArray(schema.properties.source.enum), "source should have enum");
  const sourceEnum = schema.properties.source.enum;
  ["github", "request", "inbox", "all"].forEach(v => {
    assert.ok(sourceEnum.includes(v), `source enum should include "${v}"`);
  });
  // dry_run: boolean default true
  assert.ok(schema.properties.dry_run, "should have dry_run property");
  assert.equal(schema.properties.dry_run.type, "boolean");
  assert.equal(schema.properties.dry_run.default, true);
  // apply: boolean default false
  assert.ok(schema.properties.apply, "should have apply property");
  assert.equal(schema.properties.apply.type, "boolean");
  assert.equal(schema.properties.apply.default, false);
  // source is required
  assert.ok(Array.isArray(schema.required));
  assert.ok(schema.required.includes("source"), "source should be required");
});

// =========================================================================
// import_task_handoffs: dry_run/apply interaction
// =========================================================================

test("import_task_handoffs: apply=true + dry_run=true returns error", async () => {
  const tools = createGroup(true);
  const result = await tools.import_task_handoffs.handler({ source: "all", dry_run: true, apply: true });
  assert.ok(result.error, "should return error when apply=true and dry_run=true");
  assert.ok(result.error.includes("dry_run"), "error should mention dry_run");
});

test("import_task_handoffs: dry_run=true + source=request has no side effects", async () => {
  const tools = createGroup(true);
  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: true, apply: false });
  assert.equal(result.error, undefined, "dry_run should not produce error");
  assert.equal(result.dry_run, true, "should indicate dry_run");
  assert.equal(result.total_imported, 0, "dry_run should not import");
});

test("import_task_handoffs: dry_run=true + source=github has no side effects", async () => {
  const tools = createGroup(true);
  const result = await tools.import_task_handoffs.handler({ source: "github", dry_run: true, apply: false });
  assert.equal(result.error, undefined);
  assert.equal(result.dry_run, true);
  assert.equal(result.total_imported, 0);
});

test("import_task_handoffs: dry_run=true + source=inbox has no side effects", async () => {
  const tools = createGroup(true);
  const result = await tools.import_task_handoffs.handler({ source: "inbox", dry_run: true, apply: false });
  assert.equal(result.error, undefined);
  assert.equal(result.dry_run, true);
  assert.equal(result.total_imported, 0);
});

// =========================================================================
// import_task_handoffs: Request filtering
// =========================================================================

test("import_task_handoffs: request without task-intake marker is skipped", async () => {
  const store = {
    load: async () => ({
      tasks: [],
      chatgpt_requests: [
        { id: "r1", status: "open", title: "Help me debug", prompt: "How do I fix X?" },
      ],
    }),
  };
  const github = {
    importFromIssues: async () => [],
    importInboxHandoffs: async () => ({ imported: [], skipped: [], failed: [] }),
  };
  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema, store, github,
  });
  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: true, apply: false });
  assert.equal(result.error, undefined);
  assert.equal(result.request_conversions.length, 0, "no request should be convertible");
  assert.equal(result.total_imported, 0);
  // Should skip the request
  const skippedNos = result.skipped.filter(s => s.reason === "no_task_intake_marker");
  assert.equal(skippedNos.length, 1, "one request should be skipped for no marker");
});

test("import_task_handoffs: request with escalation.task_intake is convertible", async () => {
  const store = {
    load: async () => ({
      tasks: [],
      chatgpt_requests: [
        { id: "r2", status: "open", title: "Task intake", prompt: "do this work", escalation: { category: "task_intake" } },
      ],
    }),
  };
  const github = {
    importFromIssues: async () => [],
    importInboxHandoffs: async () => ({ imported: [], skipped: [], failed: [] }),
    convertChatGptRequestToTask: async (store, reqId) => ({ converted: true, task_id: "new_task_1", title: "Converted task" }),
  };
  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema, store, github,
  });
  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: true, apply: false });
  assert.equal(result.error, undefined);
  assert.equal(result.request_conversions.length, 1, "task_intake request should be convertible in dry_run");
  assert.equal(result.request_conversions[0].convertible, true);
});

// =========================================================================
// import_task_handoffs: Idempotency
// =========================================================================

test("import_task_handoffs: already converted request is skipped (idempotent)", async () => {
  const store = {
    load: async () => ({
      tasks: [
        { id: "existing_task", title: "Already converted", source_request_id: "r_dup", status: "queued" },
      ],
      chatgpt_requests: [
        { id: "r_dup", status: "open", title: "Task intake", prompt: "duplicate", escalation: { category: "task_intake" } },
      ],
    }),
  };
  const github = {
    importFromIssues: async () => [],
    importInboxHandoffs: async () => ({ imported: [], skipped: [], failed: [] }),
  };
  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema, store, github,
  });
  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: false, apply: false });
  // The request should be skipped because it has an existing task
  const skipped = result.skipped.filter(s => s.reason === "already_converted");
  assert.equal(skipped.length, 1, "duplicate request should be skipped");
  assert.equal(skipped[0].task_id, "existing_task", "should reference existing task id");
});

// =========================================================================
// import_task_handoffs: Default parameters
// =========================================================================

test("import_task_handoffs: default parameters are dry_run=true, apply=false", async () => {
  const tools = createGroup();
  // The schema defaults
  assert.equal(tools.import_task_handoffs.inputSchema.properties.dry_run.default, true);
  assert.equal(tools.import_task_handoffs.inputSchema.properties.apply.default, false);
});
