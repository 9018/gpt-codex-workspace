/**
 * Runtime reconciler for the single full-mode task lifecycle.
 * Uses StateStore.mutate(), the transaction primitive provided by the current store.
 */
import { buildTaskRuntimeAggregate, HEALTH, RECOMMENDED_ACTION } from './task-runtime-aggregate.mjs';
import { acceptFullTask as defaultAcceptTask } from '../full-execution/full-machine-acceptance.mjs';
import { createRetryIterationAtomic as defaultCreateRetry } from '../task-retry.mjs';

import { createTaskTransitionService } from "../task-state/task-transition-service.mjs";
import { TASK_EVENTS } from "../task-state/task-transition-events.mjs";
function result(changed, aggregate, action, details = {}) {
  return { changed, aggregate, action, ...details };
}

function findTask(state, taskId) {
  return (state.tasks || []).find((task) => task.id === taskId) || null;
}

async function transition(state, task, status, message, resultPatch = null) {
  const localStore = { async mutate(fn) { return fn(state); } };
  const transitionService = createTaskTransitionService({ store: localStore });
  const transitionResult = await transitionService.transitionTask({
    task_id: task.id,
    event: TASK_EVENTS.RECONCILIATION_CORRECTION,
    expected_statuses: [task.status],
    payload: {
      canonical_status: status,
      task_result_patch: resultPatch || {},
      audit: { reconciler: 'runtime_task_reconciler', message },
    },
    reason: message,
    source: 'reconciler',
    actor: { type: 'system', id: 'runtime_task_reconciler' },
    idempotency_key: `runtime_reconciler:${task.id}:${task.status}:${status}:${message}`,
  });
  const updated = transitionResult.task || task;
  Object.assign(task, updated);
  task.logs ||= [];
  task.logs.push({ time: task.updated_at || new Date().toISOString(), message });
  return task;
}

function lightweightTx(state) {
  return {
    state,
    tasks: {
      async setState(id, status, patch = null) {
        const task = findTask(state, id);
        if (!task) throw new Error(`task not found: ${id}`);
        await transition(state, task, status, `[runtime] ${status}`, patch);
        return task;
      },
      async create(payload) {
        state.tasks ||= [];
        const now = new Date().toISOString();
        const task = { status: 'queued', assignee: 'codex', created_at: now, updated_at: now, ...payload };
        state.tasks.push(task);
        return task;
      },
    },
    locks: {
      async releaseForTask(id) {
        for (const lock of state.repo_locks || state.locks || []) {
          if (lock.task_id === id && !['released', 'cleared'].includes(lock.status)) {
            lock.status = 'released'; lock.released_at = new Date().toISOString();
          }
        }
      },
    },
    queue: {
      async replaceIteration(parentId, retryId) {
        const item = (state.goal_queue || []).find((entry) => entry.task_id === parentId);
        if (item) { item.task_id = retryId; item.status = 'waiting'; item.updated_at = new Date().toISOString(); }
      },
    },
    goals: {
      async replaceTask(goalId, retryId) {
        const goal = (state.goals || []).find((entry) => entry.id === goalId);
        if (goal) { goal.task_id = retryId; goal.status = 'assigned'; goal.updated_at = new Date().toISOString(); }
      },
    },
    scheduler: { async schedule() {} },
  };
}

