/**
 * card-utils.mjs — compact visual card formatting helpers
 *
 * Small, testable utilities for producing human-readable compact card summaries
 * from structured tool result data.  These are used by summarizeToolResult in
 * gptwork-server.mjs and can be tested in isolation.
 *
 * Design goals (from GPTWork task):
 *  - compact visual cards with stable, readable sections
 *  - status chip / headline, key-value rows, diagnostics, warnings, next actions
 *  - default truncation for verbose output (git, tree, terminal, diffs, large JSON)
 *  - explicit truncated markers so raw access is discoverable
 *  - pure text output compatible with MCP `type: "text"` responses
 */

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a block of text to at most `maxLines` lines or `maxBytes` bytes.
 * Returns the truncated text plus metadata about what was cut.
 *
 * @param {string|null|undefined} text     - Raw output to truncate
 * @param {number}                [maxLines=20]  - Maximum lines to keep
 * @param {number}                [maxBytes=8000] - Maximum bytes to keep
 * @returns {{ text: string, truncated: boolean, originalLines: number, originalBytes: number, maxLines: number, maxBytes: number }}
 */
export function truncateOutput(text, maxLines = 20, maxBytes = 8000) {
  if (!text) {
    return {
      text: text || '',
      truncated: false,
      originalLines: 0,
      originalBytes: 0,
      maxLines,
      maxBytes,
    };
  }

  const str = String(text);
  const originalBytes = Buffer.byteLength(str, 'utf8');
  const lines = str.split('\n');
  const originalLines = lines.length;

  let result = str;
  let truncated = false;

  // Byte budget first (cheaper for huge strings)
  if (originalBytes > maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    result = buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
    truncated = true;
  }

  // Line budget second (re-truncate if needed)
  const resultLines = result.split('\n');
  if (resultLines.length > maxLines) {
    result = resultLines.slice(0, maxLines).join('\n');
    truncated = true;
  }

  return { text: result, truncated, originalLines, originalBytes, maxLines, maxBytes };
}


/**
 * Format a truncation footer line included at the end of a truncated card.
 *
 * @param {{ truncated: boolean, originalLines: number, originalBytes: number, maxLines: number }|null} info
 * @returns {string} multi-line footer or empty string
 */
export function formatTruncationFooter(info) {
  if (!info || !info.truncated) return '';
  const pct = info.originalLines > 0
    ? ` (${((info.maxLines / info.originalLines) * 100).toFixed(1)}%)`
    : '';
  const bytesPart = info.originalBytes > 0
    ? `, ${info.originalBytes} bytes`
    : '';
  return `[truncated: ${info.originalLines} lines${bytesPart} -- showing first ${info.maxLines}${pct}]`;
}


// ---------------------------------------------------------------------------
// Status chips (red/yellow/green indicators as simple text markers)
// ---------------------------------------------------------------------------

/**
 * Map common status values to a simple three-colour indicator.
 * Returns:  "[OK]" (green) | "[--]" (yellow) | "[!!]" (red)
 *
 * @param {string|boolean} status
 * @returns {string}
 */
export function formatStatusChip(status) {
  if (typeof status === 'boolean') status = status ? 'enabled' : 'disabled';
  const s = String(status).toLowerCase().trim();

  const green = new Set([
    'ok', 'okay', 'completed', 'success', 'enabled', 'clean', 'true',
    'connected', 'active', 'healthy', 'loaded', 'running',
  ]);
  const red = new Set([
    'error', 'failed', 'disabled', 'dirty', 'false', 'disconnected',
    'stale', 'missing', 'broken', 'unhealthy', 'invalid', 'unknown',
    'stopped', 'crashed',
  ]);

  if (green.has(s)) return '[OK]';
  if (red.has(s)) return '[!!]';
  return '[--]';
}


// ---------------------------------------------------------------------------
// Simple section formatters
// ---------------------------------------------------------------------------

/**
 * Render a key-value row with a consistent indentation.
 * Snek-case keys are converted to spaces for readability.
 *
 * @param {string} key
 * @param {*}      value
 * @returns {string}
 */
