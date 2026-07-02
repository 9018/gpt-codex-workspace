// @ts-check
/**
 * task-graph-state.mjs — Minimal explicit Task Graph state model.
 *
 * Adds a durable, observable graph-state layer alongside existing task statuses.
 * Existing statuses remain untouched; each task carries a `graph_node` field
 * and an append-only `graph_transitions` array.
 *
 * GRAPH_NODES define the lifecycle positions a task can occupy:
 *   created → context_prepared → builder_running → result_parsed → verified → accepted
 *   → integration_required|integration_not_required → integrated → deployment_checked
 *   → closure_eligible → closed
 *
 * Side branches: result_parsed → repair_required → context_prepared (retry)
 * All nodes may transition to human_interrupted or failed_terminal.
 */

// ---------------------------------------------------------------------------
// Graph node constants
// ---------------------------------------------------------------------------

export const GRAPH_NODES = Object.freeze({
  CREATED: 'created',
  CONTEXT_PREPARED: 'context_prepared',
  BUILDER_RUNNING: 'builder_running',
  RESULT_PARSED: 'result_parsed',
  VERIFIED: 'verified',
  ACCEPTED: 'accepted',
  INTEGRATION_REQUIRED: 'integration_required',
  INTEGRATION_NOT_REQUIRED: 'integration_not_required',
  INTEGRATED: 'integrated',
  DEPLOYMENT_CHECKED: 'deployment_checked',
  CLOSURE_ELIGIBLE: 'closure_eligible',
  CLOSED: 'closed',
  REPAIR_REQUIRED: 'repair_required',
  HUMAN_INTERRUPTED: 'human_interrupted',
  FAILED_TERMINAL: 'failed_terminal',
});

const GRAPH_NODE_VALUES = new Set(Object.values(GRAPH_NODES));

/** All graph node values as a Set for fast lookup. */
export function isValidGraphNode(value) {
  return GRAPH_NODE_VALUES.has(value);
}

// ---------------------------------------------------------------------------
// Valid transition graph
// ---------------------------------------------------------------------------
//
// Each entry maps 'from' → [set of valid 'to' values].
// Two wildcard entries (starting with '*') permit transitions to
// human_interrupted or failed_terminal from any node.

const _VALID = new Map();

function _allow(from, to) {
  if (!_VALID.has(from)) _VALID.set(from, new Set());
  _VALID.get(from).add(to);
}

// Normal forward progression
_allow(GRAPH_NODES.CREATED, GRAPH_NODES.CONTEXT_PREPARED);
_allow(GRAPH_NODES.CONTEXT_PREPARED, GRAPH_NODES.BUILDER_RUNNING);
_allow(GRAPH_NODES.BUILDER_RUNNING, GRAPH_NODES.RESULT_PARSED);
_allow(GRAPH_NODES.RESULT_PARSED, GRAPH_NODES.VERIFIED);
_allow(GRAPH_NODES.RESULT_PARSED, GRAPH_NODES.REPAIR_REQUIRED);
_allow(GRAPH_NODES.RESULT_PARSED, GRAPH_NODES.FAILED_TERMINAL);
_allow(GRAPH_NODES.VERIFIED, GRAPH_NODES.ACCEPTED);
_allow(GRAPH_NODES.VERIFIED, GRAPH_NODES.REPAIR_REQUIRED);
_allow(GRAPH_NODES.ACCEPTED, GRAPH_NODES.INTEGRATION_REQUIRED);
_allow(GRAPH_NODES.ACCEPTED, GRAPH_NODES.INTEGRATION_NOT_REQUIRED);
_allow(GRAPH_NODES.INTEGRATION_REQUIRED, GRAPH_NODES.INTEGRATED);
_allow(GRAPH_NODES.INTEGRATION_REQUIRED, GRAPH_NODES.REPAIR_REQUIRED);
_allow(GRAPH_NODES.INTEGRATION_NOT_REQUIRED, GRAPH_NODES.CLOSURE_ELIGIBLE);
_allow(GRAPH_NODES.INTEGRATED, GRAPH_NODES.DEPLOYMENT_CHECKED);
_allow(GRAPH_NODES.DEPLOYMENT_CHECKED, GRAPH_NODES.CLOSURE_ELIGIBLE);
_allow(GRAPH_NODES.CLOSURE_ELIGIBLE, GRAPH_NODES.CLOSED);

