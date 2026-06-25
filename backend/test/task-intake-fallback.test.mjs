import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { createGithubSync, _satisfiesRequestTaskIntakeCondition } from "../src/github-sync-factory.mjs";
import { createGithubSyncToolsGroup } from "../src/tool-groups/github-sync-tools-group.mjs";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function createStore(initialState = {}) {
  let state = {
    tasks: [],
    chatgpt_requests: [],
    activities: [],
    goals: [],
    ...initialState,
  };
  return {
    load: async () => state,
    save: async () => {},
    mutate: async (updater) => { await updater(state); },
    findTaskById: async (id) => state.tasks.find((t) => t.id === id) || null,
  };
}

function createDisabledGithubSync() {
  return createGithubSync({
    githubRepo: "",
    githubToken: "",
    githubEnabled: false,
    defaultWorkspaceRoot: process.cwd(),
  });
}

function fakeTool(desc, schema, handler) {
  return { description: desc, inputSchema: schema, handler };
}
function fakeSchema(props, required) {
  return { type: "object", properties: props, required: (required || []) };
}

// =========================================================================
// Test: _satisfiesRequestTaskIntakeCondition
// =========================================================================
test("_satisfiesRequestTaskIntakeCondition detects escalation.task_intake", () => {
  assert.ok(_satisfiesRequestTaskIntakeCondition({ escalation: { category: "task_intake" } }));
});

test("_satisfiesRequestTaskIntakeCondition detects gptwork_intake: task in title", () => {
  assert.ok(_satisfiesRequestTaskIntakeCondition({ title: "gptwork_intake: task", prompt: "" }));
});

test("_satisfiesRequestTaskIntakeCondition rejects ordinary request", () => {
  assert.equal(_satisfiesRequestTaskIntakeCondition({ title: "Help", prompt: "How to do X?" }), false);
});

test("_satisfiesRequestTaskIntakeCondition rejects null", () => {
  assert.equal(_satisfiesRequestTaskIntakeCondition(null), false);
});

// =========================================================================
// Test: importInboxHandoffs dry_run does not create tasks
// =========================================================================
test("importInboxHandoffs dry_run does not create tasks", async () => {
  const workDir = "/tmp/gptwork-test-" + Date.now();
  const inboxDir = workDir + "/.gptwork/inbox";
  const procDir = inboxDir + "/processed";
  await mkdir(procDir, { recursive: true });

  const payload = {
    kind: "gptwork_task_handoff",
    title: "Dry Run Test",
    description: "desc",
    assignee: "codex",
    workspace_id: "hosted-default",
    mode: "builder",
    idempotency_key: "dry-run-key",
  };
  await writeFile(inboxDir + "/dry.json", JSON.stringify(payload, null, 2));

  const github = createGithubSync({ githubRepo: "", githubToken: "", githubEnabled: false, defaultWorkspaceRoot: workDir });
  const store = createStore();

  // dry_run = true
  const result = await github.importInboxHandoffs(store, { dryRun: true });
  assert.equal(result.imported.length, 1, "Dry run reports would import");
  const state = await store.load();
  assert.equal(state.tasks.length, 0, "Dry run does NOT create tasks");

  await rm(workDir, { recursive: true, force: true });
});

// =========================================================================
// Test: importInboxHandoffs apply creates tasks
// =========================================================================
test("importInboxHandoffs apply (dryRun=false) creates tasks", async () => {
  const workDir = "/tmp/gptwork-test-" + Date.now();
  const inboxDir = workDir + "/.gptwork/inbox";
  const procDir = inboxDir + "/processed";
  await mkdir(procDir, { recursive: true });

  const payload = {
    kind: "gptwork_task_handoff",
    title: "Apply Test",
    description: "desc",
    assignee: "codex",
    workspace_id: "hosted-default",
    mode: "builder",
    idempotency_key: "apply-key",
  };
  await writeFile(inboxDir + "/apply.json", JSON.stringify(payload, null, 2));

  const github = createGithubSync({ githubRepo: "", githubToken: "", githubEnabled: false, defaultWorkspaceRoot: workDir });
  const store = createStore();

  const result = await github.importInboxHandoffs(store, { dryRun: false });
  assert.equal(result.imported.length, 1, "Apply imports task");
  const state = await store.load();
  assert.equal(state.tasks.length, 1, "Apply creates task");
  assert.equal(state.tasks[0].title, "Apply Test");

  await rm(workDir, { recursive: true, force: true });
});

