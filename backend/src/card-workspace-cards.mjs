import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";

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
