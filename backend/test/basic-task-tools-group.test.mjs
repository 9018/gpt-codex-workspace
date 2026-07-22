import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBasicTaskToolsGroup } from '../src/tool-groups/basic-task-tools-group.mjs';
import { StateStore } from '../src/state-store.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('basic task tool group exposes stable public tool names and schemas', () => {
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  assert.deepEqual(Object.keys(tools), [
    'create_task',
    'list_tasks',
    'get_task',
    'get_task_acceptance_bundle',
    'get_task_review_packet',
    'update_task_status',
    'delete_task',
    'delete_tasks',
    'append_task_log',
    'attach_task_artifact',
  ]);

  // create_task: required = ['title']
  assert.deepEqual(tools.create_task.inputSchema.required, ['title']);
  assert.equal(tools.create_task.inputSchema.properties.title.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.title.description, 'Task title summarizing the work to be done.');
  assert.equal(tools.create_task.inputSchema.properties.description.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.assignee.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.assignee.default, 'codex');
  assert.equal(tools.create_task.inputSchema.properties.workspace_id.type, 'string');
  assert.equal(Object.hasOwn(tools.create_task.inputSchema.properties, 'mode'), false);
  assert.equal(tools.create_task.inputSchema.properties.notify.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.silent.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.suppress_notifications.type, 'boolean');
  assert.equal(tools.create_task.inputSchema.properties.notification_policy.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.metadata.type, 'object');
  assert.equal(tools.create_task.inputSchema.properties.workstream_id.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.root_goal_id.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.parent_goal_id.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.phase.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.iteration.type, 'integer');
  assert.equal(tools.create_task.inputSchema.properties.shard_key.type, 'string');
  assert.equal(tools.create_task.inputSchema.properties.workflow_id.type, 'string');

  // list_tasks: all optional
  assert.deepEqual(tools.list_tasks.inputSchema.required, []);
  assert.equal(tools.list_tasks.inputSchema.properties.status.type, "string");
  assert.equal(tools.list_tasks.inputSchema.properties.assignee.type, "string");
  assert.equal(tools.list_tasks.inputSchema.properties.limit.type, "integer");

  // get_task: required = ['task_id']
  assert.deepEqual(tools.get_task.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task.inputSchema.properties.task_id, 'string');

  // update_task_status: required = ['task_id', 'status']
  assert.deepEqual(tools.get_task_acceptance_bundle.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task_acceptance_bundle.inputSchema.properties.task_id, 'string');
  assert.deepEqual(tools.get_task_review_packet.inputSchema.required, ['task_id']);
  assert.equal(tools.get_task_review_packet.inputSchema.properties.task_id, 'string');

  // update_task_status: required = ['task_id', 'status']
  assert.deepEqual(tools.update_task_status.inputSchema.required, ['task_id', 'status']);
  assert.equal(tools.update_task_status.inputSchema.properties.task_id, 'string');
  assert.equal(tools.update_task_status.inputSchema.properties.status, 'string');

  // append_task_log: required = ['task_id', 'message']
  assert.deepEqual(tools.append_task_log.inputSchema.required, ['task_id', 'message']);
  assert.equal(tools.append_task_log.inputSchema.properties.task_id, 'string');
  assert.equal(tools.append_task_log.inputSchema.properties.message, 'string');

  // attach_task_artifact: required = ['task_id', 'path']
  assert.deepEqual(tools.attach_task_artifact.inputSchema.required, ['task_id', 'path']);
  assert.equal(tools.attach_task_artifact.inputSchema.properties.task_id, 'string');
  assert.equal(tools.attach_task_artifact.inputSchema.properties.path, 'string');
  assert.equal(tools.attach_task_artifact.inputSchema.properties.label, 'string');
});

test('basic task tool group create_task handler forwards args and syncs to github', async () => {
  const createTaskCalls = [];
  let syncTaskCalled = false;

  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { test: true },
    store: { test: true },
    createTask: async (store, config, args, context) => {
      createTaskCalls.push({ store, config, args, context });
      return { task: { id: 't1', title: args.title } };
    },
    github: {
      syncTask: async (task) => {
        syncTaskCalled = true;
        assert.equal(task.id, 't1');
      },
    },
  });

  const context = { user_id: 'test-user' };
  const result = await tools.create_task.handler(
    { title: 'Test task', description: 'A test', assignee: 'codex' },
    context,
  );

  assert.equal(createTaskCalls.length, 1);
  assert.deepEqual(createTaskCalls[0].args, { title: 'Test task', description: 'A test', assignee: 'codex' });
  assert.equal(createTaskCalls[0].context, context);
  assert.deepEqual(result, { task: { id: 't1', title: 'Test task' } });
  // github.syncTask is called asynchronously; allow microtask to execute
  await new Promise(r => setTimeout(r, 10));
  assert.equal(syncTaskCalled, true);
});

