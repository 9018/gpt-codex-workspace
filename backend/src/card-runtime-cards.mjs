import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";
import { ACTIVE_EXECUTION_STATUSES, TASK_STATUSES } from "./task-status-taxonomy.mjs";

const QUEUE_DISPLAY_ROWS = [
  [TASK_STATUSES.ASSIGNED, "assigned"],
  [TASK_STATUSES.QUEUED, "queued"],
  [TASK_STATUSES.RUNNING, "running"],
  [TASK_STATUSES.WAITING_FOR_LOCK, "waiting for lock"],
  [TASK_STATUSES.WAITING_FOR_INTEGRATION, "waiting for integration"],
  ["current_blockers", "current blockers"],
  ["actionable_review", "actionable review"],
  [TASK_STATUSES.COMPLETED, "completed"],
  [TASK_STATUSES.FAILED, "failed"],
];

function queueCurrentBlockers(q = {}) {
  const actionableReview = q.actionable_review ?? q.waiting_for_review ?? 0;
  return (q.waiting_for_lock ?? 0)
    + (q.waiting_for_integration ?? 0)
    + actionableReview
    + (q.failed ?? 0);
}

function queueDisplayValue(q = {}, key) {
  if (key === "current_blockers") return q.current_blockers ?? queueCurrentBlockers(q);
  if (key === "actionable_review") return q.actionable_review ?? q.waiting_for_review ?? 0;
  return q[key] ?? 0;
}

function addQueueDisplayRows(lines, q = {}) {
  lines.push('');
  lines.push('  Queue:');
  for (const [key, label] of QUEUE_DISPLAY_ROWS) {
    lines.push(formatKeyValue(label, queueDisplayValue(q, key)));
  }
  if (q.oldest_age_ms) {
    const activeAges = Object.entries(q.oldest_age_ms)
      .filter(([st]) => ACTIVE_EXECUTION_STATUSES.has(st))
      .filter(([, age]) => age > 0)
      .map(([st, age]) => `${st}=${Math.round(age / 1000)}s`);
    if (activeAges.length > 0) {
      lines.push(formatKeyValue('oldest ages', activeAges.join(', ')));
    }
  }
}

export function runtimeStatusCard(data) {
  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    '',
    formatKeyValue('worker', data.worker ? (data.worker.enabled ? 'enabled' : 'disabled') : '?'),
    formatKeyValue('queue assigned', data.queue?.assigned ?? data.worker?.queue?.assigned ?? 0),
  ];

  // Queue breakdown (from collectWorkerQueueCounts)
  if (data.queue) {
    addQueueDisplayRows(lines, data.queue);
  }

  // Worker health
  if (data.worker?.health) {
    const h = data.worker.health;
    lines.push('');
    lines.push(`  Health: ${h.phase}`);
    if (h.reason) lines.push(formatKeyValue('reason', h.reason));
    if (h.last_tick_age_ms != null) lines.push(formatKeyValue('last tick age', `${Math.round(h.last_tick_age_ms / 1000)}s`));
    if (h.current_tick_duration_ms != null) lines.push(formatKeyValue('current tick', `${Math.round(h.current_tick_duration_ms / 1000)}s`));
    if (h.next_tick_overdue_ms != null) lines.push(formatKeyValue('next tick overdue', `${Math.round(h.next_tick_overdue_ms / 1000)}s`));
  }

  // Bark (safe)
  if (data.bark) {
    lines.push(formatKeyValue('Bark', data.bark.enabled ? 'enabled' : 'not configured'));
  }

  // GitHub
  if (data.github) {
    const ghStatus = data.github.api_sync_enabled ? 'enabled' : 'disabled';
    const ghRepo = data.github.api_repo_set ? (data.github.api_sync_enabled ? 'yes' : 'configured, sync off') : 'not configured';
    lines.push(formatKeyValue('GitHub', `${ghStatus} (${ghRepo})`));
  }

  // Diagnostics - collect warnings
  const diagnostics = [];
  if (data.worktree_dirty) {
    diagnostics.push({ severity: 'warning', message: `Dirty worktree (${(data.dirty_paths || []).length} file(s))` });
  }
  if (data.runtime_env_loaded === false && !data.runtime_env_configured) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env loaded' });
  }
  if (data.worker?.health?.phase === 'stalled' || data.worker?.health?.phase === 'overdue') {
    diagnostics.push({ severity: 'warning', message: `Worker health: ${data.worker.health.phase} — ${data.worker.health.reason}` });
  }

  return formatToolCard('Runtime Status', { lines, diagnostics });
}


/**
 * Format worker_status structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from worker_status
 * @returns {string}
 */
