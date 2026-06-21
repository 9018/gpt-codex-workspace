import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";

export function getTaskCard(data) {
  const task = data.task;
  if (!task) return formatToolCard('Task', { lines: ['  Task not found'] });

  const lines = [
    formatKeyValue('id', task.id),
    formatKeyValue('title', (task.title || '').slice(0, 80)),
    formatKeyValue('status', task.status),
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
  }
  if (result.commit) {
    lines.push(formatKeyValue('commit', result.commit.slice(0, 12)));
  }

  // Warnings
  const warnings = [];
  if (result.warnings && Array.isArray(result.warnings)) {
    for (const w of result.warnings) {
      warnings.push(typeof w === 'string' ? w : (w.message || w.code || String(w)));
    }
  }
  if (task.status === 'waiting_for_review') {
    warnings.push('Task needs review before completing');
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
      const nonTerminalStatuses = ['assigned', 'queued', 'running', 'waiting_for_lock', 'waiting_for_review'];
      if (nonTerminalStatuses.includes(execTask.status)) {
        lines.push(formatKeyValue('currently', execTask.status === 'running' ? 'still running' : execTask.status === 'waiting_for_lock' ? 'waiting_for_lock (blocked by another task)' : execTask.status === 'waiting_for_review' ? 'waiting_for_review (needs manual review)' : execTask.status));
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
