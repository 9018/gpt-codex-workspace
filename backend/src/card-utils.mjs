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