export function formatKeyValue(key, value) {
  const k = String(key).replace(/_/g, ' ');
  let v;
  if (value === null || value === undefined) {
    v = '-';
  } else if (typeof value === 'boolean') {
    v = value ? 'yes' : 'no';
  } else if (typeof value === 'object') {
    try { v = JSON.stringify(value); } catch { v = String(value); }
    if (v.length > 80) v = v.slice(0, 77) + '...';
  } else {
    v = String(value);
  }
  return `  ${k}: ${v}`;
}


/**
 * Render a diagnostics block with per-item severity indicators.
 *
 * @param {Array<{ severity?: string, message?: string }|string>} items
 * @returns {string}
 */
export function formatDiagnostics(items) {
  if (!items || items.length === 0) return '';
  const lines = [];
  lines.push(' Diagnostics:');
  for (const item of items) {
    const msg = typeof item === 'string' ? item : (item.message || item.code || String(item));
    const sev = typeof item === 'string' ? 'info' : (item.severity || 'info');
    const chip = sev === 'error' ? '[!!]' : sev === 'warning' ? '[--]' : '[OK]';
    lines.push(`  ${chip} ${msg}`);
  }
  return lines.join('\n');
}


/**
 * Render a warnings block.
 *
 * @param {Array<{ message?: string, code?: string }|string>} warnings
 * @returns {string}
 */
export function formatWarnings(warnings) {
  if (!warnings || warnings.length === 0) return '';
  const lines = [];
  lines.push(' Warnings:');
  for (const w of warnings) {
    const msg = typeof w === 'string' ? w : (w.message || w.code || String(w));
    lines.push(`  [!] ${msg}`);
  }
  return lines.join('\n');
}


/**
 * Render a "next actions" block.
 *
 * @param {Array<{ action?: string, message?: string, code?: string }|string>} actions
 * @returns {string}
 */
export function formatNextActions(actions) {
  if (!actions || actions.length === 0) return '';
  const lines = [];
  lines.push(' Next:');
  for (const a of actions) {
    const msg = typeof a === 'string' ? a : (a.message || a.action || a.code || String(a));
    lines.push(`  > ${msg}`);
  }
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Compact card builder
// ---------------------------------------------------------------------------

/**
 * Build a compact visual card text block.
 *
 * Sections are only included if they have content, keeping the output
 * tight and low-noise.
 *
 * @param {string} title   - Card headline (tool name or short label)
 * @param {object} opts
 * @param {Array<string>}  [opts.lines]        - Key-value / status lines
 * @param {Array}          [opts.diagnostics]   - Diagnostic items (severity + message)
 * @param {Array}          [opts.warnings]      - Warning items
 * @param {Array}          [opts.nextActions]   - Next-action items
 * @param {object|null}    [opts.truncation]    - Result from truncateOutput()
 * @returns {string}
 */
export function formatToolCard(title, opts = {}) {
  const {
    lines = [],
    diagnostics = [],
    warnings = [],
    nextActions = [],
    truncation = null,
  } = opts;

  // Determine card width based on title
  const minWidth = 26;
  const maxWidth = 60;
  const titleLen = title.length + 2; // account for spacing around title
  const width = Math.min(maxWidth, Math.max(minWidth, titleLen + 6));

  // Build the divider lines
  const dividerChar = '\u2500';
  const divider = dividerChar.repeat(width);

  // Open divider with title centered
  const leftPad = Math.floor((width - titleLen) / 2);
  const rightPad = width - titleLen - leftPad;
  const openDivider = `${dividerChar.repeat(2)} ${title} ${dividerChar.repeat(Math.max(0, rightPad))}`;

  const parts = [openDivider];

  for (const line of lines) {
    if (line) parts.push(line);
  }

  const diagBlock = formatDiagnostics(diagnostics);
  if (diagBlock) parts.push('', diagBlock);

  const warnBlock = formatWarnings(warnings);
  if (warnBlock) parts.push('', warnBlock);

  const nextBlock = formatNextActions(nextActions);
  if (nextBlock) parts.push('', nextBlock);

  if (truncation && truncation.truncated) {
    parts.push('', formatTruncationFooter(truncation));
  }

  // closing divider
  parts.push(divider);

  return parts.join('\n');
}


// ---------------------------------------------------------------------------
// Specific card formatters for targeted GPTWork tools
// ---------------------------------------------------------------------------

/**
 * Format runtime_status structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from runtime_status
 * @returns {string}
 */
export function runtimeStatusCard(data) {
  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    '',
    formatKeyValue('worker', data.worker ? (data.worker.enabled ? 'enabled' : 'disabled') : '?'),
    formatKeyValue('queue assigned', data.worker?.queue?.assigned ?? '?'),
  ];

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
  if (data.runtime_env_loaded === false) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env loaded' });
  }

  return formatToolCard('Runtime Status', { lines, diagnostics });
}


