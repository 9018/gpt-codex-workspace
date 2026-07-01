import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";
import {
  ACTIVE_EXECUTION_STATUSES,
  TASK_STATUSES,
  isHumanReviewStatus,
  normalizeTaskStatus,
} from "./task-status-taxonomy.mjs";

const EXECUTION_SNAPSHOT_STATUSES = new Set([
  ...ACTIVE_EXECUTION_STATUSES,
  TASK_STATUSES.WAITING_FOR_REVIEW,
]);

function formatExecutionSnapshotStatus(status) {
  const normalized = normalizeTaskStatus(status);
  if (normalized === TASK_STATUSES.RUNNING) return 'still running';
  if (normalized === TASK_STATUSES.WAITING_FOR_LOCK) return 'waiting_for_lock (blocked by another task)';
  if (isHumanReviewStatus(status)) return 'waiting_for_review (needs manual review)';
  return status;
}

function isExecutionSnapshotStatus(status) {
  return EXECUTION_SNAPSHOT_STATUSES.has(normalizeTaskStatus(status));
}

function compactEvidencePath(path) {
  if (!path) return null;
  const text = String(path);
  if (text.length <= 96) return text;
  return '...' + text.slice(-93);
}

function collectRunEvidencePaths(task = {}, result = {}) {
  const paths = {};
  if (result.evidence_paths && typeof result.evidence_paths === 'object') {
    for (const [key, value] of Object.entries(result.evidence_paths)) {
      if (typeof value === 'string' && value) paths[key] = value;
    }
  }
  for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
    const path = typeof artifact === 'string' ? artifact : artifact?.path;
    if (!path || typeof path !== 'string') continue;
    if (path.endsWith('events.jsonl')) paths.events_jsonl = paths.events_jsonl || path;
    if (path.endsWith('verification.log')) paths.verification_log = paths.verification_log || path;
    if (path.endsWith('acceptance.evidence.json')) paths.acceptance_evidence_json = paths.acceptance_evidence_json || path;
  }
  return paths;
}

