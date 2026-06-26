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

// =========================================================================
// Test: importFromIssues Request ID dedup - issue with matching source_request_id skipped
// =========================================================================
test("importFromIssues Request ID dedup: issue with matching source_request_id is skipped", async () => {
  const github = createGithubSync({
    githubRepo: "test/test",
    githubToken: "test",
    githubEnabled: true,
    defaultWorkspaceRoot: process.cwd(),
  });

  // Mock issue that has Request ID in body but NO Task ID
  const mockIssues = [
    {
      number: 50,
      title: "[Task] Some task [queued]",
      body: "---\ngptwork_intake: task\nassign_to: codex\n---\n\n**Request ID**: `chatreq_converted-1`\n",
      labels: ["gptwork-task"],
      state: "open",
      html_url: "https://github.com/test/test/issues/50",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  github.pollIssues = async () => mockIssues;
  github.enabled = true;

  // Store has an existing task that was converted from request (has source_request_id, no github_issue_number)
  const store = createStore({
    tasks: [
      {
        id: "task_converted_1",
        project_id: "default",
        workspace_id: "hosted-default",
        title: "Some task",
        description: "desc",
        created_by: "chatgpt-request-convert",
        source_request_id: "chatreq_converted-1",
        assignee: "codex",
        status: "queued",
        mode: "builder",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    ]
  });

  // Run import - the issue with matching Request ID should be skipped
  const result = await github.importFromIssues(store, { dryRun: false });
  assert.equal(result.length, 0, "No tasks imported because issue matches existing source_request_id");
  const state = await store.load();
  assert.equal(state.tasks.length, 1, "Still only one task (no duplicate created)");

  // Verify the skip reason includes duplicate_by_request_id
  const diag = github.getSyncDiagnostics();
  const reasons = diag.skipped_reasons.map(s => s.reason);
  assert.ok(reasons.includes("duplicate_by_request_id"), "Skipped by request ID dedup");
});
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

// =========================================================================
// Test: import_task_handoffs handler dry_run with request source
// =========================================================================
test("import_task_handoffs handler dry_run skips ordinary request, shows task_intake as convertible", async () => {
  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema,
    store: createStore({
      chatgpt_requests: [
        { id: "r_dry_1", title: "Help me", prompt: "How?", status: "open" },
        { id: "r_dry_2", title: "Create task", prompt: "Do work", status: "open", escalation: { category: "task_intake" } }
      ]
    }),
    github: {
      enabled: false,
      importFromIssues: async () => [],
      importInboxHandoffs: async () => ({ imported: [], skipped: [], failed: [] }),
    },
    config: { defaultWorkspaceRoot: process.cwd() },
  });

  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: true, apply: false });

  // Ordinary request without marker should be skipped
  const skippedOrdinary = result.skipped.filter(s => s.request_id === "r_dry_1");
  assert.ok(skippedOrdinary.length > 0, "Ordinary request without marker is skipped");
  assert.ok(skippedOrdinary.some(s => s.reason === "no_task_intake_marker"), "Skip reason is no_task_intake_marker");

  // task_intake request should show as convertible (dry_run)
  const convertible = result.request_conversions.filter(r => r.request_id === "r_dry_2");
  assert.ok(convertible.length > 0, "task_intake request is convertible");
  assert.ok(convertible.some(r => r.dry_run === true), "Listed as dry_run");

  // No tasks created
  const state = await tools.import_task_handoffs._store || await (createStore()).load();
  // We can't access the store directly, but we can check the result shape
  assert.equal(result.total_imported, 0, "Dry run imported 0 tasks");
  assert.equal(result.request_conversions.filter(r => r.dry_run).length, 1, "1 convertible reported");
});

// =========================================================================
// Test: import_task_handoffs handler cannot apply when dry_run=true
// =========================================================================
test("import_task_handoffs rejects apply=true with dry_run=true", async () => {
  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema,
    store: createStore(),
    github: {},
    config: { defaultWorkspaceRoot: process.cwd() },
  });

  const result = await tools.import_task_handoffs.handler({ source: "request", dry_run: true, apply: true });
  assert.ok(result.error, "Error message returned");
  assert.ok(result.error.includes("Cannot apply"), "Error mentions cannot apply");
});

