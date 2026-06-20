import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubCommentsSyncToolsGroup } from "../src/tool-groups/github-comments-sync-tools-group.mjs";

function fakeTool(description, inputSchema, handler) {
  return { description, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const expectedToolNames = [
  "sync_github_comments",
];

function createGroup(withHandlers = false) {
  const store = withHandlers
    ? {
        load: async () => ({
          tasks: [],
          chatgpt_requests: [],
        }),
      }
    : { load: async () => ({ tasks: [], chatgpt_requests: [] }) };

  const github = withHandlers
    ? {
        getKnownIssues: () => [
          { number: 1, title: "Issue 1" },
          { number: 2, title: "Issue 2" },
        ],
        importResponsesFromComments: async () => [
          { request_id: "chatreq_abc", user: "chatgpt", response: "Let's proceed with option A" },
        ],
      }
    : {
        getKnownIssues: () => [],
        importResponsesFromComments: async () => [],
      };

  return createGithubCommentsSyncToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    github,
  });
}

test("github comments sync tool group exposes sync_github_comments", () => {
  const tools = createGroup();
  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, expectedToolNames);
});

test("sync_github_comments has empty schema (no params)", () => {
  const tools = createGroup();
  assert.deepEqual(tools.sync_github_comments.inputSchema.required, []);
  assert.deepEqual(tools.sync_github_comments.inputSchema.properties, {});
});

test("sync_github_comments has meaningful description", () => {
  const tools = createGroup();
  assert.equal(typeof tools.sync_github_comments.description, "string");
  assert.ok(tools.sync_github_comments.description.length > 10);
  assert.match(tools.sync_github_comments.description, /comment/i);
});

test("sync_github_comments handler is a callable function", () => {
  const tools = createGroup();
  assert.equal(typeof tools.sync_github_comments.handler, "function");
});

test("sync_github_comments handler returns expected shape (no responses)", async () => {
  const tools = createGroup(true);
  // Override to return empty results
  const groupEmpty = createGithubCommentsSyncToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { load: async () => ({ tasks: [], chatgpt_requests: [] }) },
    github: {
      getKnownIssues: () => [],
      importResponsesFromComments: async () => [],
    },
  });
  const result = await groupEmpty.sync_github_comments.handler();

  assert.ok("checked_issues" in result);
  assert.ok("responses_found" in result);
  assert.ok("responses" in result);
  assert.equal(result.checked_issues, 0);
  assert.equal(result.responses_found, 0);
  assert.ok(Array.isArray(result.responses));
  assert.equal(result.responses.length, 0);
});

test("sync_github_comments handler returns expected shape (with responses)", async () => {
  const tools = createGroup(true);
  const result = await tools.sync_github_comments.handler();

  assert.ok("checked_issues" in result);
  assert.ok("responses_found" in result);
  assert.ok("responses" in result);
  assert.equal(result.checked_issues, 2);
  assert.equal(result.responses_found, 1);
  assert.ok(Array.isArray(result.responses));
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].request_id, "chatreq_abc");
  assert.equal(result.responses[0].from, "chatgpt");
});
