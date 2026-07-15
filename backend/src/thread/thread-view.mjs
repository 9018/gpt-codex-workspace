/**
 * thread-view.mjs — Stable user Thread identity
 *
 * Provides helpers to resolve the root Goal from any child or repair goal,
 * and to build a user-facing thread view that is stable across repairs,
 * retries, follow-ups, and verification cycles.
 *
 * Root Goal is the durable, user-visible Thread identity.
 * Internal child goals (repair, retry, follow-up) inherit root_goal_id
 * and retain their own internal_title for audit.
 *
 * @module thread/thread-view
 */

/**
 * Resolve the root Goal from any goal in the same lineage.
 *
 * Walks up by root_goal_id.  A goal whose root_goal_id matches its own id
 * (or is not set, falling back to its own id) is the root.
 *
 * @param {object|null|undefined} state - State store state (with goals array)
 * @param {object|null|undefined} goal  - Goal object
 * @returns {object|null} Root goal, or null if unresolvable
 */
export function resolveRootGoal(state, goal) {
  if (!goal) return null;
  if (!state || !Array.isArray(state.goals)) return null;

  const rootId = goal.root_goal_id || goal.id;
  if (!rootId) return null;

  // Fast path: root goal points to itself
  if (rootId === goal.id) return goal;

  // Walk lineage
  const root = state.goals.find(g => g.id === rootId);
  return root || null;
}

/**
 * Build a stable user-facing Thread view from any goal.
 *
 * Returns null when the goal is nil.
 *
 * @param {object|null|undefined} state - State store state
 * @param {object|null|undefined} goal  - Any goal in the thread
 * @returns {object|null} Thread view or null
 */
export function buildThreadView(state, goal) {
  if (!goal) return null;

  const root = resolveRootGoal(state, goal);
  const rootId = root ? root.id : goal.root_goal_id || goal.id;
  const rootTitle = root ? (root.title || root.user_request || '') : '';
  const internalTitle = goal.title || goal.user_request || '';

  // Derive phase from root's mode
  const rootMode = root ? (root.mode || goal.mode || 'full') : (goal.mode || 'full');

  return {
    thread_id: rootId,
    root_goal_id: rootId,
    thread_title: rootTitle,
    internal_title: internalTitle,
    phase: rootMode,
    iteration: Number.isInteger(goal.attempt) ? goal.attempt : 0,
    is_internal_child: goal.root_goal_id != null && goal.root_goal_id !== goal.id,
  };
}