/**
 * Format gptwork_doctor structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from gptwork_doctor
 * @returns {string}
 */
export function gptworkDoctorCard(data) {
  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    formatKeyValue('env file', data.runtime_env_loaded ? 'loaded' : 'missing'),
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
  if (!data.runtime_env_loaded) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env -- set GPTWORK_* variables or create runtime.env' });
  }
  if (!data.repository_registry_has_canonical_repo) {
    diagnostics.push({ severity: 'warning', message: 'Canonical repo not registered -- use register_repository' });
  }

  const nextActions = (data.suggested_next_actions || []).slice(0, 8);

  return formatToolCard('GPTWork Doctor', { lines, diagnostics, nextActions });
}


/**
 * Format get_task structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from get_task
 * @returns {string}
 */
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
  if (data.workspace_files?.goal_md) {
    lines.push(formatKeyValue('result path', data.workspace_files.goal_md));
  }

  if (data.execution) {
    lines.push('');
    lines.push(formatKeyValue('execution status', data.execution.status || '?'));
    lines.push(formatKeyValue('execution wait', `${data.execution.elapsed_ms || 0}ms`));
  }

  return formatToolCard('Goal Created', { lines });
}


/**
 * Format preview_codex_context / project_context_status data as a compact card.
 *
 * @param {object} data   - The structuredContent from context_status / project_context_status
 * @returns {string}
 */
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
export function githubStatusCard(data) {
  if (!data) return formatToolCard('GitHub Status', { lines: ['  No data'] });

  const syncStatus = data.enabled ? 'enabled' : 'disabled';
  const lines = [
    formatKeyValue('sync', syncStatus),
    formatKeyValue('repo', data.repo || '-'),
  ];

  if (data.known_issues != null) {
    lines.push(formatKeyValue('known issues', data.known_issues));
  }

  if (data.last_sync_at) {
    lines.push(formatKeyValue('last sync', data.last_sync_at));
  }

  const diagnostics = [];
  if (!data.enabled) {
    diagnostics.push({ severity: 'warning', message: 'GitHub sync disabled - check GPTWORK_GITHUB_* env vars' });
  }
  if (!data.repo) {
    diagnostics.push({ severity: 'warning', message: 'No GitHub repo configured' });
  }

  return formatToolCard('GitHub Status', { lines, diagnostics });
}


/**
 * Apply truncation to a raw output field and add metadata.
 * Keeps the full value in `full` for structuredContent consumers.
 *
 * @param {string|null|undefined} raw     - Raw output to truncate
 * @param {number}                [maxLines=20]
 * @param {number}                [maxBytes=8000]
 * @returns {{ text: string, full: string|null, truncated: boolean, originalLines: number, originalBytes: number, maxLines: number, maxBytes: number }}
 */
export function truncateVerboseOutput(raw, maxLines = 20, maxBytes = 8000) {
  const result = truncateOutput(raw, maxLines, maxBytes);
  return {
    ...result,
    full: raw || null,
  };
}


// ---------------------------------------------------------------------------
// preview_codex_context card
// ---------------------------------------------------------------------------