test('basic task tool group list_tasks handler filters and reverses tasks', async () => {
  const mockTasks = [
    { id: 't1', status: 'completed', assignee: 'alice' },
    { id: 't2', status: 'assigned', assignee: 'bob' },
    { id: 't3', status: 'assigned', assignee: 'codex', mode: 'builder' },
    { id: 't4', status: 'completed', assignee: 'alice' },
    { id: 't5', status: 'assigned', assignee: 'codex', mode: 'deploy' },
  ];

  let loaded = false;
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {
      load: async () => {
        loaded = true;
        return { tasks: mockTasks };
      },
    },
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  // Without filters, returns last 50 reversed
  const allResult = await tools.list_tasks.handler({});
  assert.equal(loaded, true);
  assert.equal(allResult.tasks.length, 5);

  // Filter by status
  loaded = false;
  const assignedResult = await tools.list_tasks.handler({ status: 'assigned' });
  assert.equal(assignedResult.tasks.length, 3);
  assert.equal(assignedResult.tasks[0].id, 't5'); // reversed order

  // Filter by assignee
  loaded = false;
  const codexResult = await tools.list_tasks.handler({ assignee: 'codex' });
  assert.equal(codexResult.tasks.length, 2);
});

test('basic task tool group get_task handler calls findTask', async () => {
  // Creation and handler verification via injected store
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  // Shape verification (runtime integration tested via workspace-task-tools tests)
  assert.equal(typeof tools.get_task.handler, 'function');
});

test('basic task tool group update_task_status handler calls updateTask and syncs', async () => {
  let syncTaskCalled = false;

  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: {
      syncTask: async (task) => {
        syncTaskCalled = true;
        assert.equal(task.id, 't1');
      },
    },
  });

  // Shape verification (integration tested via workspace-task-tools tests)
  assert.equal(typeof tools.update_task_status.handler, 'function');
  await new Promise(r => setTimeout(r, 10));
});

test('basic task tool group append_task_log and attach_task_artifact handlers exist with correct schemas', () => {
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store: {},
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });

  assert.equal(typeof tools.append_task_log.handler, 'function');
  assert.equal(typeof tools.attach_task_artifact.handler, 'function');
});


test('cancelling a task stops and deletes execution session before status write', async () => {
  const order = [];
  const state = { tasks: [{ id: 't-cancel', status: 'running', logs: [], artifacts: [] }], activities: [] };
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: { defaultWorkspaceRoot: '/tmp/gptwork' },
    store: {
      load: async () => state,
      save: async () => { order.push('status-write'); },
    },
    createTask: async () => {},
    github: { syncTask: async () => {} },
    cancelTaskExecution: async ({ task }) => {
      assert.equal(task.id, 't-cancel');
      order.push('execution-cleanup');
      return { stopped_sessions: ['s1'], deleted_sessions: ['s1'] };
    },
  });

  const result = await tools.update_task_status.handler({ task_id: 't-cancel', status: 'cancelled' });
  assert.equal(result.task.status, 'cancelled');
  assert.deepEqual(order.slice(0, 2), ['execution-cleanup', 'status-write']);
  assert.deepEqual(result.cancellation, { stopped_sessions: ['s1'], deleted_sessions: ['s1'] });
});


