import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";

export function contextStatusCard(data) {
  if (!data) return formatToolCard('Context Status', { lines: ['  No context data'] });

  const lines = [
    formatKeyValue('workspace root', data.workspace_root || '-'),
    formatKeyValue('canonical repo', data.canonical_repo_path || data.default_repo_path || 'not set'),
  ];

  if (data.project_md) {
    lines.push(formatKeyValue('project.md', data.project_md.ok ? 'found' : 'missing'));
  }
  if (data.project_env) {
    const envDetail = !data.project_env.ok ? 'missing'
      : (data.project_env.keys || []).length === 0 ? 'empty'
      : `${data.project_env.keys.length} key(s)`;
    lines.push(formatKeyValue('project.env', envDetail));
  }

  if (data.context_source_precedence) {
    lines.push(formatKeyValue('source precedence', `${data.context_source_precedence.length} level(s)`));
  }

  // Warnings from context status
  const warnings = [];
  if (data.warnings && Array.isArray(data.warnings)) {
    for (const w of data.warnings) {
      warnings.push(typeof w === 'string' ? w : (w.message || w.code || String(w)));
    }
  }

  // Context size info
  if (data.context_size) {
    const sz = data.context_size;
    const parts = [];
    if (sz.total_bytes != null) parts.push(`${sz.total_bytes} bytes`);
    if (sz.total_lines != null) parts.push(`${sz.total_lines} lines`);
    if (parts.length > 0) {
      lines.push('');
      lines.push(formatKeyValue('context size', parts.join(', ')));
    }
  }

  return formatToolCard('Context Status', { lines, warnings });
}


/**
 * Format github_status structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from github_status
 * @returns {string}
 */

export function previewCodexContextCard(data) {
  if (!data) return formatToolCard('Codex Context', { lines: ['  No context data'] });

  const ctx = data.context || {};
  const lines = [];

  // Linked task
  const task = ctx.task || {};
  if (task.id) {
    lines.push(formatKeyValue('task id', task.id));
    lines.push(formatKeyValue('task title', (task.title || '').slice(0, 60)));
    lines.push(formatKeyValue('task status', task.status || '-'));
    lines.push(formatKeyValue('task mode', task.mode || '-'));
  } else {
    lines.push(formatKeyValue('task', 'not linked'));
  }

  // Linked goal
  const goal = ctx.goal || {};
  if (goal.id) {
    lines.push(formatKeyValue('goal id', goal.id));
    lines.push(formatKeyValue('goal status', goal.status || '-'));
  }

  // Workspace
  const ws = ctx.workspace || {};
  if (ws.root) {
    lines.push(formatKeyValue('workspace', ws.root));
  }
  if (ws.type) {
    lines.push(formatKeyValue('workspace type', ws.type));
  }

  // Canonical repo
  const repo = ctx.canonical_repo || {};
  if (repo.path) {
    lines.push(formatKeyValue('canonical repo', repo.path));
    if (repo.record) {
      lines.push(formatKeyValue('remote', repo.record.remote_url || '-'));
    }
  } else {
    lines.push(formatKeyValue('canonical repo', 'not configured'));
  }

  // Context sources (project context files)
  const proj = ctx.project_context || {};
  if (proj.project_md) {
    lines.push(formatKeyValue('project.md', proj.project_md.ok ? 'found' : 'missing'));
  }
  if (proj.project_env) {
    lines.push(formatKeyValue('project.env', proj.project_env.ok ? `${proj.project_env.keys.length} key(s)` : 'missing'));
  }

  // Context size
  const sz = ctx.size_metrics || {};
  const sizeParts = [];
  if (sz.transcript_bytes != null) sizeParts.push(`transcript: ${sz.transcript_size_label || sz.transcript_bytes + 'B'}`);
  if (sz.transcript_message_count != null) sizeParts.push(`${sz.transcript_message_count} messages`);
  if (sz.memory_count != null) sizeParts.push(`${sz.memory_count} memories`);
  if (sizeParts.length > 0) {
    lines.push('');
    lines.push(formatKeyValue('context size', sizeParts.join(', ')));
  }

  // Prompt bytes
  if (data.actual_prompt_bytes != null) {
    const label = data.actual_prompt_bytes > 1024 * 1024
      ? (data.actual_prompt_bytes / (1024 * 1024)).toFixed(1) + ' MB'
      : data.actual_prompt_bytes > 1024
        ? (data.actual_prompt_bytes / 1024).toFixed(1) + ' KB'
        : data.actual_prompt_bytes + ' B';
    lines.push(formatKeyValue('prompt size', label));
  }

  // Warnings
  const warnings = ctx.warnings || [];
  const warningMsgs = warnings.map((w) => {
    const msg = typeof w === 'string' ? w : (w.message || w.code || String(w));
    return msg;
  });

  // Prompt warnings from data
  if (data.actual_prompt_warning) {
    warningMsgs.push(data.actual_prompt_warning);
  }

  return formatToolCard('Codex Context', { lines, warnings: warningMsgs });
}


// ---------------------------------------------------------------------------
// shell_exec card
// ---------------------------------------------------------------------------

/**
 * Format shell_exec structured data as a compact summary.
 * Shows command, cwd, returncode, duration, byte counts, truncation flags,
 * timing, and a preview of stdout/stderr (first N lines).
 *
 * @param {object} data - The structuredContent from shell_exec
 * @returns {string}
 */

export function goalContextCard(data) {
  if (!data) return formatToolCard('Goal Context', { lines: ['  No goal context data'] });

  const goal = data.goal;
  if (!goal) return formatToolCard('Goal Context', { lines: ['  Goal not found'] });

  const lines = [
    formatKeyValue('goal id', goal.id),
    formatKeyValue('title', (goal.title || '').slice(0, 80)),
    formatKeyValue('status', goal.status || '-'),
    formatKeyValue('mode', goal.mode || '-'),
    formatKeyValue('task id', goal.task_id || '-'),
  ];

  if (goal.project_id) {
    lines.push(formatKeyValue('project', goal.project_id));
  }
  if (goal.workspace_id) {
    lines.push(formatKeyValue('workspace', goal.workspace_id));
  }

  // Messages count (without dumping transcript)
  const conversation = data.conversation;
  const msgCount = conversation?.messages?.length ?? 0;
  if (msgCount > 0) {
    lines.push(formatKeyValue('messages', msgCount));
  }

  // Memories count
  const memCount = (data.memories || []).length;
  if (memCount > 0) {
    lines.push(formatKeyValue('memories', memCount));
  }

  // Linked task summary
  const task = data.task;
  if (task) {
    lines.push(formatKeyValue('linked task', task.id || '-'));
    lines.push(formatKeyValue('task status', task.status || '-'));
  }

  // Workspace files summary
  const wf = data.workspace_files;
  if (wf) {
    const present = Object.entries(wf)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    if (present.length > 0) {
      lines.push(formatKeyValue('workspace files', present.join(', ')));
    }
  }

  // Codex instruction presence (but not the full text)
  if (data.codex_instruction) {
    const instrLen = String(data.codex_instruction).length;
    lines.push(formatKeyValue('instruction', `${instrLen} chars`));
  }

  return formatToolCard('Goal Context', { lines });
}