// Repair retry loop
_allow(GRAPH_NODES.REPAIR_REQUIRED, GRAPH_NODES.CONTEXT_PREPARED);

// Wildcard destinations — allowed from any node
const _WILDCARD_TO = new Set([
  GRAPH_NODES.HUMAN_INTERRUPTED,
  GRAPH_NODES.FAILED_TERMINAL,
]);

/**
 * Check whether a transition is valid according to the graph.
 *
 * @param {string} from - Current graph node
 * @param {string} to - Target graph node
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
  if (_WILDCARD_TO.has(to)) return true;
  const allowed = _VALID.get(from);
  return Boolean(allowed && allowed.has(to));
}

// ---------------------------------------------------------------------------
// Transition recording
// ---------------------------------------------------------------------------

/**
 * Record an append-only graph transition for a task.
 *
 * The transition is persisted atomically via store.mutate and updates both
 * `graph_node` and the `graph_transitions` array on the task object.
 *
 * @param {import('./state-store.mjs').StateStore} store
 * @param {string} taskId
 * @param {object} opts
 * @param {string} opts.from             - Current graph node value
 * @param {string} opts.to               - Target graph node value
 * @param {string} [opts.reason]         - Human-readable reason for transition
 * @param {string|null} [opts.evidence]  - Pointer/path to supporting evidence
 * @param {string|null} [opts.source]    - Node or component that initiated transition
 * @returns {Promise<{ task_id: string, transition: object }>}
 */
