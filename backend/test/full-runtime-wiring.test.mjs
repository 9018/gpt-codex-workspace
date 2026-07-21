import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeStore(initial) {
  return {
    state: structuredClone(initial),
    async load() { return this.state; },
    async mutate(fn) { return fn(this.state); },
    async save() {},
  };
}

describe('full runtime wiring', () => {
  it('full executor module imports and returns schema version', async () => {
    const mod = await import('../src/full-execution/full-executor.mjs');
    assert.equal(typeof mod.executeFullTask, 'function');
  });

  it('runtime aggregate can parse result.json under ESM', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'gptwork-aggregate-'));
    const goalId = 'goal_test';
    const dir = join(root, '.gptwork', 'goals', goalId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'result.json'), JSON.stringify({ commit: 'abc123', changed_files: ['a.mjs'] }));
    const { buildTaskRuntimeAggregate } = await import('../src/runtime/task-runtime-aggregate.mjs');
    const aggregate = await buildTaskRuntimeAggregate({
      task: { id: 'task_test', goal_id: goalId, status: 'running', acceptance_contract: { retry_policy: {} } },
      workspaceRoot: root,
      now: Date.now(),
    });
    assert.equal(aggregate.evidence.result_json, true);
    assert.equal(aggregate.evidence.commit, 'abc123');
  });

  it('reconciler runs machine acceptance and persists verdict', async () => {
    const task = {
      id: 'task_accept', goal_id: 'goal_accept', status: 'collecting',
      acceptance_contract: { mode: 'full', requires_commit: false, requires_integration: false, required_checks: [] },
      result: { checks: [], changed_files: [] },
    };
    const store = makeStore({ tasks: [task], goals: [], activities: [] });
    const { reconcileTaskRuntime } = await import('../src/runtime/task-runtime-reconciler.mjs');
    const result = await reconcileTaskRuntime({
      store, taskId: task.id,
      context: { evidence: { result_json: true, verification: true, commit: null, changed_files: [] } },
      acceptTask: async () => ({ verdict: 'pass', findings: [], eligible_for_integration: false }),
    });
    assert.equal(result.action, 'accept');
    assert.equal(store.state.tasks[0].status, 'completed');
    assert.equal(store.state.tasks[0].result.acceptance_verdict, 'pass');
    assert.equal(store.state.task_transition_events.length, 1);
    assert.equal(store.state.task_transition_events[0].event, 'reconciliation_correction');
    assert.equal(store.state.task_transition_events[0].next_status, 'completed');
  });


  it('preserves native Codex session at supervisor checkpoint instead of stop_retry', async () => {
    const task = {
      id: 'task_supervisor', goal_id: 'goal_supervisor', status: 'running',
      acceptance_contract: { mode: 'full', retry_policy: { no_progress_timeout_ms: 1, wake_grace_ms: 0 } },
    };
    const store = makeStore({ tasks: [task], goals: [], activities: [] });
    let stopped = false;
    let retried = false;
    const { reconcileTaskRuntime } = await import('../src/runtime/task-runtime-reconciler.mjs');
    const result = await reconcileTaskRuntime({
      store, taskId: task.id,
      context: {
        session: {
          id: 'native_control', status: 'waiting_for_supervisor', pty_pid: process.pid,
          started_at: '2020-01-01T00:00:00Z', last_meaningful_progress_at: '2020-01-01T00:00:00Z',
        },
        lock: { task_id: task.id, status: 'acquired' },
      },
      sessionProvider: { stop: async () => { stopped = true; } },
      retryTask: async () => { retried = true; },
    });
    assert.equal(result.action, 'ask');
    assert.equal(stopped, false);
    assert.equal(retried, false);
    assert.equal(store.state.tasks[0].status, 'waiting_for_review');
  });

  it('reconciler creates retry on stop_retry', async () => {
    const task = {
      id: 'task_retry', goal_id: 'goal_retry', status: 'running', attempt: 1,
      acceptance_contract: { mode: 'full', retry_policy: { max_attempts: 3, no_progress_timeout_ms: 1, wake_grace_ms: 0, backoff_ms: [0, 0, 0] } },
    };
    const store = makeStore({ tasks: [task], goals: [], activities: [] });
    let retried = false;
    const { reconcileTaskRuntime } = await import('../src/runtime/task-runtime-reconciler.mjs');
    await reconcileTaskRuntime({
      store, taskId: task.id,
      context: {
        session: { id: 's', status: 'running', pty_pid: 99999999, started_at: '2020-01-01T00:00:00Z', last_meaningful_progress_at: '2020-01-01T00:00:00Z' },
        lock: { task_id: task.id, status: 'acquired' },
      },
      retryTask: async () => { retried = true; return { retry_task_id: 'task_retry_2' }; },
    });
    assert.equal(retried, true);
    assert.equal(store.state.tasks[0].status, 'waiting_for_repair');
  });
});

