import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../src/state-store.mjs';
import { createTask } from '../src/goal-task-creation.mjs';
import { defaultTokenContext } from '../src/auth-context.mjs';
import { buildGoalTask } from '../src/goal-task-task-factory.mjs';
import { finalizeCodexTaskRun } from '../src/task-final-writeback.mjs';
import { retrieveContext } from '../src/context-index/retriever.mjs';
import { createLocalStore } from '../src/context-index/zvec-store.mjs';
import { buildContextBundle } from '../src/context-index/context-bundle-builder.mjs';
import { runAgentPipeline } from '../src/agent-run-service.mjs';
import { processGeneralTaskWithDeps } from '../src/task-general-processor.mjs';
import { createEmbeddingProvider } from '../src/context-index/embeddings.mjs';

async function makeStore(root) {
  const store = new StateStore({ statePath: join(root, 'state.json'), defaultWorkspaceRoot: root });
  await store.load();
  store.state.goal_queue = [];
  store.state.goals = [];
  store.state.tasks = [];
  store.state.conversations = [];
  store.state.agent_runs = [];
  store.state.activities = [];
  await store.save();
  return store;
}

test('refactor goals: deploy/admin tasks default to canonical execution, builder uses worktree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-refactor-schema-'));
  t.after(async () => { try { await rm(root, { recursive: true, force: true }); } catch (e) { if (e.code === 'ENOTEMPTY') execSync(`rm -rf "${root}"`, { stdio: 'ignore' }); } });
  const store = await makeStore(root);
  const context = defaultTokenContext('test');

  const builder = await createTask(store, { defaultWorkspaceRoot: root }, { title: 'Build', assignee: 'codex', mode: 'builder' }, context);
  const deploy = await createTask(store, { defaultWorkspaceRoot: root }, { title: 'Deploy', assignee: 'codex', mode: 'deploy' }, context);
  const admin = await createTask(store, { defaultWorkspaceRoot: root }, { title: 'Admin', assignee: 'codex', mode: 'admin' }, context);

  assert.equal(builder.task.execution_mode, 'worktree');
  assert.equal(builder.task.worktree.enabled, true);
  assert.equal(deploy.task.execution_mode, 'canonical');
  assert.equal(deploy.task.worktree.enabled, false);
  assert.equal(admin.task.execution_mode, 'canonical');
  assert.equal(admin.task.worktree.enabled, false);
});

test('refactor goals: queue-created deploy task defaults to canonical execution', () => {
  const task = buildGoalTask({
    id: 'goal_deploy_contract',
    project_id: 'default',
    workspace_id: 'hosted-default',
    title: 'Deploy queued',
    mode: 'deploy',
    user_request: 'Deploy',
    goal_prompt: 'Deploy',
    created_at: new Date().toISOString(),
  }, { id: 'conv_deploy_contract' }, 'system');

  assert.equal(task.execution_mode, 'canonical');
  assert.equal(task.worktree.enabled, false);
});

test('refactor goals: deploy worker does not materialize worktree and locks canonical repo', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-refactor-deploy-worker-'));
  t.after(async () => { try { await rm(root, { recursive: true, force: true }); } catch (e) { if (e.code === 'ENOTEMPTY') execSync(`rm -rf "${root}"`, { stdio: 'ignore' }); } });
  const store = await makeStore(root);
  const now = new Date().toISOString();
  const goal = { id: 'goal_deploy_worker', project_id: 'default', workspace_id: 'hosted-default', conversation_id: 'conv_deploy_worker', title: 'Deploy', user_request: 'Deploy', goal_prompt: 'Deploy', context_summary: '', mode: 'deploy', status: 'assigned', created_at: now, updated_at: now };
  const task = { id: 'task_deploy_worker', project_id: 'default', workspace_id: 'hosted-default', goal_id: goal.id, conversation_id: goal.conversation_id, title: 'Deploy', description: 'Deploy', created_by: 'user', assignee: 'codex', status: 'assigned', mode: 'deploy', logs: [], artifacts: [], result: null, created_at: now, updated_at: now };
  store.state.workspaces = [{ id: 'hosted-default', project_id: 'default', type: 'hosted', root, default: true }];
  store.state.projects = [{ id: 'default', default_workspace_id: 'hosted-default' }];
  store.state.goals.push(goal);
  store.state.conversations.push({ id: goal.conversation_id, goal_id: goal.id, project_id: 'default', workspace_id: 'hosted-default', messages: [], created_at: now, updated_at: now });
  store.state.tasks.push(task);
  await store.save();

  let materialized = false;
  let lockedPath = null;
  let executionCwd = null;
  await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: join(root, 'canonical'), enableTaskWorktrees: true }, task, defaultTokenContext('test'), { syncTask: async () => {} }, {
    resolveTaskRepositoryPlanFn: async () => ({ repo_id: 'repo', canonical_repo_path: join(root, 'canonical'), task_worktree_path: join(root, '.gptwork/worktrees/repo/task_deploy_worker'), task_branch: 'gptwork/task/task_deploy_worker', base_ref: 'HEAD', uses_default_fallback: false, worktree_lifecycle: null }),
    materializeTaskWorktreeFn: async () => { materialized = true; return {}; },
    acquireRepoLockFn: async (_workspaceRoot, path) => { lockedPath = path; return { acquired: true }; },
    releaseLockForTaskFn: async () => {},
    prepareCodexTaskRunFn: async () => ({ promptFile: join(root, 'prompt.txt'), runFilePath: null, runId: null }),
    executeCodexTaskRunFn: async ({ executionCwd: cwd }) => {
      executionCwd = cwd;
      return { cr: { returncode: 0 }, parsedResult: { structured: true, status: 'completed', summary: 'deploy ok', changed_files: [], tests: 'none', verification: { passed: true, commands: [] } }, summary: 'deploy ok' };
    },
    finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => ({ task_id: task.id, status: taskStatus, kind: taskResult.kind }),
    runAcceptanceAgentFn: async () => ({ passed: true, findings: [], repair_proposals: [], next_tasks: [], reviewer_decision: null }),
    runIntegrationQueueFn: async () => ({ ok: true, status: 'completed' }),
  });

  assert.equal(materialized, false);
  assert.equal(lockedPath, join(root, 'canonical'));
  assert.equal(executionCwd, join(root, 'canonical'));
});

