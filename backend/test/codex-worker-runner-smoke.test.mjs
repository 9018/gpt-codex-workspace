import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.mjs';
import { runAssignedCodexTasks } from '../src/codex-worker-runner.mjs';
import { createProgressionCommandStore } from '../src/progression/progression-command-store.mjs';

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

test('runAssignedCodexTasks drains durable progression commands during an idle worker tick', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-progression-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, {
      id: 'task_progression_done',
      status: 'completed',
      decision_revision: 'revision-1',
      result: {
        unified_decision: {
          task_id: 'task_progression_done',
          revision: 'revision-1',
          status: 'completed',
        },
      },
    });
    await store.save();
    const commandStore = createProgressionCommandStore({
      store,
      idFactory: () => 'pcmd_worker_tick',
    });
    await commandStore.createCommand({
      task_id: 'task_progression_done',
      decision_revision: 'revision-1',
      action: 'complete_task',
      payload: {
        task_id: 'task_progression_done',
        unified_decision: {
          task_id: 'task_progression_done',
          revision: 'revision-1',
          status: 'completed',
        },
      },
    });

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });

    assert.deepEqual(result.progression_commands, {
      claimed: 1,
      applied: 1,
      failed: 0,
      superseded: 0,
    });
    assert.equal((await commandStore.getCommand('pcmd_worker_tick')).status, 'applied');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks supersedes progression commands from an older decision revision', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-progression-stale-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, {
      id: 'task_progression_newer',
      status: 'completed',
      decision_revision: 'revision-2',
      result: {
        unified_decision: {
          task_id: 'task_progression_newer',
          revision: 'revision-2',
          status: 'completed',
        },
      },
    });
    await store.save();
    const commandStore = createProgressionCommandStore({
      store,
      idFactory: () => 'pcmd_worker_stale',
    });
    await commandStore.createCommand({
      task_id: 'task_progression_newer',
      decision_revision: 'revision-1',
      action: 'complete_task',
      payload: {
        task_id: 'task_progression_newer',
        unified_decision: {
          task_id: 'task_progression_newer',
          revision: 'revision-1',
          status: 'completed',
        },
      },
    });

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });

    assert.equal(result.progression_commands.superseded, 1);
    assert.equal(result.progression_commands.applied, 0);
    assert.equal((await commandStore.getCommand('pcmd_worker_stale')).status, 'superseded');
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


test('runAssignedCodexTasks ignores historical imported repair tasks', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-historical-import-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, {
      id: 'historical-repair-task', status: 'waiting_for_repair', title: 'Historical repair',
      created_by: 'github-import',
    });
    await store.save();
    const result = await runAssignedCodexTasks(store, { maxRepairAttempts: 2 }, {}, { limit: 10, concurrency: 1 });
    assert.equal(result.inspected, 0);
    await store.load();
    assert.equal(store.state.tasks.filter((item) => item.parent_task_id === 'historical-repair-task').length, 0);
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