it('bulk reconciler uses persisted session resolver for stalled tasks', async () => {
  const task = { id: 'bulk_retry', status: 'running', attempt: 1, acceptance_contract: { mode: 'full', retry_policy: { max_attempts: 3, no_progress_timeout_ms: 1, wake_grace_ms: 0, backoff_ms: [0] } } };
  const store = makeStore({ tasks: [task], goals: [], activities: [] });
  let retried = false;
  const { reconcileAllActiveTaskRuntimes } = await import('../src/runtime/task-runtime-reconciler.mjs');
  await reconcileAllActiveTaskRuntimes({
    store,
    sessionResolver: async () => ({ id: 'persisted', status: 'running', pty_pid: 99999999, started_at: '2020-01-01T00:00:00Z', last_meaningful_progress_at: '2020-01-01T00:00:00Z' }),
    retryTask: async () => { retried = true; return { retry_task_id: 'bulk_retry_2' }; },
  });
  assert.equal(retried, true);
});

it('accepted task requiring integration transitions to integrating instead of completing early', async () => {
  const task = { id: 'need_int', status: 'collecting', acceptance_contract: { mode: 'full', requires_commit: true, requires_integration: true }, result: {} };
  const store = makeStore({ tasks: [task], goals: [], activities: [] });
  const { reconcileTaskRuntime } = await import('../src/runtime/task-runtime-reconciler.mjs');
  await reconcileTaskRuntime({
    store, taskId: task.id,
    context: { evidence: { result_json: true, verification: true, commit: 'abc', changed_files: ['x'] } },
    acceptTask: async () => ({ verdict: 'pass', findings: [], eligible_for_integration: true }),
  });
  assert.equal(store.state.tasks[0].status, 'integrating');
});


it('real stop_retry clears stale TUI ownership and points goal at retry', async () => {
  const task = { id: 'real_parent', goal_id: 'real_goal', status: 'running', attempt: 0, execution_mode: 'worktree', worktree: { enabled: true }, title: 'canary', mode: 'full', metadata: { codex_execution_provider: 'codex_tui_goal', tui_session_owner: 'manual', tui_session_id: 's' }, acceptance_contract: { mode: 'full', retry_policy: { max_attempts: 2, no_progress_timeout_ms: 1, wake_grace_ms: 0, backoff_ms: [0] } } };
  const store = makeStore({ tasks: [task], goals: [{ id: 'real_goal', task_id: 'real_parent' }], goal_queue: [{ task_id: 'real_parent', status: 'running' }], activities: [] });
  const { reconcileTaskRuntime } = await import('../src/runtime/task-runtime-reconciler.mjs');
  const out = await reconcileTaskRuntime({ store, taskId: task.id, context: { session: { id: 's', status: 'running', pty_pid: 99999999, started_at: '2020-01-01T00:00:00Z', last_meaningful_progress_at: '2020-01-01T00:00:00Z' } } });
  const retry = store.state.tasks.find((t) => t.id === out.retry_task_id);
  assert.equal(store.state.tasks[0].status, 'cancelled');
  assert.equal(store.state.tasks[0].metadata.tui_session_owner, undefined);
  assert.equal(retry.metadata.codex_execution_provider, 'codex_tui_goal');
  assert.deepEqual(retry.acceptance_contract, task.acceptance_contract);
  assert.equal(store.state.goals[0].task_id, retry.id);
});