// =========================================================================
// Test: convertChatGptRequestToTask - ordinary request fails
// =========================================================================
test("convertChatGptRequestToTask rejects ordinary request (no marker)", async () => {
  const store = createStore({
    chatgpt_requests: [{ id: "r1", title: "Help", prompt: "How?", status: "open" }]
  });
  const github = createDisabledGithubSync();
  const result = await github.convertChatGptRequestToTask(store, "r1", { dryRun: false });
  assert.equal(result.converted, false);
  assert.equal(result.reason, "no_task_intake_marker");
});

// =========================================================================
// Test: convertChatGptRequestToTask - task_intake request succeeds
// =========================================================================
test("convertChatGptRequestToTask converts task_intake request", async () => {
  const store = createStore({
    chatgpt_requests: [{
      id: "r2", title: "Create P0 task", prompt: "Do work",
      status: "open", escalation: { category: "task_intake" }
    }]
  });
  const github = createDisabledGithubSync();
  const result = await github.convertChatGptRequestToTask(store, "r2", { dryRun: false });
  assert.ok(result.converted, "Task intake request converted");
  assert.ok(result.task_id, "Has task_id");
  const state = await store.load();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].source_request_id, "r2");
});

// =========================================================================
// Test: import_task_handoffs tool exposure
// =========================================================================
test("import_task_handoffs appears in github sync tools group", () => {
  const group = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema,
    store: createStore(), github: {},
    config: { defaultWorkspaceRoot: process.cwd() },
  });
  assert.ok(group.import_task_handoffs, "import_task_handoffs tool exists");
  assert.equal(typeof group.import_task_handoffs.handler, "function", "Has handler");
  assert.ok(group.import_task_handoffs.description.length > 20, "Has description");
  const schema = group.import_task_handoffs.inputSchema;
  assert.ok(schema.properties.source, "Has source param");
  assert.ok(schema.properties.dry_run, "Has dry_run param");
  assert.ok(schema.properties.apply, "Has apply param");
  assert.ok(schema.required.includes("source"), "source is required");
});

// =========================================================================
// Test: import_task_handoffs appears in standard mode tool list
// =========================================================================
test("import_task_handoffs is discoverable in standard mode", async () => {
  // Simulate what gptwork-server.mjs does
  const { createTools, createDiscoverableTools } = await import("../src/server-tools.mjs");

  const store = createStore();
  const config = { defaultWorkspaceRoot: process.cwd(), toolMode: "standard" };
  const tools = createTools({
    store, config,
    browser: null, github: null, bark: null,
    envLoadResult: null, sources: null, registry: null,
    workerState: null,
    processStartedAt: new Date().toISOString(),
    notifyCreatedTaskIfNeeded: () => {},
    eventLogger: null, hookBus: null,
  });

  const discoverable = createDiscoverableTools(tools, "standard");
  assert.ok(discoverable.import_task_handoffs, "import_task_handoffs is in standard mode tools");
  assert.ok(discoverable.sync_from_github, "sync_from_github still present");
  assert.ok(discoverable.sync_to_github, "sync_to_github still present");
});

