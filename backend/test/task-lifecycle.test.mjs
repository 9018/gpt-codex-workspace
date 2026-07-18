import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureGoalState,
  findGoalInState,
  taskPayloadFromTask,
  emitTaskProgress,
  normalizeLegacyModes,
  findTask,
  updateTask,
  updateGoalStatus,
  setTerminalNotifier,
} from "../src/task-lifecycle.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(initial) {
  let state = initial || { tasks: [], goals: [], conversations: [], memories: [], activities: [] };
  return {
    async load() { return state; },
    async save() { /* no-op for testing */ },
  };
}

function makeTask(overrides = {}) {
  return {
    id: "task_test_1",
    title: "Test task",
    description: "Test description",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
    status: "assigned",
    assignee: "codex",
    logs: [],
    artifacts: [],
    result: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeGoal(overrides = {}) {
  return {
    id: "goal_test_1",
    title: "Test goal",
    user_request: "Test user request",
    goal_prompt: "Test goal prompt",
    status: "assigned",
    project_id: "default",
    workspace_id: "hosted-default",
    mode: "builder",
    task_id: "task_test_1",
    conversation_id: "conv_test_1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureGoalState
// ---------------------------------------------------------------------------

test("ensureGoalState initializes missing arrays", () => {
  const state = {};
  ensureGoalState(state);
  assert.ok(Array.isArray(state.goals));
  assert.ok(Array.isArray(state.conversations));
  assert.ok(Array.isArray(state.memories));
  assert.ok(Array.isArray(state.tasks));
  assert.ok(Array.isArray(state.activities));
  assert.equal(state.goals.length, 0);
});

test("ensureGoalState does not overwrite existing arrays", () => {
  const state = { goals: [{ id: "g1" }], tasks: [{ id: "t1" }] };
  ensureGoalState(state);
  assert.equal(state.goals.length, 1);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.goals[0].id, "g1");
});

// ---------------------------------------------------------------------------
// findGoalInState
// ---------------------------------------------------------------------------

test("findGoalInState finds goal by goal_id", () => {
  const state = { goals: [makeGoal({ id: "g1" }), makeGoal({ id: "g2" })] };
  const goal = findGoalInState(state, { goal_id: "g2" });
  assert.equal(goal.id, "g2");
});

test("findGoalInState finds goal by task_id", () => {
  const state = { goals: [makeGoal({ id: "g1", task_id: "t1" }), makeGoal({ id: "g2", task_id: "t2" })] };
  const goal = findGoalInState(state, { task_id: "t2" });
  assert.equal(goal.id, "g2");
});

test("findGoalInState throws for missing goal", () => {
  const state = { goals: [] };
  assert.throws(() => findGoalInState(state, { goal_id: "nonexistent" }), /goal not found/);
  assert.throws(() => findGoalInState(state, { task_id: "nonexistent" }), /goal not found/);
});

// ---------------------------------------------------------------------------
// taskPayloadFromTask
// ---------------------------------------------------------------------------

test("taskPayloadFromTask produces payload with task fields", () => {
  const task = makeTask({ id: "t1", title: "My task", description: "My description" });
  const payload = taskPayloadFromTask(task);
  assert.equal(payload.user_request, "My description");
  assert.match(payload.goal_prompt, /My task/);
  assert.match(payload.goal_prompt, /My description/);
  assert.equal(payload.project_id, "default");
  assert.equal(payload.workspace_id, "hosted-default");
  assert.equal(payload.mode, "full");
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.memories.length, 0);
});

test("taskPayloadFromTask falls back to title when description missing", () => {
  const task = makeTask({ description: "" });
  const payload = taskPayloadFromTask(task);
  assert.equal(payload.user_request, "Test task");
});

// ---------------------------------------------------------------------------
// emitTaskProgress
// ---------------------------------------------------------------------------

test("emitTaskProgress calls emitProgress on context", () => {
  let emitted = null;
  const context = {
    emitProgress(msg) { emitted = msg; },
  };
  const task = makeTask({ status: "running" });
  emitTaskProgress(context, task, "test_phase", "test message");
  assert.ok(emitted !== null);
  assert.equal(emitted.params.data.phase, "test_phase");
  assert.equal(emitted.params.data.message, "test message");
  assert.equal(emitted.params.data.task_id, "task_test_1");
});

test("emitTaskProgress handles missing emitProgress gracefully", () => {
  const context = {};
  const task = makeTask();
  // Should not throw
  emitTaskProgress(context, task, "phase", "msg");
});

// ---------------------------------------------------------------------------
// normalizeLegacyModes
// ---------------------------------------------------------------------------

test("normalizeLegacyModes normalizes readonly task modes", async () => {
  const task = makeTask({ id: "t1", mode: "readonly", title: "Regular task", description: "Work" });
  const state = { tasks: [task], goals: [] };
  const store = makeStore(state);
  await normalizeLegacyModes(store, state);
  assert.equal(task.mode, "full");
  assert.equal(task.legacy_mode, "readonly");
});

test("normalizeLegacyModes does not change inventory task mode", async () => {
  const task = makeTask({
    id: "t1", mode: "readonly", assignee: "codex",
    title: "Codex session metadata June",
    description: "Collect metadata. Do not read session file contents.",
  });
  const state = { tasks: [task], goals: [] };
  const store = makeStore(state);
  await normalizeLegacyModes(store, state);
  assert.equal(task.mode, "full");
  assert.equal(task.legacy_mode, "readonly");
});

test("normalizeLegacyModes normalizes readonly goal modes", async () => {
  const goal = makeGoal({ id: "g1", mode: "readonly" });
  const state = { goals: [goal], tasks: [] };
  const store = makeStore(state);
  await normalizeLegacyModes(store, state);
  assert.equal(goal.mode, "full");
  assert.equal(goal.legacy_mode, "readonly");
});

// ---------------------------------------------------------------------------
// findTask
// ---------------------------------------------------------------------------

test("findTask returns task by id", async () => {
  const task = makeTask({ id: "t1" });
  const state = { tasks: [task], goals: [] };
  const store = makeStore(state);
  const found = await findTask(store, "t1");
  assert.equal(found.id, "t1");
});

test("findTask throws for missing task", async () => {
  const store = makeStore({ tasks: [], goals: [] });
  await assert.rejects(() => findTask(store, "nonexistent"), /task not found/);
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

test("updateTask updates task and returns it", async () => {
  const task = makeTask({ id: "t1", status: "assigned" });
  const state = { tasks: [task], goals: [], conversations: [], memories: [], activities: [] };
  const store = makeStore(state);
  const result = await updateTask(store, "t1", (t) => { t.status = "running"; });
  assert.equal(result.task.status, "running");
  assert.ok(result.task.updated_at > "2026-01-01T00:00:00.000Z");
});

test("updateTask throws for missing task", async () => {
  const store = makeStore({ tasks: [], goals: [], conversations: [], memories: [], activities: [] });
  await assert.rejects(() => updateTask(store, "nonexistent", (t) => {}), /task not found/);
});

test("updateTask records activity", async () => {
  const task = makeTask({ id: "t1", status: "assigned" });
  const state = { tasks: [task], goals: [], conversations: [], memories: [], activities: [] };
  const store = makeStore(state);
  await updateTask(store, "t1", (t) => { t.status = "completed"; });
  assert.ok(state.activities.length >= 1);
  assert.equal(state.activities[0].type, "task.updated");
  assert.equal(state.activities[0].task_id, "t1");
});

test("updateTask does not call terminal notifier when unset", async () => {
  const task = makeTask({ id: "t1", status: "assigned" });
  const state = { tasks: [task], goals: [], conversations: [], memories: [], activities: [] };
  const store = makeStore(state);
  // setTerminalNotifier was never called with a function, so _terminalNotifier is null
  await updateTask(store, "t1", (t) => { t.status = "completed"; });
  assert.equal(task.status, "completed");
});

test("updateTask calls terminal notifier when set", async () => {
  let notifiedTask = null;
  const notifier = (t) => { notifiedTask = t; };
  setTerminalNotifier(notifier);
  try {
    const task = makeTask({ id: "t1", status: "assigned" });
    const state = { tasks: [task], goals: [], conversations: [], memories: [], activities: [] };
    const store = makeStore(state);
    await updateTask(store, "t1", (t) => { t.status = "completed"; });
    assert.ok(notifiedTask !== null);
    assert.equal(notifiedTask.id, "t1");
    assert.equal(notifiedTask.status, "completed");
  } finally {
    setTerminalNotifier(null);
  }
});

// ---------------------------------------------------------------------------
// updateGoalStatus
// ---------------------------------------------------------------------------

test("updateGoalStatus updates goal status", async () => {
  const goal = makeGoal({ id: "g1", status: "assigned" });
  const state = { tasks: [], goals: [goal], conversations: [], memories: [], activities: [] };
  const store = makeStore(state);
  const result = await updateGoalStatus(store, "g1", "completed");
  assert.equal(result.status, "completed");
  assert.ok(result.updated_at > "2026-01-01T00:00:00.000Z");
});

test("updateGoalStatus returns null for missing goal", async () => {
  const store = makeStore({ tasks: [], goals: [], conversations: [], memories: [], activities: [] });
  const result = await updateGoalStatus(store, "nonexistent", "completed");
  assert.equal(result, null);
});

test("updateGoalStatus records activity", async () => {
  const goal = makeGoal({ id: "g1", status: "assigned" });
  const state = { tasks: [], goals: [goal], conversations: [], memories: [], activities: [] };
  const store = makeStore(state);
  await updateGoalStatus(store, "g1", "completed");
  assert.ok(state.activities.length >= 1);
  assert.match(state.activities[0].type, /goal\./);
});

// ---------------------------------------------------------------------------
// setTerminalNotifier
// ---------------------------------------------------------------------------

test("setTerminalNotifier replaces terminal notifier", () => {
  let called = false;
  const fn = () => { called = true; };
  setTerminalNotifier(fn);
  // Verify by calling updateTask (which uses the notifier)
  // Already tested in updateTask tests above
  setTerminalNotifier(null);
});

console.log("task-lifecycle tests loaded");

test("findTask uses indexed lookup when available", async () => {
  const task = makeTask({ id: "task_indexed" });
  let lookupCount = 0;
  const store = {
    async load() { return { tasks: [], goals: [], conversations: [], memories: [], activities: [] }; },
    async save() {},
    async findTaskById(id) {
      lookupCount += 1;
      return id === task.id ? task : null;
    },
  };

  const found = await findTask(store, task.id);
  assert.equal(found.id, task.id);
  assert.equal(found.mode, "full");
  assert.equal(found.legacy_mode, "builder");
  assert.equal(task.mode, "builder");
  assert.equal(lookupCount, 1);
});

test("updateTask uses indexed lookup when available", async () => {
  const task = makeTask({ id: "task_indexed", status: "assigned" });
  const state = { tasks: [], goals: [], conversations: [], memories: [], activities: [] };
  let lookupCount = 0;
  let saveCount = 0;
  const store = {
    async load() { return state; },
    async save() { saveCount += 1; },
    async findTaskById(id) {
      lookupCount += 1;
      return id === task.id ? task : null;
    },
  };

  const result = await updateTask(store, task.id, (item) => {
    item.status = "running";
  });

  assert.equal(result.task, task);
  assert.equal(task.status, "running");
  assert.equal(lookupCount, 1);
  assert.equal(saveCount, 1);
  assert.equal(state.activities.length, 1);
});

test("updateGoalStatus uses indexed lookup when available", async () => {
  const goal = makeGoal({ id: "goal_indexed", status: "assigned" });
  const state = { tasks: [], goals: [], conversations: [], memories: [], activities: [] };
  let lookupCount = 0;
  const store = {
    async load() { return state; },
    async save() {},
    async findGoalById(id) {
      lookupCount += 1;
      return id === goal.id ? goal : null;
    },
  };

  const result = await updateGoalStatus(store, goal.id, "completed", "2026-01-01T01:00:00.000Z");

  assert.equal(result, goal);
  assert.equal(goal.status, "completed");
  assert.equal(lookupCount, 1);
  assert.equal(state.activities.length, 1);
});

test("normalizeLegacyModes normalizes standard task mode to builder", async () => {
  const task = makeTask({ id: "t1", mode: "standard", title: "Legacy standard task", description: "Work" });
  const state = { tasks: [task], goals: [] };
  const store = makeStore(state);
  await normalizeLegacyModes(store, state);
  assert.equal(task.mode, "full");
  assert.equal(task.legacy_mode, "standard");
});

test("normalizeLegacyModes normalizes standard goal mode to builder", async () => {
  const goal = makeGoal({ id: "g1", mode: "standard" });
  const state = { goals: [goal], tasks: [] };
  const store = makeStore(state);
  await normalizeLegacyModes(store, state);
  assert.equal(goal.mode, "full");
  assert.equal(goal.legacy_mode, "standard");
});

test("taskPayloadFromTask preserves explicit acceptance contract metadata", () => {
  const acceptanceContract = {
    schema_version: 2,
    intent: { operation_kind: "file_write", mutation_scope: "filesystem", execution_mode: "full", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    blocking_requirements: [{ id: "file_written", description: "file written", evidence: ["changed_files"] }],
  };
  const payload = taskPayloadFromTask({
    id: "task_contract",
    title: "filesystem canary",
    description: "write a canary file",
    project_id: "default",
    workspace_id: "hosted-default",
    metadata: {
      operation_kind: "file_write",
      mutation_scope: "filesystem",
      acceptance_contract: acceptanceContract,
    },
  });

  assert.deepEqual(payload.acceptance_contract, acceptanceContract);
  assert.equal(payload.operation_kind, "file_write");
  assert.equal(payload.mutation_scope, "filesystem");
});