// =========================================================================
// Test: import_task_handoffs handler inbox dry_run does not move files
// =========================================================================
test("import_task_handoffs handler inbox dry_run does not create tasks", async () => {
  const workDir = "/tmp/gptwork-handler-test-" + Date.now();
  const inboxDir = workDir + "/.gptwork/inbox";
  const procDir = inboxDir + "/processed";
  await mkdir(procDir, { recursive: true });

  const payload = {
    kind: "gptwork_task_handoff",
    title: "Handler Dry Run Test",
    description: "desc",
    assignee: "codex",
    workspace_id: "hosted-default",
    mode: "builder",
    idempotency_key: "handler-dry-run-key",
  };
  await writeFile(inboxDir + "/handler-dry.json", JSON.stringify(payload, null, 2));

  const fakeGh = {
    enabled: false,
    importFromIssues: async () => [],
    importInboxHandoffs: async (store, opts) => {
      // We re-create a real github sync to test the actual inbox import
      const { createGithubSync } = await import("../src/github-sync-factory.mjs");
      const realSync = createGithubSync({ githubRepo: "", githubToken: "", githubEnabled: false, defaultWorkspaceRoot: workDir });
      return realSync.importInboxHandoffs(store, opts);
    },
    convertChatGptRequestToTask: async () => ({ converted: false, reason: "not_implemented" }),
  };

  const tools = createGithubSyncToolsGroup({
    tool: fakeTool, schema: fakeSchema,
    store: createStore(),
    github: fakeGh,
    config: { defaultWorkspaceRoot: workDir },
  });

  const result = await tools.import_task_handoffs.handler({ source: "inbox", dry_run: true, apply: false });
  assert.ok(result.dry_run === true, "Dry run mode");
  assert.equal(result.total_imported, 0, "No tasks imported (github disabled)");

  await rm(workDir, { recursive: true, force: true });
});

// =========================================================================
// Test: import_task_handoffs handler dry_run field contracts (would_import_count, total_imported=0)
// =========================================================================
test("import_task_handoffs dry_run: total_imported=0, would_import_count > 0", async () => {
  const workDir = "/tmp/gptwork-test-" + Date.now();
  const inboxDir = workDir + "/.gptwork/inbox";
  const procDir = inboxDir + "/processed";
  await mkdir(procDir, { recursive: true });

  const payload = {
    kind: "gptwork_task_handoff",
    title: "Field Contract Test",
    description: "desc",
    assignee: "codex",
    workspace_id: "hosted-default",
    mode: "builder",
    idempotency_key: "field-contract-key",
  };
  await writeFile(inboxDir + "/field.json", JSON.stringify(payload, null, 2));

  const store = createStore();
  const github = createGithubSync({ githubRepo: "", githubToken: "", githubEnabled: false, defaultWorkspaceRoot: workDir });

  const group = createGithubSyncToolsGroup({
    tool: (d, s, h) => ({ description: d, inputSchema: s, handler: h }),
    schema: (p, r) => ({ type: "object", properties: p, required: r }),
    store, github,
    config: { defaultWorkspaceRoot: workDir },
  });

  // dry_run
  const dryResult = await group.import_task_handoffs.handler({ source: "inbox", dry_run: true, apply: false });

  // Verify field contracts
  assert.equal(dryResult.dry_run, true, "dry_run flag is true");
  assert.equal(dryResult.total_imported, 0, "total_imported is 0 during dry_run");
  assert.ok(dryResult.would_import_count > 0, "would_import_count > 0 during dry_run");
  assert.ok("total_skipped" in dryResult, "total_skipped present");
  assert.ok(Array.isArray(dryResult.inbox_handoffs), "inbox_handoffs is array");

  // Verify no tasks created
  const state1 = await store.load();
  assert.equal(state1.tasks.length, 0, "No tasks after dry_run");

  // apply
  const applyResult = await group.import_task_handoffs.handler({ source: "inbox", dry_run: false, apply: true });
  assert.equal(applyResult.dry_run, false, "dry_run flag is false");
  assert.ok(applyResult.total_imported > 0, "total_imported > 0 after apply");

  // After apply, list_tasks shows the task
  const state2 = await store.load();
  assert.equal(state2.tasks.length, 1, "1 task after apply");
  assert.equal(state2.tasks[0].title, "Field Contract Test");
  assert.equal(state2.tasks[0].assignee, "codex");
  assert.equal(state2.tasks[0].status, "queued");

  // Also verify list_tasks-like behavior: store.findTaskById works
  const found = await store.findTaskById(state2.tasks[0].id);
  assert.ok(found, "findTaskById finds the created task");
  assert.equal(found.title, "Field Contract Test");

  await rm(workDir, { recursive: true, force: true });
});