test('runAssignedCodexTasks creates one repair child for parked repair parent idempotently', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-repair-parked-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addGoal(store.state, {
      id: 'goal_repair_parent',
      title: 'Repair parent goal',
      goal_prompt: 'Original goal prompt',
    });
    addTask(store.state, {
      id: 'repair-parent-task',
      goal_id: 'goal_repair_parent',
      status: 'waiting_for_repair',
      title: 'Repair parent task',
      result: {
        summary: 'Previous attempt failed',
        acceptance_findings: [
          { severity: 'blocker', code: 'smoke_failure', message: 'Smoke failure', source: 'test' },
        ],
      },
    });
    await store.save();

    const first = await runAssignedCodexTasks(store, { maxRepairAttempts: 2 }, {}, { limit: 10, concurrency: 1 });

    assert.equal(first.ok, true);
    assert.equal(first.inspected, 1);
    assert.equal(first.progressed, 1);
    await store.load();
    const parentAfterFirst = store.state.tasks.find((item) => item.id === 'repair-parent-task');
    const repairChildrenAfterFirst = store.state.tasks.filter((item) => item.parent_task_id === 'repair-parent-task');
    assert.equal(parentAfterFirst.status, 'waiting_for_repair');
    assert.equal(repairChildrenAfterFirst.length, 1);
    assert.equal(parentAfterFirst.result.repair_task_id, repairChildrenAfterFirst[0].id);
    assert.equal(repairChildrenAfterFirst[0].status, 'assigned');

    const second = await runAssignedCodexTasks(store, { maxRepairAttempts: 2 }, {}, { limit: 10, concurrency: 1 });

    assert.equal(second.ok, true);
    await store.load();
    const parentAfterSecond = store.state.tasks.find((item) => item.id === 'repair-parent-task');
    const repairChildrenAfterSecond = store.state.tasks.filter((item) => item.parent_task_id === 'repair-parent-task');
    assert.equal(repairChildrenAfterSecond.length, 1);
    assert.equal(parentAfterSecond.result.repair_task_id, repairChildrenAfterFirst[0].id);
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

test('runAssignedCodexTasks terminalizes repeated branch_pushed integration retry as stable external wait', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-integration-stable-wait-'));
  try {
    const canonicalRepoPath = join(tmpDir, 'canonical');
    const taskWorktreePath = join(tmpDir, 'task-worktree');
    initGitRepo(canonicalRepoPath);
    execFileSync('git', ['worktree', 'add', '-b', 'gptwork/task/task_branch_retry', taskWorktreePath, 'HEAD'], {
      cwd: canonicalRepoPath,
      stdio: 'ignore',
    });
    const store = makeStore(tmpDir);
    await store.load();
    addGoal(store.state, { id: 'goal_branch_retry', title: 'Branch retry goal' });
    addTask(store.state, {
      id: 'task_branch_retry',
      goal_id: 'goal_branch_retry',
      status: 'waiting_for_integration',
      result: {
        kind: 'codex_executed',
        summary: 'Accepted code change',
        changed_files: ['src/app.mjs'],
        commit: 'abc123',
        repo_resolution: {
          repo_id: 'github.com/acme/repo',
          canonical_repo_path: canonicalRepoPath,
          task_worktree_path: taskWorktreePath,
          worktree_lifecycle: { mode: 'git_worktree', ok: true, branch_name: 'gptwork/task/task_branch_retry' },
        },
        reviewer_decision: { status: 'accepted', passed: true },
        verification: { passed: true, findings: [] },
        acceptance_findings: [],
        integration_retry_state: {
          last_status: 'branch_pushed',
          last_commit: 'abc123',
          repeat_count: 1,
        },
      },
    });
    await store.save();

    const result = await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      integrationMode: 'push_branch',
      runIntegrationQueueFn: async () => ({ ok: true, status: 'branch_pushed', merged: false, pushed: true, pr_opened: false }),
      runAutoIntegrationCompletionFn: async () => ({ attempted: true, eligible: false, completed: false, reason: 'canonical_dirty', blockers: [{ severity: 'blocker', code: 'canonical_dirty', message: 'dirty', source: 'test' }] }),
    }, {}, { limit: 10, concurrency: 1 });

    assert.equal(result.inspected, 1);
    assert.equal(result.tasks[0].status, 'waiting_for_integration');
    await store.load();
    const task = store.state.tasks.find((item) => item.id === 'task_branch_retry');
    assert.equal(task.status, 'waiting_for_integration');
    assert.equal(task.result.integration.status, 'branch_pushed');
    assert.equal(task.result.integration_terminalization.status, 'waiting_for_external_integration');
    assert.equal(task.result.integration_terminalization.stable_wait_reason, 'branch_pushed_requires_external_integration');
    assert.equal(task.result.integration_retry_state.last_status, 'branch_pushed');
    assert.equal(task.result.integration_retry_state.last_commit, 'abc123');
    assert.equal(task.result.integration_retry_state.repeat_count, 2);
    assert.match(task.logs.at(-1).message, /stable external integration wait/);

    const logsAfterFirst = task.logs.length;
    const second = await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      integrationMode: 'push_branch',
      runIntegrationQueueFn: async () => ({ ok: true, status: 'branch_pushed', merged: false, pushed: true, pr_opened: false }),
      runAutoIntegrationCompletionFn: async () => ({ attempted: true, eligible: false, completed: false, reason: 'canonical_dirty', blockers: [{ severity: 'blocker', code: 'canonical_dirty', message: 'dirty', source: 'test' }] }),
    }, {}, { limit: 10, concurrency: 1 });

    assert.equal(second.inspected, 1);
    await store.load();
    const taskAfterSecond = store.state.tasks.find((item) => item.id === 'task_branch_retry');
    assert.equal(taskAfterSecond.status, 'waiting_for_integration');
    assert.equal(taskAfterSecond.result.integration_retry_state.repeat_count, 2);
    assert.equal(taskAfterSecond.logs.length, logsAfterFirst, 'stable branch_pushed wait must not append retry logs every tick');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration retry fails closed when task worktree evidence is absent instead of using canonical repo', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-integration-no-worktree-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addGoal(store.state, { id: 'goal_no_worktree', title: 'No worktree' });
    addTask(store.state, {
      id: 'task_no_worktree',
      goal_id: 'goal_no_worktree',
      status: 'waiting_for_integration',
      result: {
        summary: 'Accepted change without worktree proof',
        changed_files: ['src/app.mjs'],
        commit: 'abc123',
        repo_resolution: {
          repo_id: 'github.com/acme/repo',
          canonical_repo_path: tmpDir,
          task_worktree_path: null,
          worktree_lifecycle: { mode: 'metadata_only', ok: false },
        },
      },
    });
    await store.save();
    let integrationCalled = false;

    await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      runIntegrationQueueFn: async () => { integrationCalled = true; return { ok: true, status: 'completed' }; },
    }, {}, { limit: 10, concurrency: 1 });

    await store.load();
    const task = store.state.tasks.find((item) => item.id === 'task_no_worktree');
    assert.equal(integrationCalled, false);
    assert.equal(task.status, 'waiting_for_review');
    assert.match(task.result.review_reason || '', /task worktree/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration retry rejects an unrelated git repository posing as a task worktree', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-integration-unrelated-repo-'));
  try {
    const canonicalRepoPath = join(tmpDir, 'canonical');
    const unrelatedRepoPath = join(tmpDir, 'unrelated');
    initGitRepo(canonicalRepoPath);
    initGitRepo(unrelatedRepoPath);
    const store = makeStore(tmpDir);
    await store.load();
    addGoal(store.state, { id: 'goal_unrelated_repo', title: 'Unrelated repo' });
    addTask(store.state, {
      id: 'task_unrelated_repo',
      goal_id: 'goal_unrelated_repo',
      status: 'waiting_for_integration',
      result: {
        summary: 'Accepted change with forged worktree proof',
        changed_files: ['src/app.mjs'],
        commit: 'abc123',
        repo_resolution: {
          repo_id: 'github.com/acme/repo',
          canonical_repo_path: canonicalRepoPath,
          task_worktree_path: unrelatedRepoPath,
          worktree_lifecycle: { mode: 'git_worktree', ok: true },
        },
      },
    });
    await store.save();
    let integrationCalled = false;

    await runAssignedCodexTasks(store, {
      defaultWorkspaceRoot: tmpDir,
      runIntegrationQueueFn: async () => { integrationCalled = true; return { ok: true, status: 'completed' }; },
    }, {}, { limit: 10, concurrency: 1 });

    await store.load();
    const task = store.state.tasks.find((item) => item.id === 'task_unrelated_repo');
    assert.equal(integrationCalled, false);
    assert.equal(task.status, 'waiting_for_review');
    assert.match(task.result.review_reason || '', /linked worktree|common git dir/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks review recovery does not overwrite stable external integration wait', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-review-recovery-stable-wait-'));
  try {
    const store = makeStore(tmpDir);
    await store.load();
    addTask(store.state, {
      id: 'task_review_stable_wait',
      status: 'waiting_for_review',
      result: {
        kind: 'codex_executed',
        summary: 'Accepted code change waiting externally',
        changed_files: ['src/app.mjs'],
        commit: 'def456',
        reviewer_decision: { status: 'accepted', passed: true },
        verification: { passed: true, findings: [] },
        acceptance_findings: [],
        integration: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
        integration_terminalization: {
          status: 'waiting_for_external_integration',
          stable_wait_reason: 'branch_pushed_requires_external_integration',
          next_action: 'Wait for external merge or PR completion before retrying integration.',
        },
      },
    });
    await store.save();

    const result = await runAssignedCodexTasks(store, {}, {}, { limit: 10, concurrency: 1 });

    assert.equal(result.review_recovery.recovered, 0);
    assert.equal(result.inspected, 0);
    await store.load();
    const task = store.state.tasks.find((item) => item.id === 'task_review_stable_wait');
    assert.equal(task.status, 'waiting_for_review');
    assert.equal(task.result.integration_terminalization.status, 'waiting_for_external_integration');
    assert.equal(task.logs.length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runAssignedCodexTasks reconciles running queue item linked to completed task before autostart', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'worker-stale-running-queue-'));
  try {
    const repo = join(tmpDir, 'repo');
    initGitRepo(repo);
    const store = makeStore(tmpDir);
    await store.load();
    store.state.goal_queue = [];
    store.state.conversations = [];
    addTask(store.state, { id: 'task_done_queue', status: 'completed', goal_id: 'goal_done_queue' });
    addGoal(store.state, { id: 'goal_after_queue', title: 'After stale queue' });
    store.state.goal_queue.push({
      queue_id: 'queue_stale_running',
      goal_id: 'goal_done_queue',
      task_id: 'task_done_queue',
      workspace_id: 'hosted-default',
      repo_id: 'github.com/acme/repo',
      position: 1,
      status: 'running',
      auto_start: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.state.goal_queue.push({
      queue_id: 'queue_after_stale',
      goal_id: 'goal_after_queue',
      task_id: null,
      workspace_id: 'hosted-default',
      repo_id: 'github.com/acme/repo',
      position: 2,
      status: 'waiting',
      depends_on_task_id: 'task_done_queue',
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

    assert.equal(result.queue_reconciliation.updated, 1);
    assert.equal(result.queue_autostart.started_count, 1);
    await store.load();
    assert.equal(store.state.goal_queue.find((item) => item.queue_id === 'queue_stale_running').status, 'completed');
    assert.equal(store.state.goal_queue.find((item) => item.queue_id === 'queue_after_stale').status, 'running');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