export function getTaskCard(data) {
  const task = data.task;
  if (!task) return formatToolCard('Task', { lines: ['  Task not found'] });

  const lines = [
    formatKeyValue('id', task.id),
    formatKeyValue('title', (task.title || '').slice(0, 80)),
    formatKeyValue('lifecycle stage', task.status),
    formatKeyValue('mode', task.mode || '-'),
    formatKeyValue('assignee', task.assignee || '-'),
  ];

  if (task.created_at) {
    lines.push(formatKeyValue('created', task.created_at));
  }
  if (task.updated_at) {
    lines.push(formatKeyValue('updated', task.updated_at));
  }
  if (task.goal_id) {
    lines.push(formatKeyValue('linked goal', task.goal_id));
  }

  // Log summary (last 3 entries)
  const logs = task.logs || [];
  if (logs.length > 0) {
    const lastLogs = logs.slice(-3);
    lines.push('');
    lines.push(`  logs: ${logs.length} entries (last ${lastLogs.length} shown)`);
    for (const log of lastLogs) {
      const msg = (log.message || '').slice(0, 100);
      lines.push(`    ${log.time ? log.time.slice(0, 19).replace('T', ' ') : '?'}  ${msg}`);
    }
  }

  // Artifacts summary
  const artifacts = task.artifacts || [];
  if (artifacts.length > 0) {
    lines.push('');
    lines.push(formatKeyValue('artifacts', artifacts.length));
  }

  // Result summary
  const result = task.result || {};
  if (result.summary) {
    lines.push(formatKeyValue('result summary', result.summary.slice(0, 100)));
  }
  if (result.changed_files && Array.isArray(result.changed_files) && result.changed_files.length > 0) {
    lines.push(formatKeyValue('changed files', result.changed_files.length));
    for (const f of result.changed_files.slice(0, 5)) {
      lines.push(`    ${f}`);
    }
    if (result.changed_files.length > 5) {
      lines.push(`    ... and ${result.changed_files.length - 5} more`);
    }
  }
  if (result.tests) {
    lines.push(formatKeyValue('tests', result.tests));
  } else if (result.tests === null || result.tests === undefined) {
    lines.push(formatKeyValue('tests', 'tests_missing'));
  }
  if (result.commit) {
    lines.push(formatKeyValue('commit', result.commit.slice(0, 12)));
  }

  const runEvidencePaths = collectRunEvidencePaths(task, result);
  if (Object.keys(runEvidencePaths).length > 0) {
    lines.push('');
    lines.push('  Run evidence:');
    if (runEvidencePaths.events_jsonl) lines.push(formatKeyValue('events.jsonl', compactEvidencePath(runEvidencePaths.events_jsonl)));
    if (runEvidencePaths.verification_log) lines.push(formatKeyValue('verification.log', compactEvidencePath(runEvidencePaths.verification_log)));
    if (runEvidencePaths.acceptance_evidence_json) lines.push(formatKeyValue('acceptance.evidence.json', compactEvidencePath(runEvidencePaths.acceptance_evidence_json)));
    const otherKeys = Object.keys(runEvidencePaths).filter((key) => !['events_jsonl', 'verification_log', 'acceptance_evidence_json'].includes(key));
    if (otherKeys.length > 0) lines.push(formatKeyValue('other artifacts', otherKeys.length));
  }

  // Verification status
  const verification = result.verification;
  if (verification) {
    const verStatus = verification.passed === true ? 'passed' : (verification.passed === false ? 'failed' : 'present');
    lines.push(formatKeyValue('verification', verStatus));
  } else if (result.tests === null || result.tests === undefined) {
    lines.push(formatKeyValue('verification', 'missing'));
  }

  // Acceptance summary
  const acceptance = result.acceptance || result.acceptance_result || {};
  if (acceptance.overall_status) {
    lines.push(formatKeyValue('acceptance', acceptance.overall_status));
  }
  if (typeof acceptance.blocking_count === 'number') {
    lines.push(formatKeyValue('blocking count', acceptance.blocking_count));
  }
  if (typeof acceptance.residual_count === 'number') {
    lines.push(formatKeyValue('residual count', acceptance.residual_count));
  }

  // Repair info
  const repair = result.repair || {};
  if (repair.root_task_id || repair.parent_task_id || repair.repair_attempt != null) {
    lines.push('');
    lines.push('  Repair:');
    if (repair.root_task_id) lines.push(formatKeyValue('root task', repair.root_task_id));
    if (repair.parent_task_id) lines.push(formatKeyValue('parent task', repair.parent_task_id));
    if (repair.repair_attempt != null) lines.push(formatKeyValue('attempt', repair.repair_attempt + (repair.max_attempts != null ? '/' + repair.max_attempts : '')));
    if (repair.retained_worktree) lines.push(formatKeyValue('retained worktree', repair.retained_worktree));
    if (repair.retained_branch) lines.push(formatKeyValue('retained branch', repair.retained_branch));
  }

  // Integration info
  const integration = result.integration || {};
  if (integration.mode || integration.branch || integration.push_status || integration.pr_status || integration.merge_status) {
    lines.push('');
    lines.push('  Integration:');
    if (integration.mode) lines.push(formatKeyValue('mode', integration.mode));
    if (integration.branch) lines.push(formatKeyValue('branch', integration.branch));
    if (integration.commit) lines.push(formatKeyValue('commit', integration.commit.slice(0, 12)));
    if (integration.push_status) lines.push(formatKeyValue('push', integration.push_status));
    if (integration.pr_status) lines.push(formatKeyValue('PR', integration.pr_status));
    if (integration.merge_status) lines.push(formatKeyValue('merge', integration.merge_status));
  }

  // Warnings
  const warnings = [];
  if (result.warnings && Array.isArray(result.warnings)) {
    for (const w of result.warnings) {
      warnings.push(typeof w === 'string' ? w : (w.message || w.code || String(w)));
    }
  }
  if (isHumanReviewStatus(task.status)) {
    warnings.push('Task needs review before completing');
    if (task.waiting_for_review_reason) {
      warnings.push('Reason: ' + task.waiting_for_review_reason);
    } else if (result.waiting_for_review_reason) {
      warnings.push('Reason: ' + result.waiting_for_review_reason);
    }
  }
  // Retained worktree/branch from task level
  if (task.retained_worktree || result.retained_worktree || repair.retained_worktree) {
    warnings.push('Retained worktree present - cleanup may be needed');
  }

  return formatToolCard('Task', { lines, warnings });
}