test('refactor goals: finalizer synchronizes current queue item and creates repair on verifier failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-refactor-finalizer-'));
  t.after(async () => { try { await rm(root, { recursive: true, force: true }); } catch (e) { if (e.code === 'ENOTEMPTY') execSync(`rm -rf "${root}"`, { stdio: 'ignore' }); } });
  const goal = { id: 'goal_finalizer_sync', workspace_id: 'hosted-default', project_id: 'default', title: 'Goal' };
  const task = { id: 'task_finalizer_sync', goal_id: goal.id, workspace_id: 'hosted-default', project_id: 'default', title: 'Task', repair_attempt: 0, logs: [] };
  const store = await makeStore(root);
  store.state.goals.push(goal);
  store.state.tasks.push({ ...task, status: 'running', logs: [] });
  store.state.goal_queue.push({ queue_id: 'queue_finalizer_sync', goal_id: goal.id, task_id: task.id, status: 'running', auto_start: true });
  await store.save();

  const result = await finalizeCodexTaskRun({
    store,
    config: { defaultWorkspaceRoot: root, maxRepairAttempts: 2 },
    task,
    taskStatus: 'completed',
    taskResult: { kind: 'codex_executed', summary: 'claimed', changed_files: [], verification: { passed: false, commands: [] } },
    doneAt: new Date().toISOString(),
    cr: { returncode: 0 },
    workspace: { root },
    goal,
    workspaceFiles: { result_md: '.gptwork/goals/goal_finalizer_sync/result.md', dir: '.gptwork/goals/goal_finalizer_sync' },
    summary: 'claimed',
    resultJsonPath: join(root, '.gptwork/goals/goal_finalizer_sync/result.json'),
    context: defaultTokenContext('test'),
    runFilePath: null,
    repoLockPath: null,
    github: { syncTask: async () => {} },
    appendGoalMessageFn: async () => {},
    writeWorkspaceTextInternalFn: async () => {},
    verifyTaskCompletionFn: async () => ({
      passed: false,
      status: 'waiting_for_review',
      commands: [],
      changed_files: [],
      reason_no_tests: null,
      failure_class: 'test_failed',
      requires_review: true,
      findings: [{ severity: 'blocker', code: 'verification_failed', message: 'tests failed', source: 'test' }],
    }),
    autoStartNextOnTaskCompletedFn: async () => ({ auto_started: false, details: [] }),
    removeTaskWorktreeFn: async () => ({ ok: true }),
  });

  await store.load();
  const savedTask = store.state.tasks.find((item) => item.id === task.id);
  const queueItem = store.state.goal_queue.find((item) => item.queue_id === 'queue_finalizer_sync');
  const repairGoal = store.state.goals.find((item) => item.id !== goal.id && /Repair:/.test(item.title || ''));

  assert.equal(result.status, 'waiting_for_repair');
  assert.equal(savedTask.status, 'waiting_for_repair');
  assert.equal(queueItem.status, 'waiting_for_repair');
  assert.equal(queueItem.failure_class, 'test_failed');
  assert.ok(repairGoal, 'repair goal should be created');
  assert.ok(savedTask.logs.some((log) => /failure_class=test_failed/.test(log.message)));
  assert.ok(existsSync(join(root, '.gptwork/goals/goal_finalizer_sync/verification.json')));
  assert.ok(existsSync(join(root, '.gptwork/goals/goal_finalizer_sync/acceptance.json')));
  const acceptance = JSON.parse(await readFile(join(root, '.gptwork/goals/goal_finalizer_sync/acceptance.json'), 'utf8'));
  assert.equal(acceptance.status, 'needs_action');
  assert.equal(acceptance.task_status, 'waiting_for_repair');
});