export async function reconcileTaskRuntime(options = {}) {
  const {
    store, config = {}, taskId, trigger = 'reconciler', context = {}, sessionProvider = null,
    acceptTask = defaultAcceptTask,
    retryTask = null,
    integrateTask = null,
    releaseTaskLock = null,
  } = options;
  if (!store) throw new Error('store is required');
  if (!taskId) throw new Error('taskId is required');

  let output;
  await store.mutate(async (state) => {
    const task = findTask(state, taskId);
    if (!task) { output = result(false, null, 'noop', { reason: 'task not found' }); return; }
    const goal = (state.goals || []).find((g) => g.id === task.goal_id) || null;
    const session = context.session || (state.sessions || []).find((s) => s.task_id === taskId) || null;
    const lock = context.lock || (state.repo_locks || state.locks || []).find((l) => l.task_id === taskId) || null;
    const aggregate = await buildTaskRuntimeAggregate({
      task, goal, session, lock, worktree: context.worktree || null,
      evidence: context.evidence, workspaceRoot: config.defaultWorkspaceRoot, config,
    });
    const action = aggregate.recommended_action;
    const tx = lightweightTx(state);

    if (action === RECOMMENDED_ACTION.CONTINUE) {
      output = result(false, aggregate, action, { reason: 'no action needed' }); return;
    }
    if (action === RECOMMENDED_ACTION.WAKE) {
      if (sessionProvider && aggregate.session.session_id) {
        try { await sessionProvider.sendInput(aggregate.session.session_id, '\n'); } catch {}
      }
      task.result = { ...(task.result || {}), watchdog_wake_sent_at: new Date().toISOString() };
      output = result(true, aggregate, action, { reason: 'wake sent' }); return;
    }
    if (action === RECOMMENDED_ACTION.STOP_RETRY) {
      const provider = String(
        task?.metadata?.codex_execution_provider
        || task?.result?.codex_execution_provider
        || task?.result?.provider
        || ""
      );
      const sessionStatus = String(aggregate?.session?.status || "");
      if (provider.includes("codex_tui") && ["running", "created"].includes(sessionStatus)) {
        // Preserve live TUI control sessions for GPT mid-course corrections.
        output = result(false, aggregate, RECOMMENDED_ACTION.CONTINUE, {
          reason: "live_tui_session_preserved",
        });
        return;
      }
      if (sessionProvider && aggregate.session.session_id) {
        try { await sessionProvider.stop(aggregate.session.session_id, { reason: `reconciler_${trigger}` }); } catch {}
      }
      await tx.locks.releaseForTask(taskId);
      if (typeof releaseTaskLock === 'function') { try { await releaseTaskLock(taskId); } catch {} }
      if (aggregate.evidence.result_json) {
        await transition(state, task, 'collecting', `[runtime] evidence available after stop (${trigger})`);
        output = result(true, aggregate, action, { reason: 'stopped; evidence ready' }); return;
      }
      task.metadata = { ...(task.metadata || {}) };
      delete task.metadata.tui_session_owner;
      delete task.metadata.manual_tui_session_starting;
      delete task.metadata.worker_tui_session_starting;
      delete task.metadata.tui_session_id;
      await transition(state, task, 'waiting_for_repair', `[runtime] stopped for automatic retry (${trigger})`);
      const retryFn = retryTask || (async ({ tx: innerTx, aggregate: innerAggregate, failure }) => defaultCreateRetry(innerTx, innerAggregate, failure));
      const retryResult = await retryFn({ tx, aggregate, failure: { class: 'no_meaningful_progress', reason: trigger } });
      output = result(true, aggregate, action, { reason: 'stopped and retry created', ...retryResult }); return;
    }
    if (action === RECOMMENDED_ACTION.COLLECT) {
      await transition(state, task, 'collecting', `[runtime] evidence collected (${trigger})`);
      output = result(true, aggregate, action); return;
    }
    if (action === RECOMMENDED_ACTION.ACCEPT) {
      const acceptance = await acceptTask({ store: { async load() { return state; } }, taskId, config, aggregate });
      task.result = { ...(task.result || {}), acceptance_verdict: acceptance.verdict, acceptance_findings: acceptance.findings || [] };
      if (acceptance.verdict === 'pass') {
        if (acceptance.eligible_for_integration) {
          await transition(state, task, 'integrating', '[runtime] machine acceptance passed; integration required');
          if (typeof integrateTask === 'function') {
            const integration = await integrateTask({ task, aggregate, acceptance, state });
            task.result = { ...(task.result || {}), integration };
            await transition(state, task, integration?.ok === false ? 'waiting_for_repair' : 'completed', integration?.ok === false ? '[runtime] integration repair required' : '[runtime] integrated and completed');
          }
        } else {
          await transition(state, task, 'completed', '[runtime] machine acceptance passed');
        }
      } else if (acceptance.verdict === 'repairable') {
        await transition(state, task, 'waiting_for_repair', '[runtime] machine acceptance requested repair');
        const retryFn = retryTask || (async ({ tx: innerTx, aggregate: innerAggregate, failure }) => defaultCreateRetry(innerTx, innerAggregate, failure));
        await retryFn({ tx, aggregate: { ...aggregate, task }, failure: { class: 'acceptance_failed', findings: acceptance.findings } });
      } else {
        await transition(state, task, acceptance.verdict === 'waiting_for_review' ? 'waiting_for_review' : 'failed', `[runtime] acceptance ${acceptance.verdict}`);
      }
      output = result(true, aggregate, action, { acceptance }); return;
    }
    if (action === RECOMMENDED_ACTION.INTEGRATE) {
      if (typeof integrateTask !== 'function') {
        await transition(state, task, 'waiting_for_review', '[runtime] integration handler unavailable');
        output = result(true, aggregate, action, { reason: 'integration handler unavailable' }); return;
      }
      const integration = await integrateTask({ task, aggregate, state });
      task.result = { ...(task.result || {}), integration };
      await transition(state, task, integration?.ok === false ? 'waiting_for_repair' : 'completed', integration?.ok === false ? '[runtime] integration failed' : '[runtime] integration completed');
      output = result(true, aggregate, action, { integration }); return;
    }
    if (action === RECOMMENDED_ACTION.COMPLETE) { await transition(state, task, 'completed', '[runtime] completed'); await tx.locks.releaseForTask(taskId); if (typeof releaseTaskLock === 'function') { try { await releaseTaskLock(taskId); } catch {} } output = result(true, aggregate, action); return; }
    if (action === RECOMMENDED_ACTION.FAIL) { await transition(state, task, 'failed', '[runtime] terminal failure'); await tx.locks.releaseForTask(taskId); if (typeof releaseTaskLock === 'function') { try { await releaseTaskLock(taskId); } catch {} } output = result(true, aggregate, action); return; }
    if (action === RECOMMENDED_ACTION.ASK) { await transition(state, task, 'waiting_for_review', '[runtime] decision required'); output = result(true, aggregate, action); return; }
    output = result(false, aggregate, action, { reason: `unknown action: ${action}` });
  });
  return output;
}

export async function reconcileAllActiveTaskRuntimes({ store, config = {}, sessionProvider = null, sessionResolver = null, lockResolver = null, worktreeResolver = null, evidenceResolver = null, ...handlers } = {}) {
  const state = await store.load();
  const active = new Set(['running', 'starting', 'collecting', 'accepting', 'waiting_for_repair']);
  const ids = (state.tasks || []).filter((task) => active.has(task.status)).map((task) => task.id);
  const results = [];
  for (const taskId of ids) {
    try {
      const context = {
        session: typeof sessionResolver === 'function' ? await sessionResolver(taskId) : null,
        lock: typeof lockResolver === 'function' ? await lockResolver(taskId) : null,
        worktree: typeof worktreeResolver === 'function' ? await worktreeResolver(taskId) : null,
        evidence: typeof evidenceResolver === 'function' ? await evidenceResolver(taskId) : undefined,
      };
      results.push(await reconcileTaskRuntime({ store, config, taskId, sessionProvider, context, ...handlers, trigger: 'bulk_reconciler' }));
    }
    catch (error) { results.push({ task_id: taskId, action: 'error', error: error.message }); }
  }
  return results;
}

export { HEALTH, RECOMMENDED_ACTION } from './task-runtime-aggregate.mjs';
