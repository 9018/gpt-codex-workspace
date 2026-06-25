import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { StateStore } from '../src/state-store.mjs';
import { enqueueGoal, startNextQueuedGoal } from '../src/goal-queue.mjs';
import { processGeneralTaskWithDeps } from '../src/task-general-processor.mjs';

const ctx = {
  user_id: 'test_user',
  project_ids: ['*'],
  workspace_ids: ['*'],
  scopes: ['task:create', 'task:update', 'workspace:read', 'project:read', 'workspace:write'],
};

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'initial\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

function makeState(root, goals) {
  const now = new Date().toISOString();
  return {
    users: [{ id: 'user_default', name: 'Default User' }],
    teams: [{ id: 'team_default', name: 'Default Team' }],
    projects: [{ id: 'default', team_id: 'team_default', name: 'Default Project', default_workspace_id: 'hosted-default', created_at: now, updated_at: now }],
    workspaces: [{ id: 'hosted-default', project_id: 'default', name: 'Hosted Workspace', type: 'hosted', root, default: true, created_at: now, updated_at: now }],
    goals: goals.map((id, index) => ({
      id,
      project_id: 'default',
      workspace_id: 'hosted-default',
      conversation_id: `conv_${id}`,
      user_request: `Deliver ${id}`,
      goal_prompt: `Implement ${id}`,
      context_summary: '',
      title: `Delivery ${index + 1}`,
      created_by: 'user_default',
      assignee: 'codex',
      status: 'assigned',
      mode: 'builder',
      created_at: now,
      updated_at: now,
    })),
    conversations: goals.map((id) => ({
      id: `conv_${id}`,
      goal_id: id,
      project_id: 'default',
      workspace_id: 'hosted-default',
      messages: [{ role: 'user', content: `Deliver ${id}`, id: `msg_${id}`, author_id: 'user_default', created_at: now }],
      created_at: now,
      updated_at: now,
    })),
    memories: [],
    tasks: [],
    goal_queue: [],
    activities: [],
    audit: [],
  };
}

async function makeStore(root, goals) {
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(makeState(root, goals), null, 2), 'utf8');
  const store = new StateStore({ statePath, defaultWorkspaceRoot: root });
  await store.load();
  return store;
}

function makeConfig(root, canonicalRepoPath, autoStarted) {
  return {
    defaultWorkspaceRoot: root,
    defaultRepoPath: canonicalRepoPath,
    defaultBranch: 'HEAD',
    codexExecTimeout: 10,
    enableTaskWorktrees: true,
    maxRepairAttempts: 2,
    discoverVerificationCommands: false,
    repoResolver: async () => ({
      repo_id: 'github.com/acme/repo',
      canonical_repo_path: canonicalRepoPath,
      lock_repo_path: canonicalRepoPath,
      uses_default_fallback: false,
      worktree_lifecycle: null,
    }),
    autoStarted,
  };
}