test('refactor goals: local context retrieval can search across workspace without current goal filter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-refactor-context-'));
  t.after(async () => { try { await rm(root, { recursive: true, force: true }); } catch (e) { if (e.code === 'ENOTEMPTY') execSync(`rm -rf "${root}"`, { stdio: 'ignore' }); } });
  const embedder = createEmbeddingProvider({ provider: 'fallback' });
  const store = createLocalStore({ workspaceRoot: root, dimension: embedder.dimension });
  const vectors = await embedder.embed(['billing retry result from prior goal', 'frontend styling note']);
  await store.addChunks([
    { id: 'chunk_goal_a', text: 'billing retry result from prior goal', tokens: 7, metadata: { goal_id: 'goal_a', workspace_id: 'ws_1', source_type: 'result', chunk_index: 0 } },
    { id: 'chunk_goal_b', text: 'frontend styling note', tokens: 4, metadata: { goal_id: 'goal_b', workspace_id: 'ws_1', source_type: 'goal', chunk_index: 0 } },
  ], vectors);

  const results = await retrieveContext({
    queryText: 'billing retry',
    topK: 5,
    options: { workspaceRoot: root, storePrefer: 'local', embeddingConfig: { provider: 'fallback' } },
    filters: { workspace_id: 'ws_1' },
  });

  assert.ok(results.some((item) => item.metadata.goal_id === 'goal_a'));
  assert.ok(results.every((item) => typeof item.text === 'string' && Number.isInteger(item.tokens)));
});

test('refactor goals: context bundle includes retrieval sources section', () => {
  const result = buildContextBundle({
    goal: { id: 'goal_sources', title: 'Sources', status: 'open' },
    chunks: [
      { id: 'chunk_1', text: 'Prior result summary', tokens: 5, metadata: { goal_id: 'goal_prior', source_type: 'result', source_path: '.gptwork/goals/goal_prior/result.md' }, score: 0.9 },
    ],
  });

  assert.ok(result.bundle.includes('## Retrieval Sources'));
  assert.ok(result.bundle.includes('goal_prior'));
  assert.ok(result.bundle.includes('.gptwork/goals/goal_prior/result.md'));
});

test('refactor goals: agent pipeline completed runs produce subagents and failures block completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-refactor-agents-'));
  t.after(async () => { try { await rm(root, { recursive: true, force: true }); } catch (e) { if (e.code === 'ENOTEMPTY') execSync(`rm -rf "${root}"`, { stdio: 'ignore' }); } });
  const store = await makeStore(root);

  const pipeline = await runAgentPipeline(store, { goal_id: 'goal_agents', task_id: 'task_agents' });
  assert.deepEqual(pipeline.agent_runs.map((run) => run.role), ['context_curator', 'planner', 'builder', 'verifier', 'reviewer', 'integrator', 'finalizer']);

  const { completeAgentRun, buildSubagentsFromAgentRuns, agentRunsBlockCompletion } = await import('../src/agent-run-service.mjs');
  for (const run of pipeline.agent_runs) {
    await completeAgentRun(store, { agent_run_id: run.id, status: run.role === 'verifier' ? 'failed' : 'completed', summary: `${run.role} summary` });
  }
  await store.load();
  const runs = store.state.agent_runs.filter((run) => run.task_id === 'task_agents');
  const subagents = buildSubagentsFromAgentRuns(runs);

  assert.equal(subagents.length, 7);
  assert.equal(subagents.find((item) => item.role === 'verifier').status, 'failed');
  assert.equal(agentRunsBlockCompletion(runs), true);
});

test('refactor goals: delivery CLI exposes verify-delivery and demo-multi-task commands', () => {
  const backendRoot = join(process.cwd());
  const verify = execFileSync(process.execPath, [join(backendRoot, 'bin/gptwork.mjs'), 'verify-delivery', '--help'], { encoding: 'utf8' });
  const demo = execFileSync(process.execPath, [join(backendRoot, 'bin/gptwork.mjs'), 'demo-multi-task', '--help'], { encoding: 'utf8' });

  assert.match(verify, /verify-delivery/);
  assert.match(verify, /worktree/);
  assert.match(demo, /demo-multi-task/);
  assert.match(demo, /worktree|branch|task|goal|result/);
});