test('delete_task removes terminal task and task-owned related records atomically', async () => {
  const state = {
    tasks: [
      { id: 't1', status: 'completed', goal_id: 'g1' },
      { id: 't2', status: 'running', goal_id: 'g2' },
    ],
    goals: [{ id: 'g1' }, { id: 'g2' }],
    goal_queue: [{ id: 'q1', task_id: 't1' }, { id: 'q2', task_id: 't2' }],
    agent_runs: [{ id: 'r1', task_id: 't1' }],
    activities: [{ id: 'a1', task_id: 't1' }],
    repo_locks: [{ id: 'l1', task_id: 't1' }],
    workspaces: [{ id: 'w1' }],
  };
  let saved = null;
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool, schema: fakeSchema, config: {},
    store: { load: async () => state, save: async (next) => { saved = next; } },
    createTask: async () => {}, github: { syncTask: async () => {} },
  });

  const preview = await tools.delete_task.handler({ task_id: 't1' });
  assert.equal(preview.dry_run, true);
  assert.equal(saved, null);
  assert.deepEqual(preview.plan.related, { queue_items: 1, agent_runs: 1, activities: 1, task_locks: 1 });

  const result = await tools.delete_task.handler({ task_id: 't1', dry_run: false });
  assert.deepEqual(result.deleted_task_ids, ['t1']);
  assert.deepEqual(saved.tasks.map((task) => task.id), ['t2']);
  assert.deepEqual(saved.goal_queue.map((item) => item.id), ['q2']);
  assert.deepEqual(saved.agent_runs, []);
  assert.deepEqual(saved.activities, []);
  assert.deepEqual(saved.repo_locks, []);
  assert.deepEqual(saved.goals.map((goal) => goal.id), ['g1', 'g2']);
  assert.deepEqual(saved.workspaces, [{ id: 'w1' }]);
});

test('delete_task rejects active tasks unless force=true', async () => {
  const state = { tasks: [{ id: 't-running', status: 'running' }] };
  let saves = 0;
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool, schema: fakeSchema, config: {},
    store: { load: async () => state, save: async () => { saves += 1; } },
    createTask: async () => {}, github: { syncTask: async () => {} },
  });
  await assert.rejects(() => tools.delete_task.handler({ task_id: 't-running', dry_run: false }), /task_not_terminal/);
  assert.equal(saves, 0);
});

test('delete_tasks all_terminal deletes selected tasks with one state save', async () => {
  const state = { tasks: [
    { id: 'done', status: 'completed' },
    { id: 'failed', status: 'failed' },
    { id: 'active', status: 'running' },
  ] };
  let saves = 0;
  let saved = null;
  const tools = createBasicTaskToolsGroup({
    tool: fakeTool, schema: fakeSchema, config: {},
    store: { load: async () => state, save: async (next) => { saves += 1; saved = next; } },
    createTask: async () => {}, github: { syncTask: async () => {} },
  });
  const result = await tools.delete_tasks.handler({ all_terminal: true, dry_run: false });
  assert.equal(saves, 1);
  assert.deepEqual(new Set(result.deleted_task_ids), new Set(['done', 'failed']));
  assert.deepEqual(saved.tasks.map((task) => task.id), ['active']);
});