async function runQueuedTask({ store, config, autoStarted, statusByTaskId = new Map(), repair = false }) {
  let state = await store.load();
  let runningItem = state.goal_queue.find((item) => item.status === 'running' && item.task_id && !statusByTaskId.has(item.task_id));
  let task = runningItem ? state.tasks.find((candidate) => candidate.id === runningItem.task_id) : null;
  let started = { started: false, item: runningItem, task };
  if (!task) {
    started = await startNextQueuedGoal(store, config);
    assert.equal(started.started, true);
    task = started.task;
  }

  const result = await processGeneralTaskWithDeps(store, config, task, ctx, { syncTask: async () => {} }, {
    acquireRepoLockFn: async () => ({ acquired: true }),
    releaseLockForTaskFn: async () => {},
    loadRestartMarkerFn: async () => null,
    releaseRepoLockFn: async () => {},
    prepareCodexTaskRunFn: async ({ goalStateDir }) => {
      await mkdir(goalStateDir, { recursive: true });
      const promptFile = join(goalStateDir, 'prompt.txt');
      await writeFile(promptFile, 'prompt', 'utf8');
      return { promptFile, runFilePath: null, runId: `run_${task.id}` };
    },
    executeCodexTaskRunFn: async ({ executionCwd, resultJsonPath }) => {
      const taskWorktreePath = join(config.defaultWorkspaceRoot, '.gptwork', 'worktrees', 'github.com-acme-repo', task.id);
      assert.equal(executionCwd, taskWorktreePath);
      writeFileSync(join(executionCwd, `${task.id}.txt`), `change for ${task.id}\n`, 'utf8');
      execFileSync('git', ['add', `${task.id}.txt`], { cwd: executionCwd, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', `change ${task.id}`], { cwd: executionCwd, stdio: 'pipe' });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: executionCwd, encoding: 'utf8' }).trim();
      const parsedResult = {
        structured: true,
        status: 'completed',
        summary: `completed ${task.id}`,
        changed_files: [`${task.id}.txt`],
        tests: 'fake executeCodexTaskRunFn: passed',
        commit,
        verification: { passed: true, commands: [{ cmd: 'fake verification', exit_code: 0 }] },
        acceptance_findings: [],
      };
      await writeFile(resultJsonPath, JSON.stringify(parsedResult, null, 2), 'utf8');
      return { cr: { returncode: 0, stdout: '', stderr: '', timed_out: false }, summary: parsedResult.summary, parsedResult };
    },
    appendGoalMessageFn: async () => {},
    selectWorkspaceFn: async () => ({ type: 'hosted', root: config.defaultWorkspaceRoot, id: 'hosted-default' }),
    runAcceptanceAgentFn: async () => repair
      ? {
          passed: false,
          status: 'needs_fix',
          profile: 'e2e_repair',
          findings: [{ severity: 'blocker', code: 'verification_failed', message: 'Acceptance failed', source: 'e2e' }],
          repair_proposals: [{ title: 'Fix acceptance', proposed_action: 'Address acceptance failure' }],
          next_tasks: [],
          reviewer_decision: { role: 'acceptance_agent', summary: 'failed', decision: { status: 'needs_fix', passed: false } },
        }
      : {
          passed: true,
          status: 'accepted',
          profile: 'e2e',
          findings: [],
          repair_proposals: [],
          next_tasks: [],
          reviewer_decision: { role: 'acceptance_agent', summary: 'accepted', decision: { status: 'accepted', passed: true } },
        },
    runIntegrationQueueFn: async () => ({ ok: true, status: 'completed' }),
    verifyTaskCompletionFn: async ({ resultJson, resultJsonPath, repoPath }) => {
      assert.equal(repoPath, join(config.defaultWorkspaceRoot, '.gptwork', 'worktrees', 'github.com-acme-repo', task.id));
      assert.equal(resultJson.status, 'completed');
      const verification = {
        passed: true,
        status: 'completed',
        commands: [{ cmd: 'fake verification', exit_code: 0, stdout_tail: '', stderr_tail: '' }],
        changed_files: resultJson.changed_files || [],
        reason_no_tests: null,
        failure_class: null,
        requires_review: false,
        findings: [],
      };
      await writeFile(join(resultJsonPath, '..', 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
      return verification;
    },
    shouldAttemptRepairFn: async () => ({ should_repair: true, reason: 'Repair attempt 1/2' }),
    createRepairGoalFromFindingsFn: async ({ task: failedTask, findings, repairProposals }) => ({
      id: `repair_${failedTask.id}_1`,
      parent_task_id: failedTask.id,
      root_task_id: failedTask.id,
      repair_attempt: 1,
      acceptance_findings: findings,
      repair_proposals: repairProposals,
      user_request: `Repair: ${failedTask.title} (attempt 1)`,
      goal_prompt: `Repair prompt for ${failedTask.id}`,
      mode: 'builder',
      workspace_id: 'hosted-default',
    }),
    autoStartNextOnTaskCompletedFn: async (storeArg, configArg, completedTask) => {
      autoStarted.push(completedTask.id);
      const { autoStartNextOnTaskCompleted } = await import('../src/goal-queue.mjs');
      return autoStartNextOnTaskCompleted(storeArg, configArg, completedTask);
    },
  });
  statusByTaskId.set(task.id, result.status);
  return { started, task, result };
}

test('delivery e2e: queue -> task -> processor -> finalizer creates isolated worktrees and autostarts next', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-real-'));
  try {
    const canonicalRepoPath = join(root, 'repo');
    initGitRepo(canonicalRepoPath);
    const store = await makeStore(root, ['goal_one', 'goal_two', 'goal_three']);
    const autoStarted = [];
    const config = makeConfig(root, canonicalRepoPath, autoStarted);

    for (const goalId of ['goal_one', 'goal_two', 'goal_three']) {
      const queued = await enqueueGoal(store, goalId, { repo_id: 'github.com/acme/repo', auto_start: true });
      assert.equal(queued.ok, true);
    }

    const runs = [];
    const statuses = new Map();
    runs.push(await runQueuedTask({ store, config, autoStarted, statusByTaskId: statuses }));
    runs.push(await runQueuedTask({ store, config, autoStarted, statusByTaskId: statuses }));
    runs.push(await runQueuedTask({ store, config, autoStarted, statusByTaskId: statuses }));

    assert.equal(runs.length, 3);
    assert.equal(new Set(runs.map((run) => run.task.result.repo_resolution.task_worktree_path)).size, 3);
    assert.deepEqual(runs.map((run) => run.result.status), ['completed', 'completed', 'completed']);

    for (const run of runs) {
      const taskWorktreePath = join(root, '.gptwork', 'worktrees', 'github.com-acme-repo', run.task.id);
      const task = await store.findTaskById(run.task.id);
      assert.equal(task.status, 'completed');
      assert.equal(task.result.repo_resolution.task_worktree_path, taskWorktreePath);
      assert.equal(task.result.execution_cwd, taskWorktreePath);
      assert.equal(task.result.execution_cwd_proof.used_task_worktree_path, true);
      assert.equal(task.result.repo_resolution.worktree_lifecycle.branch_name, `gptwork/task/${run.task.id}`);
      assert.ok(existsSync(join(root, '.gptwork', 'goals', task.goal_id, 'verification.json')), 'completed task should have verification.json');
      const verification = JSON.parse(readFileSync(join(root, '.gptwork', 'goals', task.goal_id, 'verification.json'), 'utf8'));
      assert.equal(verification.passed, true);
    }

    const state = await store.load();
    assert.equal(state.goal_queue.length, 3);
    assert.ok(state.goal_queue.every((item) => item.status === 'completed'));
    assert.equal(autoStarted.length, 3, 'autoStartNextOnTaskCompleted should be triggered for each completion');
  } finally {
    if (!process.env.KEEP_E2E_TMP) rmSync(root, { recursive: true, force: true });
  }
});

test('delivery e2e: acceptance failure creates repair goal/task and parks original task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-repair-real-'));
  try {
    const canonicalRepoPath = join(root, 'repo');
    initGitRepo(canonicalRepoPath);
    const store = await makeStore(root, ['goal_repair']);
    const autoStarted = [];
    const config = makeConfig(root, canonicalRepoPath, autoStarted);
    const queued = await enqueueGoal(store, 'goal_repair', { repo_id: 'github.com/acme/repo', auto_start: true });
    assert.equal(queued.ok, true);

    const { task, result } = await runQueuedTask({ store, config, autoStarted, repair: true });
    assert.equal(result.status, 'waiting_for_repair');

    const originalTask = await store.findTaskById(task.id);
    assert.equal(originalTask.status, 'waiting_for_repair');
    assert.equal(originalTask.result.repair_goal.parent_task_id, task.id);
    assert.ok(originalTask.result.repair_goal_id, 'repair_goal_id should be recorded');
    assert.ok(originalTask.result.repair_task_id, 'repair_task_id should be recorded');

    const repairGoal = await store.findGoalById(originalTask.result.repair_goal_id);
    const repairTask = await store.findTaskById(originalTask.result.repair_task_id);
    assert.ok(repairGoal, 'createGoal should persist a repair goal');
    assert.ok(repairTask, 'createGoal should persist a repair task');
    assert.equal(repairTask.status, 'assigned');
    assert.equal(repairTask.assignee, 'codex');

    const state = await store.load();
    const queueItem = state.goal_queue.find((item) => item.task_id === task.id);
    assert.equal(queueItem.status, 'waiting_for_repair');
    assert.equal(queueItem.failure_class, 'verification_failed');
  } finally {
    if (!process.env.KEEP_E2E_TMP) rmSync(root, { recursive: true, force: true });
  }
});