export async function recordGraphTransition(store, taskId, { from, to, reason, evidence, source }) {
  if (!isValidGraphNode(from)) {
    throw new Error(`invalid graph node 'from': ${from}`);
  }
  if (!isValidGraphNode(to)) {
    throw new Error(`invalid graph node 'to': ${to}`);
  }
  if (!isValidTransition(from, to)) {
    throw new Error(`invalid graph transition: ${from} → ${to}`);
  }

  const transition = {
    task_id: taskId,
    from,
    to,
    reason: reason || '',
    evidence: evidence || null,
    node: source || null,
    created_at: new Date().toISOString(),
  };

  const result = await store.mutate((state) => {
    const task = (state.tasks || []).find((t) => t.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.graph_transitions ||= [];
    task.graph_transitions.push(transition);
    task.graph_node = to;
    task.updated_at = new Date().toISOString();
    state.activities ||= [];
    state.activities.push({
      time: transition.created_at,
      type: 'task.graph_transition',
      task_id: taskId,
      from,
      to,
      reason: reason || null,
    });
    return { transition };
  });

  return { task_id: taskId, transition: result.transition };
}

// ---------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------

/**
 * Build a compact diagnostic string answering:
 *   - Current graph node
 *   - Last transition
 *   - Why the task has not closed
 *   - Which evidence is missing
 *
 * @param {object|null|undefined} task
 * @returns {string}
 */
export function formatGraphDiagnostic(task) {
  if (!task) return 'No task provided.';
  const graphNode = task.graph_node || GRAPH_NODES.CREATED;
  const transitions = Array.isArray(task.graph_transitions) ? task.graph_transitions : [];
  const last = transitions.length > 0 ? transitions[transitions.length - 1] : null;

  const parts = [`node=${graphNode}`];

  if (last) {
    parts.push(`last=${last.from}→${last.to}`);
    if (last.reason) parts.push(`reason=${last.reason}`);
  } else {
    parts.push('last=<none>');
  }

  if (graphNode === GRAPH_NODES.CLOSED) {
    parts.push('closed=true');
    return parts.join(' ');
  }

  // Why not closed — describe the next expected step based on current node
  const nextSteps = {
    [GRAPH_NODES.CREATED]: 'waiting for context preparation',
    [GRAPH_NODES.CONTEXT_PREPARED]: 'waiting for builder execution',
    [GRAPH_NODES.BUILDER_RUNNING]: 'waiting for result parsing',
    [GRAPH_NODES.RESULT_PARSED]: 'waiting for verification',
    [GRAPH_NODES.VERIFIED]: 'waiting for acceptance',
    [GRAPH_NODES.ACCEPTED]: 'waiting for integration decision',
    [GRAPH_NODES.INTEGRATION_REQUIRED]: 'waiting for integration',
    [GRAPH_NODES.INTEGRATION_NOT_REQUIRED]: 'waiting for closure eligibility',
    [GRAPH_NODES.INTEGRATED]: 'waiting for deployment check',
    [GRAPH_NODES.DEPLOYMENT_CHECKED]: 'waiting for closure eligibility',
    [GRAPH_NODES.CLOSURE_ELIGIBLE]: 'ready to close',
    [GRAPH_NODES.REPAIR_REQUIRED]: 'waiting for repair and retry',
    [GRAPH_NODES.HUMAN_INTERRUPTED]: 'blocked on human intervention',
    [GRAPH_NODES.FAILED_TERMINAL]: 'terminal failure',
  };
  const next = nextSteps[graphNode];
  parts.push(next ? `blocked=${next}` : `blocked=unknown_node:${graphNode}`);

  // Evidence check — what evidence fields might be missing
  const missingEvidence = [];
  const result = task.result || {};

  if (graphNode === GRAPH_NODES.BUILDER_RUNNING || graphNode === GRAPH_NODES.RESULT_PARSED) {
    if (!result.summary && !result.kind) missingEvidence.push('result.summary');
    if (!result.changed_files && !result.kind) missingEvidence.push('result.changed_files');
  }
  if (graphNode === GRAPH_NODES.VERIFIED || graphNode === GRAPH_NODES.ACCEPTED) {
    if (!result.verification) missingEvidence.push('result.verification');
    if (!result.acceptance_findings && !task.acceptance_findings) missingEvidence.push('acceptance_findings');
  }
  if (graphNode === GRAPH_NODES.INTEGRATION_REQUIRED || graphNode === GRAPH_NODES.INTEGRATED) {
    if (!result.integration) missingEvidence.push('result.integration');
  }
  if (graphNode === GRAPH_NODES.CLOSURE_ELIGIBLE || graphNode === GRAPH_NODES.CLOSED) {
    if (!result.commit && !result.local_head) missingEvidence.push('result.commit');
  }

  if (missingEvidence.length > 0) {
    parts.push(`missing=[${missingEvidence.join(',')}]`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Initialisation helper
// ---------------------------------------------------------------------------

/**
 * Set the initial graph node on a task object if not already present.
 * Does NOT persist — caller is responsible for saving through the store.
 *
 * @param {object} task
 * @param {object} [opts]
 * @param {string} [opts.initialNode]
 * @returns {object} The task (same reference, mutated in place)
 */
export function setInitialGraphNode(task, { initialNode = GRAPH_NODES.CREATED } = {}) {
  if (!task.graph_node) {
    task.graph_node = initialNode;
  }
  if (!Array.isArray(task.graph_transitions)) {
    task.graph_transitions = [];
  }
  if (task.graph_transitions.length === 0) {
    task.graph_transitions.push({
      task_id: task.id,
      from: '',
      to: initialNode,
      reason: 'task created',
      evidence: null,
      node: 'system',
      created_at: task.created_at || new Date().toISOString(),
    });
  }
  return task;
}