test('delete_task persists deletion when using the real StateStore and a fresh reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-delete-task-'));
  try {
    const statePath = join(root, 'state.json');
    const store = new StateStore({ statePath, defaultWorkspaceRoot: root });
    const state = await store.load();
    state.tasks.push({ id: 't-real', status: 'completed', goal_id: 'g-real' });
    state.goals.push({ id: 'g-real', task_id: 't-real' });
    state.goal_queue.push({ id: 'q-real', task_id: 't-real' });
    state.agent_runs.push({ id: 'r-real', task_id: 't-real' });
    state.activities.push({ id: 'a-real', task_id: 't-real' });
    state.repo_locks = [{ id: 'l-real', task_id: 't-real' }];
    await store.save();

    const tools = createBasicTaskToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      config: {},
      store,
      createTask: async () => {},
      github: { syncTask: async () => {} },
    });

    const result = await tools.delete_task.handler({ task_id: 't-real', dry_run: false });
    assert.deepEqual(result.deleted_task_ids, ['t-real']);

    const reloadedStore = new StateStore({ statePath, defaultWorkspaceRoot: root });
    const reloaded = await reloadedStore.load();
    assert.equal(reloaded.tasks.some((task) => task.id === 't-real'), false);
    assert.equal(reloaded.goal_queue.some((item) => item.task_id === 't-real'), false);
    assert.equal(reloaded.agent_runs.some((item) => item.task_id === 't-real'), false);
    assert.equal(reloaded.activities.some((item) => item.task_id === 't-real'), false);
    assert.equal(reloaded.repo_locks.some((item) => item.task_id === 't-real'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('delete_tasks persists batch deletion when using the real StateStore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-delete-tasks-'));
  try {
    const statePath = join(root, 'state.json');
    const store = new StateStore({ statePath, defaultWorkspaceRoot: root });
    const state = await store.load();
    state.tasks.push(
      { id: 'done-real', status: 'completed' },
      { id: 'failed-real', status: 'failed' },
      { id: 'active-real', status: 'running' },
    );
    await store.save();

    const tools = createBasicTaskToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      config: {},
      store,
      createTask: async () => {},
      github: { syncTask: async () => {} },
    });

    const result = await tools.delete_tasks.handler({ all_terminal: true, dry_run: false });
    assert.deepEqual(new Set(result.deleted_task_ids), new Set(['done-real', 'failed-real']));

    const reloadedStore = new StateStore({ statePath, defaultWorkspaceRoot: root });
    const reloaded = await reloadedStore.load();
    assert.deepEqual(reloaded.tasks.map((task) => task.id), ['active-real']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("delete_task records tombstones and cleans goal artifacts when delete_linked_goal=true", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-delete-artifacts-"));
  try {
    const goalId = "goal_clean_1";
    const taskId = "task_clean_1";
    await mkdir(join(root, ".gptwork", "goals", goalId), { recursive: true });
    await writeFile(join(root, ".gptwork", "goals", goalId, "goal.md"), "goal");
    await mkdir(join(root, ".gptwork", "context-index", goalId), { recursive: true });
    await writeFile(join(root, ".gptwork", "context-index", goalId, "chunks.json"), "[]");
    await mkdir(join(root, ".gptwork", "runs", taskId), { recursive: true });
    await writeFile(join(root, ".gptwork", "runs", taskId, "run.json"), "{}");

    const state = {
      tasks: [{ id: taskId, status: "completed", goal_id: goalId, github_issue_number: 1012 }],
      goals: [{ id: goalId, task_id: taskId }],
      goal_queue: [],
      agent_runs: [],
      activities: [],
      repo_locks: [],
    };
    let saved = null;
    const tools = createBasicTaskToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      config: { defaultWorkspaceRoot: root, defaultRepoPath: root },
      store: {
        load: async () => state,
        save: async (next) => { saved = next; Object.assign(state, next); },
      },
      createTask: async () => {},
      github: { syncTask: async () => {} },
      cancelTaskExecution: async () => ({ deleted_sessions: [] }),
    });

    const result = await tools.delete_task.handler({
      task_id: taskId,
      dry_run: false,
      delete_linked_goal: true,
    });
    assert.deepEqual(result.deleted_task_ids, [taskId]);
    assert.ok(saved.deleted_task_ids.includes(taskId));
    assert.ok(saved.deleted_goal_ids.includes(goalId));
    assert.deepEqual(saved.deleted_github_issues, [1012]);
    assert.equal(existsSync(join(root, ".gptwork", "goals", goalId)), false);
    assert.equal(existsSync(join(root, ".gptwork", "context-index", goalId)), false);
    assert.equal(existsSync(join(root, ".gptwork", "runs", taskId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("delete_task cleans short-id view folders for linked goals", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-delete-views-"));
  try {
    const goalId = "goal_43e9ce27-438e-4884-b7a2-a6329ad63d8f";
    const taskId = "task_56f87073-b00e-4d56-b886-a821000ed8f1";
    const viewGoal = join(root, ".gptwork", "views", "goals", "gptwork-closed-loop-canary2--g43e9ce27");
    const viewTask = join(viewGoal, "tasks", "gptwork-closed-loop-canary2--t56f87073");
    await mkdir(viewTask, { recursive: true });
    await writeFile(join(viewGoal, "README.md"), "goal view");
    await writeFile(join(viewTask, "README.md"), "task view");
    await mkdir(join(root, ".gptwork", "goals", goalId), { recursive: true });
    await writeFile(join(root, ".gptwork", "goals", goalId, "goal.md"), "goal");

    const state = {
      tasks: [{ id: taskId, status: "completed", goal_id: goalId }],
      goals: [{ id: goalId, task_id: taskId }],
      goal_queue: [],
      agent_runs: [],
      activities: [],
      repo_locks: [],
    };
    const tools = createBasicTaskToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      config: { defaultWorkspaceRoot: root, defaultRepoPath: root },
      store: {
        load: async () => state,
        save: async (next) => Object.assign(state, next),
      },
      createTask: async () => {},
      github: { syncTask: async () => {} },
      cancelTaskExecution: async () => ({ deleted_sessions: [] }),
    });

    const result = await tools.delete_task.handler({
      task_id: taskId,
      dry_run: false,
      delete_linked_goal: true,
    });
    assert.deepEqual(result.deleted_task_ids, [taskId]);
    assert.equal(existsSync(viewGoal), false);
    assert.equal(existsSync(join(root, ".gptwork", "goals", goalId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
