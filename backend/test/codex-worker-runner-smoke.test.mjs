import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.mjs';
import { runAssignedCodexTasks } from '../src/codex-worker-runner.mjs';

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'initial\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

function makeStore(tmpDir) {
  return new StateStore({
    statePath: join(tmpDir, 'state.json'),
    defaultWorkspaceRoot: tmpDir,
  });
}

function addTask(state, patch = {}) {
  const now = new Date().toISOString();
  const task = {
    id: patch.id || `task-${state.tasks.length + 1}`,
    assignee: 'codex',
    status: 'assigned',
    project_id: 'default',
    workspace_id: 'hosted-default',
    mode: 'builder',
    title: patch.title || 'Task',
    description: '',
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
  state.tasks.push(task);
  return task;
}

function addGoal(state, patch = {}) {
  const now = new Date().toISOString();
  const goal = {
    id: patch.id || `goal-${state.goals.length + 1}`,
    project_id: 'default',
    workspace_id: 'hosted-default',
    conversation_id: patch.conversation_id || `conv-${state.goals.length + 1}`,
    status: 'open',
    mode: 'builder',
    title: patch.title || 'Goal',
    description: '',
    created_at: now,
    updated_at: now,
    ...patch,
  };
  state.goals.push(goal);
  state.conversations ||= [];
  state.conversations.push({ id: goal.conversation_id, goal_id: goal.id, project_id: goal.project_id, workspace_id: goal.workspace_id, messages: [], created_at: now, updated_at: now });
  return goal;
}

test('runAssignedCodexTasks isolates per-task processor failures', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-runner-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, { id: 'bad-task', title: 'Bad task' });
    addTask(store.state, { id: 'good-task', title: 'Good task' });
    await store.save();

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 2 }, undefined, {
      processGeneralTask: async (_store, _config, task) => {
        if (task.id === 'bad-task') throw new Error('boom');
        return { task_id: task.id, status: 'completed' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.inspected, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.progressed, 2);

    const failedTask = await store.findTaskById('bad-task');
    assert.equal(failedTask.status, 'failed');
    assert.match(failedTask.result.worker_error, /boom/);

    const goodResult = result.tasks.find((item) => item.task_id === 'good-task');
    assert.equal(goodResult.status, 'completed');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks parks unsupported modes for review instead of hot-loop skipping', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-runner-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, { id: 'odd-task', mode: 'mystery' });
    await store.save();

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.inspected, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.transitioned, 1);
    assert.equal(result.progressed, 1);

    const parked = await store.findTaskById('odd-task');
    assert.equal(parked.status, 'waiting_for_review');
    assert.match(parked.logs.at(-1).message, /unsupported worker mode/);

    const afterPark = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });
    assert.equal(afterPark.inspected, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks creates one repair child for parked waiting_for_repair task idempotently', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-repair-child-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addGoal(store.state, { id: 'goal_parent_repair', title: 'Parent repair goal' });
    addTask(store.state, {
      id: 'parent-repair-task',
      title: 'Parent repair task',
      status: 'waiting_for_repair',
      goal_id: 'goal_parent_repair',
      result: {
        summary: 'Verification failed',
        verification: {
          passed: false,
          findings: [{ severity: 'blocker', code: 'test_failed', message: 'smoke failure' }],
        },
      },
    });
    await store.save();

    const first = await runAssignedCodexTasks(store, { defaultWorkspaceRoot: tmpDir }, {}, { limit: 10, concurrency: 1 });

    assert.equal(first.inspected, 1);
    assert.equal(first.transitioned, 1);
    await store.load();
    const parentAfterFirst = store.state.tasks.find((item) => item.id === 'parent-repair-task');
    const childrenAfterFirst = store.state.tasks.filter((item) => item.parent_task_id === 'parent-repair-task');
    assert.equal(parentAfterFirst.status, 'waiting_for_repair');
    assert.equal(childrenAfterFirst.length, 1);
    assert.equal(parentAfterFirst.result.repair_task_id, childrenAfterFirst[0].id);
    assert.equal(childrenAfterFirst[0].assignee, 'codex');

    const second = await runAssignedCodexTasks(store, { defaultWorkspaceRoot: tmpDir }, {}, { limit: 10, concurrency: 1 }, undefined, {
      processGeneralTask: async (_store, _config, task) => ({ task_id: task.id, status: task.status, progressed: false }),
    });

    assert.equal(second.inspected, 2);
    await store.load();
    const parentAfterSecond = store.state.tasks.find((item) => item.id === 'parent-repair-task');
    const childrenAfterSecond = store.state.tasks.filter((item) => item.parent_task_id === 'parent-repair-task');
    assert.equal(childrenAfterSecond.length, 1);
    assert.equal(parentAfterSecond.result.repair_task_id, childrenAfterFirst[0].id);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks auto-starts dependency-satisfied waiting queue item when worker tick is otherwise idle', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-queue-autostart-'));
  try {
    const repo = join(tmpDir, 'repo');
    initGitRepo(repo);
    const store = makeStore(tmpDir);
    await store.load();
    store.state.goal_queue = [];
    store.state.conversations = [];
    addTask(store.state, {
      id: 'task_2f357f8e-44c7-43ed-bdfa-e1db06572746',
      status: 'completed',
      goal_id: 'goal_prereq',
    });
    addGoal(store.state, { id: 'goal_after_dep', title: 'After dependency' });
    store.state.goal_queue.push({
      queue_id: 'queue_70298c5b530',
      goal_id: 'goal_after_dep',
      task_id: null,
      workspace_id: 'hosted-default',
      repo_id: '',
      position: 1,
      status: 'waiting',
      depends_on_goal_id: null,
      depends_on_task_id: 'task_2f357f8e-44c7-43ed-bdfa-e1db06572746',
      dependency_policy: 'completed_only',
      blocked_reason: null,
      auto_start: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await store.save();

    const result = await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: repo,
      enableTaskWorktrees: false,
    }, {}, { limit: 10, concurrency: 1 }, undefined, {
      processGeneralTask: async (_store, _config, task) => ({ task_id: task.id, status: 'completed', progressed: true }),
    });

    assert.equal(result.queue_autostart?.started, true);
    assert.equal(result.progressed, 1);
    await store.load();
    const queueItem = store.state.goal_queue.find((item) => item.queue_id === 'queue_70298c5b530');
    assert.equal(queueItem.status, 'running');
    assert.ok(queueItem.task_id, 'queue item should be linked to a started task');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks batch-starts queued goals to fill available concurrency slots', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-queue-batch-'));
  try {
    const repo = join(tmpDir, 'repo');
    initGitRepo(repo);
    const store = makeStore(tmpDir);
    await store.load();
    store.state.goal_queue = [];
    store.state.conversations = [];
    for (const suffix of ['a', 'b', 'c']) {
      const goal = addGoal(store.state, { id: `goal_batch_${suffix}`, title: `Batch ${suffix}` });
      store.state.goal_queue.push({
        queue_id: `queue_batch_${suffix}`,
        goal_id: goal.id,
        task_id: null,
        workspace_id: 'hosted-default',
        repo_id: '',
        position: suffix.charCodeAt(0),
        status: 'waiting',
        depends_on_goal_id: null,
        depends_on_task_id: null,
        dependency_policy: 'completed_only',
        blocked_reason: null,
        auto_start: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    await store.save();

    const seen = [];
    const result = await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: repo,
      enableTaskWorktrees: false,
    }, {}, { limit: 10, concurrency: 3 }, undefined, {
      processGeneralTask: async (_store, _config, task) => {
        seen.push(task.id);
        return { task_id: task.id, status: 'completed', progressed: true };
      },
    });

    assert.equal(result.queue_autostart?.started_count, 3);
    assert.equal(result.inspected, 3);
    assert.equal(result.progressed, 3);
    assert.equal(seen.length, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks does not auto-start manual-only queued goals', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-manual-only-'));
  try {
    const repo = join(tmpDir, 'repo');
    initGitRepo(repo);
    const store = makeStore(tmpDir);
    await store.load();
    store.state.goal_queue = [];
    store.state.conversations = [];
    const manualGoal = addGoal(store.state, { id: 'goal_manual_only_worker', title: 'Manual only worker' });
    const autoGoal = addGoal(store.state, { id: 'goal_auto_worker', title: 'Auto worker' });
    store.state.goal_queue.push({
      queue_id: 'queue_manual_only_worker',
      goal_id: manualGoal.id,
      task_id: null,
      workspace_id: 'hosted-default',
      repo_id: '',
      position: 1,
      status: 'waiting',
      depends_on_goal_id: null,
      depends_on_task_id: null,
      dependency_policy: 'completed_only',
      blocked_reason: null,
      auto_start: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.state.goal_queue.push({
      queue_id: 'queue_auto_worker',
      goal_id: autoGoal.id,
      task_id: null,
      workspace_id: 'hosted-default',
      repo_id: '',
      position: 2,
      status: 'waiting',
      depends_on_goal_id: null,
      depends_on_task_id: null,
      dependency_policy: 'completed_only',
      blocked_reason: null,
      auto_start: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await store.save();

    const result = await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: repo,
      enableTaskWorktrees: false,
    }, {}, { limit: 10, concurrency: 2 }, undefined, {
      processGeneralTask: async (_store, _config, task) => ({ task_id: task.id, status: 'completed', progressed: true }),
    });

    assert.equal(result.queue_autostart?.started_count, 1);
    await store.load();
    assert.equal(store.state.goal_queue.find((item) => item.queue_id === 'queue_manual_only_worker').status, 'waiting');
    assert.equal(store.state.goal_queue.find((item) => item.queue_id === 'queue_auto_worker').status, 'running');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks recovers accepted verified review tasks without rerunning Codex', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-review-recovery-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, {
      id: 'review-recover-task',
      status: 'waiting_for_review',
      result: {
        kind: 'codex_executed',
        summary: 'Verified admin/noop result',
        changed_files: [],
        reviewer_decision: { status: 'accepted', passed: true },
        verification: { passed: true, commands: [{ cmd: 'echo ok', exit_code: 0 }], findings: [] },
        acceptance_findings: [],
      },
    });
    await store.save();

    let processorCalled = false;
    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 }, undefined, {
      processGeneralTask: async () => {
        processorCalled = true;
        return { status: 'completed' };
      },
    });

    assert.equal(processorCalled, false, 'review recovery must not rerun Codex/general processor');
    assert.equal(result.review_recovery.recovered, 1);
    await store.load();
    const task = store.state.tasks.find((item) => item.id === 'review-recover-task');
    assert.equal(task.status, 'completed');
    assert.equal(task.result.requires_review, false);
    assert.equal(task.result.contract_verification.blocking_passed, true);
    assert.equal(task.result.closure_decision.status, 'auto_completed_clean');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
