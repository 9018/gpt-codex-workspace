import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";

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