export function workerStatusCard(data) {
  if (!data) return formatToolCard('Worker Status', { lines: ['  No worker data'] });

  const lines = [
    formatKeyValue('worker', data.enabled ? 'enabled' : 'disabled'),
    formatKeyValue('running', data.running ? 'yes' : 'no'),
  ];

  if (data.health) {
    lines.push(formatKeyValue('health phase', data.health.phase));
    if (data.health.reason) lines.push(formatKeyValue('reason', data.health.reason));
    if (data.health.last_tick_age_ms != null) lines.push(formatKeyValue('last tick age', `${Math.round(data.health.last_tick_age_ms / 1000)}s`));
    if (data.health.current_tick_duration_ms != null) lines.push(formatKeyValue('current tick duration', `${Math.round(data.health.current_tick_duration_ms / 1000)}s`));
    if (data.health.next_tick_overdue_ms != null) lines.push(formatKeyValue('next tick overdue', `${Math.round(data.health.next_tick_overdue_ms / 1000)}s`));
  }

  lines.push(formatKeyValue('interval', data.interval_ms ? `${data.interval_ms}ms` : '?'));
  if (data.current_interval_ms) lines.push(formatKeyValue('current interval', `${data.current_interval_ms}ms`));

  // Queue counts
  if (data.queue) {
    addQueueDisplayRows(lines, data.queue);
  } else {
    lines.push(formatKeyValue('queue assigned', data.queue?.assigned ?? data.queues?.assigned ?? 0));
    lines.push(formatKeyValue('queue running', data.queue?.running ?? data.queues?.running ?? 0));
  }

  lines.push(formatKeyValue('started', data.started_at || '-'));
  if (data.last_tick_finished_at) lines.push(formatKeyValue('last tick', data.last_tick_finished_at));
  if (data.last_tick_started_at) lines.push(formatKeyValue('tick started', data.last_tick_started_at));
  if (data.last_tick_duration_ms != null) lines.push(formatKeyValue('tick duration', `${data.last_tick_duration_ms}ms`));
  if (data.next_tick_due_at) lines.push(formatKeyValue('next tick due', data.next_tick_due_at));
  if (data.concurrency) lines.push(formatKeyValue('concurrency', data.concurrency));
  if (data.limit) lines.push(formatKeyValue('limit', data.limit));
  if (data.last_tick_result?.inspected != null) lines.push(formatKeyValue('last inspected', data.last_tick_result.inspected));
  if (data.last_tick_result?.completed != null) lines.push(formatKeyValue('last completed', data.last_tick_result.completed));
  if (data.last_tick_result?.github_sync != null) lines.push(formatKeyValue('last github sync', data.last_tick_result.github_sync?.ok === false ? 'failed' : 'ok'));

  const warnings = [];
  if (data.health?.phase === 'stalled' || data.health?.phase === 'overdue') {
    warnings.push(`Worker health: ${data.health.phase} — ${data.health.reason}`);
  }
  if (data.last_error) warnings.push('Last error: ' + data.last_error.slice(0, 120));
  if (!data.enabled) warnings.push('Worker is disabled — codex tasks will not be processed automatically');

  return formatToolCard('Worker Status', { lines, warnings });
}


/**
 * Format gptwork_doctor structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from gptwork_doctor
 * @returns {string}
 */
export function gptworkDoctorCard(data) {

  if (!data) return formatToolCard('GPTWork Doctor', { lines: ['  No data'] });

  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    formatKeyValue('env file', data.runtime_env_loaded ? 'loaded' : (data.runtime_env_configured ? 'process.env' : 'missing')),
    formatKeyValue('registry repos', data.repository_registry_count ?? 0),
    formatKeyValue('stale clones', data.stale_clone_count ?? 0),
    formatKeyValue('GitHub sync', data.github_api_sync_enabled ? 'enabled' : 'disabled'),
    formatKeyValue('Bark', data.bark_configured ? 'configured' : 'not configured'),
    formatKeyValue('worker', data.worker?.enabled ? 'enabled' : 'disabled'),
  ];

  // Build diagnostics from doctor data
  const diagnostics = [];
  if (data.worktree_dirty) {
    diagnostics.push({ severity: 'warning', message: `Worktree dirty (${(data.dirty_paths || []).length} file(s))` });
  }
  if (data.stale_clone_count > 0) {
    diagnostics.push({ severity: 'warning', message: `${data.stale_clone_count} stale clone(s) in workspace root` });
  }
  if (!data.runtime_env_loaded && !data.runtime_env_configured) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env -- set GPTWORK_* variables or create runtime.env' });
  }
  if (!data.repository_registry_has_canonical_repo) {
    diagnostics.push({ severity: 'warning', message: 'Canonical repo not registered -- use register_repository' });
  }

  const nextActions = (data.suggested_next_actions || []).slice(0, 8);

  return formatToolCard('GPTWork Doctor', { lines, diagnostics, nextActions });
}
