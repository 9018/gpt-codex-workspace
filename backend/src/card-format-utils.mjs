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