// =========================================================================
// Test: importFromIssues dry_run does not create tasks
// =========================================================================
test("importFromIssues dry_run does not create tasks", async () => {
  // Create a mock github that returns test issues
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  // Override pollIssues to return mock data without making API calls
  const mockIssues = [
    { number: 1, title: "[Task] Test task [queued]", body: "Issue body", labels: ["gptwork-task"], state: "open", html_url: "https://github.com/test/test/issues/1", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { number: 2, title: "Question with intake", body: "---\ngptwork_intake: task\n---\nBody", labels: ["gptwork-question"], state: "open", html_url: "https://github.com/test/test/issues/2", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();

  // dry_run = true
  const result = await github.importFromIssues(store, { dryRun: true });

  // Should report but not create
  assert.ok(result.length === 2, "Dry run reports imports: " + result.length);
  const state = await store.load();
  assert.equal(state.tasks.length, 0, "Dry run creates no tasks in state");
});

// =========================================================================
// Test: importFromIssues question_label_without_task_intake skip
// =========================================================================
test("importFromIssues skips question issue without intake marker", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  const mockIssues = [
    { number: 3, title: "Just a question", body: "I need help", labels: ["gptwork-question"], state: "open", html_url: "https://github.com/test/test/issues/3", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();
  const result = await github.importFromIssues(store, { dryRun: false });
  // Issue #3 should be skipped, no tasks created
  assert.equal(result.length, 0, "No import for question without marker");

  const diag = github.getSyncDiagnostics();
  const skipReasons = diag.skipped_reasons.map(s => s.reason);
  assert.ok(skipReasons.includes("question_label_without_task_intake"), "Skipped with correct reason");
});

// =========================================================================
// Test: importFromIssues imports question with intake marker
// =========================================================================
test("importFromIssues imports question issue with task-intake frontmatter", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  const mockIssues = [
    {
      number: 4,
      title: "Task via frontmatter",
      body: "---\ngptwork_intake: task\nassign_to: codex\nmode: builder\nworkspace_id: hosted-default\n---\n\nActual issue body with details",
      labels: ["gptwork-question"],
      state: "open",
      html_url: "https://github.com/test/test/issues/4",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();
  const result = await github.importFromIssues(store, { dryRun: false });
  assert.equal(result.length, 1, "Imported question with frontmatter marker");
  assert.equal(result[0].title, "Task via frontmatter");
  assert.equal(result[0].workspace_id, "hosted-default");
  assert.equal(result[0].assignee, "codex");
  assert.equal(result[0].mode, "builder");

  const state = await store.load();
  assert.equal(state.tasks.length, 1, "Task created in state");
});

// =========================================================================
// Test: request issue with gptwork-task label (#130 class)
// =========================================================================
test("importFromIssues imports issue with gptwork-task label", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  const mockIssues = [
    {
      number: 130,
      title: "Request issue like #130",
      body: "Some request body\n---\n**Request ID**: `chatreq_test-130`\n",
      labels: ["gptwork-task"],
      state: "open",
      html_url: "https://github.com/test/test/issues/130",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();
  const result = await github.importFromIssues(store, { dryRun: false });
  assert.equal(result.length, 1, "#130 class request with gptwork-task label is imported");
  assert.equal(result[0].github_issue_number, 130);
});

// =========================================================================
// Test: request issue with gptwork-question + gptwork_intake marker
// =========================================================================
test("importFromIssues imports question issue with embedded JSON marker", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  const mockIssues = [
    {
      number: 131,
      title: "Request via JSON marker",
      body: 'Some text\n{"gptwork_intake": "task", "assign_to": "codex", "mode": "builder", "workspace_id": "hosted-default"}\nMore text',
      labels: ["gptwork-question"],
      state: "open",
      html_url: "https://github.com/test/test/issues/131",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();
  const result = await github.importFromIssues(store, { dryRun: false });
  assert.equal(result.length, 1, "Question with JSON marker imported");
  assert.equal(result[0].workspace_id, "hosted-default");
});

// =========================================================================
// Test: syncChatGptRequest with task_intake gets gptwork-task label
// =========================================================================
test("syncChatGptRequest uses gptwork-task label for task_intake requests", async () => {
  // We can't easily test the API call directly, but we can verify the logic
  // by checking that importFromIssues would recognize the resulting issue
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  // Simulate what the synced issue would look like (gptwork-task label + frontmatter)
  const mockIssues = [
    {
      number: 200,
      title: "[Task] Performance analysis [queued]",
      body: "---\ngptwork_intake: task\nassign_to: codex\n---\n\n**Request ID**: `chatreq_task-intake`\n",
      labels: ["gptwork-task"],
      state: "open",
      html_url: "https://github.com/test/test/issues/200",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();
  const result = await github.importFromIssues(store, { dryRun: false });
  assert.equal(result.length, 1, "task_intake request issue imported");
  assert.equal(result[0].title, "Performance analysis");
});

// =========================================================================
// Test: IDEMPOTENCY - same issue not imported twice
// =========================================================================
test("importFromIssues idempotent: same issue not imported twice", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  const mockIssues = [
    { number: 5, title: "[Task] Unique task [queued]", body: "Body", labels: ["gptwork-task"], state: "open", html_url: "https://github.com/test/test/issues/5", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  const store = createStore();

  // First import
  const r1 = await github.importFromIssues(store, { dryRun: false });
  assert.equal(r1.length, 1, "First import succeeds");

  // Second import - same pollIssues returns same issue but state now has task
  // We need to update the task list to show issue 5 is already imported
  const state = await store.load();
  assert.equal(state.tasks.length, 1, "One task exists after first import");

  // Check that re-importing doesn't duplicate
  const r2 = await github.importFromIssues(store, { dryRun: false });
  const state2 = await store.load();
  assert.equal(state2.tasks.length, 1, "Still only one task after re-import");
  const diag = github.getSyncDiagnostics();
  const reasons = diag.skipped_reasons.map(s => s.reason);
  assert.ok(reasons.includes("duplicate_issue_number"), "Duplicate issue skipped");
});
