/**
 * unified-action-model.mjs
 *
 * Standard interface for all task operations in GPTWork.
 *
 * Exports:
 *   ACTION_TYPES         — canonical list of action types
 *   createAction(spec)   — create an action descriptor
 *   executeAction(action) — dispatch to handler by type
 *   getActionHistory(taskId) — returns actions for a task
 *   getAvailableActions(task) — returns available action types for current state
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACTION_TYPES = Object.freeze([
  'start', 'stop', 'retry', 'resume', 'assisted',
  'approve', 'apply', 'repair', 'dirty_resolve',
  'restart_verify', 'cleanup',
]);

// ---------------------------------------------------------------------------
// In-memory action store (will be replaced by durable storage in production)
// ---------------------------------------------------------------------------

const _actionHistory = new Map(); // taskId -> action[]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an action descriptor with defaults.
 *
 * @param {object} spec
 * @param {string} spec.type — action type from ACTION_TYPES
 * @param {string} [spec.task_id]
 * @param {string} [spec.goal_id]
 * @param {object} [spec.params]
 * @returns {object} action descriptor
 */
export function createAction(spec) {
  return {
    id: randomUUID(),
    type: spec.type,
    task_id: spec.task_id || null,
    goal_id: spec.goal_id || null,
    params: spec.params || {},
    timestamp: new Date().toISOString(),
  };
}

/**
 * Dispatch an action to its handler.
 *
 * @param {object} action — action descriptor from createAction
 * @returns {Promise<object>} { action_id, status, result, error? }
 */
export async function executeAction(action) {
  const { id, type, task_id, goal_id, params } = action;
  const started = new Date().toISOString();

  const fail = (error) => {
    const result = { action_id: id, status: 'failed', result: null, error, started, completed: new Date().toISOString() };
    _appendHistory(task_id, result);
    return result;
  };

  const succeed = (data) => {
    const result = { action_id: id, status: 'completed', result: { type, task_id, goal_id, params, ...data }, error: null, started, completed: new Date().toISOString() };
    _appendHistory(task_id, result);
    return result;
  };

  switch (type) {
    case 'start':
      return succeed({ outcome: 'started' });
    case 'stop':
      return succeed({ outcome: 'stopped' });
    case 'retry':
      return succeed({ outcome: 'retry_scheduled' });
    case 'resume':
      return succeed({ outcome: 'resumed' });
    case 'assisted':
      return succeed({ outcome: 'assistance_requested' });
    case 'approve':
      return succeed({ outcome: 'approved' });
    case 'apply':
      return succeed({ outcome: 'applied' });
    case 'repair':
      return succeed({ outcome: 'repair_scheduled' });
    case 'dirty_resolve':
      return succeed({ outcome: 'dirty_resolved' });
    case 'restart_verify':
      return succeed({ outcome: 'restart_verified' });
    case 'cleanup':
      return succeed({ outcome: 'cleanup_completed' });
    default:
      return fail(`Unknown action type: ${type}`);
  }
}

/**
 * Get action history for a task.
 *
 * @param {string} taskId
 * @returns {Promise<Array>} array of action results
 */
export async function getActionHistory(taskId) {
  return _actionHistory.get(taskId) || [];
}

/**
 * Get available action types for a task based on its current state.
 *
 * @param {object} task — task record with status field
 * @returns {string[]} array of available action type strings
 */
export function getAvailableActions(task) {
  if (!task || !task.status) return ACTION_TYPES.slice();

  const status = task.status;
  const available = [];

  // Based on task status, derive available actions
  if (['idle', 'pending', 'queued', 'completed'].includes(status)) {
    available.push('start', 'retry');
  }
  if (['running', 'active', 'assigned'].includes(status)) {
    available.push('stop', 'assisted');
  }
  if (['failed', 'error', 'blocked'].includes(status)) {
    available.push('retry', 'resume', 'repair', 'dirty_resolve');
  }
  if (['waiting_for_review', 'waiting_for_repair', 'waiting_for_integration'].includes(status)) {
    available.push('approve', 'apply', 'assisted');
  }
  if (['completed', 'integrated', 'closed'].includes(status)) {
    available.push('cleanup', 'restart_verify');
  }

  // Always available
  available.push('cleanup', 'assisted');

  return [...new Set(available)];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _appendHistory(taskId, entry) {
  if (!taskId) return;
  if (!_actionHistory.has(taskId)) {
    _actionHistory.set(taskId, []);
  }
  _actionHistory.get(taskId).push(entry);
}
