/**
 * codex-tui-progress-utils.mjs — Meaningful progress detection for Codex TUI sessions.
 *
 * Distinguishes real work (command execution, file changes, result writes)
 * from noisy terminal output (spinners, ANSI redraws, empty lines).
 */

/**
 * Patterns that indicate NON-meaningful terminal output.
 * Spinner chars, ANSI escape sequences only, empty/whitespace-only.
 */
const NON_MEANINGFUL_PATTERNS = [
  // Pure spinner dots / line redraws with no text context
  /^\s*[-/|\\]\s*$/m,
  // ANSI-only sequences (color codes, cursor moves, clear sequences)
  /^\s*(\x1b\[[0-9;]*[a-zA-Z]|\x1b\][0-9;]*\x07|\x1b\\(?:\[[0-9;]*[a-zA-Z])?)+\s*$/,
  // Empty or whitespace-only lines
  /^\s*$/m,
  // Cherry-pick/progress dots (e.g. "....." or ".... done")
  /^\.{3,}\s*$/m,
  // Single-word spinner output (e.g. "Building..." / "Loading...")
  /^(Building|Loading|Processing|Working|Running|Waiting|Installing|Compiling)\.{0,3}\s*$/im,
  // Progress bar characters (██████)
  /^[\x1b\[\]0-9;]*[█▌▐░▒▓▀▄▌▐▔▁▂▃▄▅▆▇█▉▊▋▌▍▎▏\s]+$/,
];

/**
 * Detect whether a terminal output chunk represents meaningful progress.
 *
 * @param {string} chunk - Raw terminal output text
 * @returns {{ meaningful: boolean, reason?: string }}
 */
export function detectMeaningfulOutput(chunk) {
  if (!chunk || typeof chunk !== "string") {
    return { meaningful: false, reason: "empty_output" };
  }

  const text = chunk.trim();

  if (!text) {
    return { meaningful: false, reason: "whitespace_only" };
  }

  // Check non-meaningful patterns
  for (const pattern of NON_MEANINGFUL_PATTERNS) {
    if (pattern.test(text)) {
      return { meaningful: false, reason: "non_meaningful_pattern" };
    }
  }

  // Detect git/command output patterns — always meaningful
  if (
    text.startsWith("+") ||
    text.startsWith("-") ||
    text.startsWith("diff --git") ||
    text.startsWith("commit ") ||
    text.startsWith("Author:") ||
    text.startsWith("Date:") ||
    text.match(/^\d+ files? changed/i) ||
    text.match(/^\s*✓/) ||
    text.match(/^\s*✗/) ||
    text.match(/^\s*✔/) ||
    text.match(/^\s*✘/) ||
    text.match(/^\[main\s/) ||
    text.match(/result\.json/) ||
    text.match(/result\.md/) ||
    text.match(/tests passed/i) ||
    text.match(/all tests/i) ||
    text.match(/npm (test|run)/)
  ) {
    return { meaningful: true, reason: "git_or_command_output" };
  }

  // Shorter than 10 chars and has no newline — likely a spinner/title
  if (text.length < 10 && !text.includes("\n")) {
    return { meaningful: false, reason: "short_line_likely_spinner" };
  }

  // Contains at least one meaningful word — likely real output
  const meaningfulWords = [
    "changed", "added", "removed", "fixed", "updated",
    "error", "warning", "failed", "passed", "completed",
    "result", "commit", "branch", "merge", "test",
    "running", "verification", "acceptance", "integration",
  ];

  const lower = text.toLowerCase();
  for (const word of meaningfulWords) {
    if (lower.includes(word)) {
      return { meaningful: true, reason: `contains_meaningful_word:${word}` };
    }
  }

  // Lines with significant content (>40 chars, not ANSI-heavy)
  if (text.length > 40 && (text.match(/\x1b\[/g) || []).length < 5) {
    return { meaningful: true, reason: "long_content_line" };
  }

  // Default: likely noisy
  return { meaningful: false, reason: "default_noisy" };
}

/**
 * Convenience: check if a chunk is meaningful progress.
 */
export function isMeaningfulOutput(chunk) {
  return detectMeaningfulOutput(chunk).meaningful;
}