/**
 * Format preview_codex_context structured data as a compact card.
 * Focuses on context sources, canonical repo, context size, warnings,
 * linked task/goal — without dumping the full preview text.
 *
 * @param {object} data - The structuredContent from preview_codex_context
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
export function shellExecCard(data) {
  if (!data) return formatToolCard('Shell Exec', { lines: ['  No data'] });

  const lines = [
    formatKeyValue('command', (data.command || '').slice(0, 120)),
    formatKeyValue('cwd', data.cwd || '.'),
    formatKeyValue('returncode', data.returncode != null ? data.returncode : '-'),
    formatKeyValue('duration', data.duration_ms != null ? `${data.duration_ms}ms` : '-'),
    formatKeyValue('stdout bytes', data.stdout_bytes || 0),
    formatKeyValue('stderr bytes', data.stderr_bytes || 0),
    formatKeyValue('stdout truncated', data.stdout_truncated ? 'yes' : 'no'),
    formatKeyValue('stderr truncated', data.stderr_truncated ? 'yes' : 'no'),
    formatKeyValue('timed out', data.timed_out ? 'yes' : 'no'),
  ];

  if (data.first_output_delay_ms != null) {
    lines.push(formatKeyValue('first output', `${data.first_output_delay_ms}ms`));
  }

  // Stdout/stderr preview (first N lines)
  const MAX_PREVIEW_LINES = 10;
  const diagnostics = [];

  if (data.stdout) {
    const outLines = data.stdout.split('\n');
    const preview = outLines.slice(0, MAX_PREVIEW_LINES);
    const total = outLines.length;
    const label = total <= MAX_PREVIEW_LINES ? `stdout (${total} lines):` : `stdout (first ${MAX_PREVIEW_LINES} of ${total} lines):`;
    diagnostics.push({ severity: 'info', message: label + '\n' + preview.map(l => '  ' + l).join('\n') });
  }

  if (data.stderr) {
    const errLines = data.stderr.split('\n');
    const preview = errLines.slice(0, MAX_PREVIEW_LINES);
    const total = errLines.length;
    const label = total <= MAX_PREVIEW_LINES ? `stderr (${total} lines):` : `stderr (first ${MAX_PREVIEW_LINES} of ${total} lines):`;
    diagnostics.push({ severity: 'warning', message: label + '\n' + preview.map(l => '  ' + l).join('\n') });
  }

  // Warnings for truncated/timed-out commands
  const warnings = [];
  if (data.stdout_truncated) {
    warnings.push(`stdout was truncated at ${data.stdout_bytes || '?'} bytes. Use structuredContent for full output.`);
  }
  if (data.stderr_truncated) {
    warnings.push(`stderr was truncated at ${data.stderr_bytes || '?'} bytes. Use structuredContent for full output.`);
  }
  if (data.timed_out) {
    warnings.push('Command timed out. Increase timeout or optimise the command.');
  }

  return formatToolCard('Shell Exec', { lines, diagnostics, warnings });
}


// ---------------------------------------------------------------------------
// git_remote_diff card
// ---------------------------------------------------------------------------

/**
 * Format git_remote_diff structured data as a compact summary.
 * Shows base/head/path/bytes/truncated status and a truncated diff preview.
 *
 * @param {object} data - The structuredContent from git_remote_diff
 * @returns {string}
 */
export function gitRemoteDiffCard(data) {
  if (!data || data.ok === false) {
    const errMsg = data?.error || 'No diff data';
    return formatToolCard('Git Diff', { lines: [`  ${errMsg}`] });
  }

  const lines = [
    formatKeyValue('base', data.base || '?'),
    formatKeyValue('head', data.head || '?'),
    formatKeyValue('path', data.path || '(entire repo)'),
    formatKeyValue('bytes', data.bytes || 0),
    formatKeyValue('truncated', data.truncated ? 'yes' : 'no'),
  ];

  // Diff content preview (first 20 lines)
  const MAX_PREVIEW_LINES = 20;
  const diagnostics = [];

  if (data.diff) {
    const diffLines = data.diff.split('\n');
    const preview = diffLines.slice(0, MAX_PREVIEW_LINES);
    const total = diffLines.length;
    const label = total <= MAX_PREVIEW_LINES
      ? `diff (${total} lines):`
      : `diff (first ${MAX_PREVIEW_LINES} of ${total} lines, ${data.bytes || 0} bytes):`;
    diagnostics.push({ severity: 'info', message: label + '\n' + preview.map(l => '  ' + l).join('\n') });
  }

  const warnings = [];
  if (data.truncated) {
    warnings.push('Diff was truncated. Use git_remote_diff with larger max_bytes or access structuredContent for full diff.');
  }

  return formatToolCard('Git Diff', { lines, diagnostics, warnings });
}