/**
 * Format create_encoded_goal structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from create_encoded_goal
 * @returns {string}
 */
export function createEncodedGoalCard(data) {
  const goal = data.goal;
  if (!goal) return formatToolCard('Goal', { lines: ['  Goal not found'] });

  const lines = [
    formatKeyValue('goal id', goal.id),
    formatKeyValue('title', (goal.title || '').slice(0, 80)),
    formatKeyValue('status', goal.status),
    formatKeyValue('mode', goal.mode || '-'),
    formatKeyValue('assignee', goal.assignee || '-'),
    formatKeyValue('assigned to Codex', goal.assignee === 'codex' ? 'yes' : 'no'),
  ];

  if (goal.task_id) {
    lines.push(formatKeyValue('task id', goal.task_id));
  }
  if (data.workspace_files) {
    if (data.workspace_files.goal_md) lines.push(formatKeyValue('goal path', data.workspace_files.goal_md));
    if (data.workspace_files.result_md) lines.push(formatKeyValue('result path', data.workspace_files.result_md));
    if (data.workspace_files.dir) lines.push(formatKeyValue('dir', data.workspace_files.dir));
  } else if (data.goal) {
    lines.push(formatKeyValue('dir', `.gptwork/goals/${data.goal.id}`));
  }

  if (data.execution) {
    lines.push('');
    lines.push(formatKeyValue('execution status', data.execution.status || '?'));
    const execWait = data.execution.elapsed_ms ?? (data.execution.wait_duration_ms || data.execution.wait_ms || 0);
    lines.push(formatKeyValue('execution wait', `${execWait}ms`));

    // Non-terminal snapshot: show task status, last logs, linked goal, result path
    const execTask = data.execution.task || data.task;
    if (execTask) {
      if (execTask.status) lines.push(formatKeyValue('task status', execTask.status));
      if (isExecutionSnapshotStatus(execTask.status)) {
        lines.push(formatKeyValue('currently', formatExecutionSnapshotStatus(execTask.status)));
      }
      // Log metadata: bytes, heartbeat age from execution snapshot
      if (data.execution.log_bytes !== undefined) {
        lines.push(formatKeyValue('log bytes', data.execution.log_bytes));
      }
      if (data.execution.last_log_age_ms !== undefined && data.execution.last_log_age_ms !== null) {
        const ageSec = (data.execution.last_log_age_ms / 1000).toFixed(0) + 's';
        lines.push(formatKeyValue('last heartbeat', ageSec));
      }
      if (execTask.logs && execTask.logs.length > 0) {
        const tail = execTask.logs.slice(-3);
        lines.push(formatKeyValue('last logs', tail.length + ' of ' + execTask.logs.length));
        for (const log of tail) {
          const msg = (log.message || '').slice(0, 100);
          lines.push('    ' + (log.time ? log.time.slice(0, 19).replace('T', ' ') : '?') + '  ' + msg);
        }
      }
      if (execTask.result && execTask.result.summary) {
        lines.push(formatKeyValue('result summary', execTask.result.summary.slice(0, 100)));
      }
      if (execTask.goal_id) lines.push(formatKeyValue('linked goal', execTask.goal_id));
      if (data.workspace_files && data.workspace_files.result_md) lines.push(formatKeyValue('result path', data.workspace_files.result_md));
    }

    // Messages tail from execution snapshot
    if (data.execution.messages_tail && data.execution.messages_tail.length > 0) {
      lines.push(formatKeyValue('recent messages', data.execution.messages_tail.length));
      for (const msg of data.execution.messages_tail.slice(-3)) {
        const mtext = (msg.content || '').slice(0, 80);
        if (mtext) lines.push('    [' + (msg.role || '?') + '] ' + mtext);
      }
    }

    if (data.execution.goal_status) {
      lines.push(formatKeyValue('goal status', data.execution.goal_status));
    }
  }

  return formatToolCard('Goal Created', { lines });
}


/**
 * Format preview_codex_context / project_context_status data as a compact card.
 *
 * @param {object} data   - The structuredContent from context_status / project_context_status
 * @returns {string}
 */
