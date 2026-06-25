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