// ---------------------------------------------------------------------------
// read_text_file card
// ---------------------------------------------------------------------------

/**
 * Format read_text_file structured data as a compact summary.
 * If truncated, clearly shows truncated/size/max_bytes.
 *
 * @param {object} data - The structuredContent from read_text_file
 * @returns {string}
 */
export function readTextFileCard(data) {
  if (!data) return formatToolCard('Read File', { lines: ['  No data'] });

  const lines = [
    formatKeyValue('path', data.path || '-'),
    formatKeyValue('size', data.size != null ? `${data.size} bytes` : '-'),
    formatKeyValue('truncated', data.truncated ? 'yes' : 'no'),
  ];

  // Show first N lines of content
  const MAX_PREVIEW_LINES = 20;
  const warnings = [];
  const diagnostics = [];

  if (data.content) {
    const contentLines = data.content.split('\n');
    const preview = contentLines.slice(0, MAX_PREVIEW_LINES);
    const total = contentLines.length;
    const label = total <= MAX_PREVIEW_LINES
      ? `content (${total} lines):`
      : `content (first ${MAX_PREVIEW_LINES} of ${total} lines):`;
    diagnostics.push({ severity: 'info', message: label + '\n' + preview.map(l => '  ' + l).join('\n') });
  }

  if (data.truncated) {
    warnings.push(`File was truncated: ${data.size || '?'} bytes total, showing ${data.content ? Buffer.byteLength(data.content, 'utf8') : '?'} bytes. Use larger max_bytes or access structuredContent for full content.`);
  }

  return formatToolCard('Read File', { lines, diagnostics, warnings });
}


// ---------------------------------------------------------------------------
// list_dir card
// ---------------------------------------------------------------------------

/**
 * Format list_dir structured data as a compact summary.
 * Shows count/limit/truncated status and the first few items.
 *
 * @param {object} data - The structuredContent from list_dir
 * @returns {string}
 */
export function listDirCard(data) {
  if (!data) return formatToolCard('List Dir', { lines: ['  No data'] });

  const count = data.count || 0;
  const limit = data.limit || 0;
  const truncated = count >= limit && limit > 0;

  const lines = [
    formatKeyValue('path', data.path || '-'),
    formatKeyValue('recursive', data.recursive ? 'yes' : 'no'),
    formatKeyValue('count', count),
    formatKeyValue('limit', limit),
    formatKeyValue('truncated', truncated ? 'yes' : 'no'),
  ];

  // Show first few items
  const MAX_ITEMS = 10;
  const items = (data.items || []).slice(0, MAX_ITEMS);
  if (items.length > 0) {
    lines.push('');
    lines.push(`  items (first ${Math.min(items.length, count)} of ${count}):`);
    for (const item of items) {
      const type = item.type === 'directory' ? '[DIR]' : '     ';
      lines.push(`    ${type} ${item.name}`);
    }
    if (count > MAX_ITEMS) {
      lines.push(`    ... and ${count - MAX_ITEMS} more`);
    }
  }

  const warnings = [];
  if (truncated) {
    warnings.push(`Directory listing truncated at ${limit} items. Use a more specific path or increase limit for full listing.`);
  }

  return formatToolCard('List Dir', { lines, warnings });
}


// ---------------------------------------------------------------------------
// get_goal_context card
// ---------------------------------------------------------------------------

/**
 * Format get_goal_context structured data as a compact summary.
 * Shows goal id/task id/title/status, message count, memory count,
 * and context size — without dumping the full transcript.
 *
 * @param {object} data - The structuredContent from get_goal_context
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