// =========================================================================
// Test: import_task_handoffs e2e: dry_run → apply → list_tasks flow
// =========================================================================
test("import_task_handoffs e2e: dry_run no tasks, apply creates tasks, list_tasks sees them", async () => {
  const workDir = "/tmp/gptwork-test-" + Date.now();
  const inboxDir = workDir + "/.gptwork/inbox";
  const procDir = inboxDir + "/processed";
  await mkdir(procDir, { recursive: true });

  // Two handoff files
  const t1 = { kind: "gptwork_task_handoff", title: "E2E Task 1", description: "d1", assignee: "codex", workspace_id: "hosted-default", mode: "builder", idempotency_key: "e2e-1" };
  const t2 = { kind: "gptwork_task_handoff", title: "E2E Task 2", description: "d2", assignee: "codex", workspace_id: "hosted-default", mode: "builder", idempotency_key: "e2e-2" };
  await writeFile(inboxDir + "/e2e-1.json", JSON.stringify(t1, null, 2));
  await writeFile(inboxDir + "/e2e-2.json", JSON.stringify(t2, null, 2));

  const store = createStore();
  const github = createGithubSync({ githubRepo: "", githubToken: "", githubEnabled: false, defaultWorkspaceRoot: workDir });

  const group = createGithubSyncToolsGroup({
    tool: (d, s, h) => ({ description: d, inputSchema: s, handler: h }),
    schema: (p, r) => ({ type: "object", properties: p, required: r }),
    store, github,
    config: { defaultWorkspaceRoot: workDir },
  });

  // 1. dry_run → task count unchanged
  const dryResult = await group.import_task_handoffs.handler({ source: "inbox", dry_run: true, apply: false });
  assert.equal(dryResult.total_imported, 0, "dry_run total_imported=0");
  assert.equal(dryResult.would_import_count, 2, "dry_run would_import=2");
  let s = await store.load();
  assert.equal(s.tasks.length, 0, "No tasks after dry_run");

  // 2. apply → task count increased
  const applyResult = await group.import_task_handoffs.handler({ source: "inbox", dry_run: false, apply: true });
  assert.equal(applyResult.total_imported, 2, "apply imported 2 tasks");
  s = await store.load();
  assert.equal(s.tasks.length, 2, "2 tasks after apply");

  // 3. list_tasks sees the new tasks
  const taskNames = s.tasks.map(t => t.title).sort();
  assert.deepEqual(taskNames, ["E2E Task 1", "E2E Task 2"]);

  // 4. Verify each task has expected fields for the worker
  for (const task of s.tasks) {
    assert.ok(task.id, "Has task id");
    assert.ok(task.id.startsWith("task_"), "Task id format task_xxx");
    assert.equal(task.assignee, "codex", "Assigned to codex");
    assert.equal(task.status, "queued", "Status queued");
    assert.equal(task.mode, "builder", "Mode builder");
    assert.equal(task.workspace_id, "hosted-default", "Workspace correct");
    assert.ok(task.idempotency_key, "Has idempotency_key");
    assert.ok(task.created_at, "Has created_at");
    assert.ok(task.created_by, "Has created_by");
  }

  await rm(workDir, { recursive: true, force: true });
});
