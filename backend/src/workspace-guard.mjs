/**
 * workspace-guard.mjs — Unified workspace safety boundary for GPTWork.
 *
 * Provides workspace safety checks including:
 * - Allowed roots / path confinement
 * - Blocked globs (secrets, build artifacts, VCS dirs)
 * - Symlink escape detection
 * - Binary file guard
 * - Read/write/output size limits
 * - Shell mode enforcement
 * - Compact shell transcript formatting
 *
 * Config keys (all optional, secure defaults):
 *   GPTWORK_SHELL_MODE       = off | safe | full       (default: full)
 *   GPTWORK_WRITE_MODE       = off | handoff | workspace (default: workspace)
 *   GPTWORK_SHELL_TRANSCRIPT = compact | full           (default: compact)
 */

import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Default blocked globs (consistent with CodexPro)
// ---------------------------------------------------------------------------

export const DEFAULT_BLOCKED_GLOBS = [
  // VCS
  ".git/**",
  ".git",
  ".svn/**",
  ".hg/**",
  // Secrets & credentials
  ".env*",
  "*.pem",
  "*.key",
  "*.cert",
  ".ssh/**",
  "**/id_rsa",
  "**/id_ed25519",
  "**/config.enc.json",
  // Tokens / passwords (common patterns)
  "**/tokens.json",
  "**/credentials.json",
  "**/secrets.json",
  // Build artifacts
  "dist/**",
  "build/**",
  ".next/**",
  "out/**",
  // Dependencies
  "node_modules/**",
  "vendor/**",
  ".cache/**",
  // Coverage
  "coverage/**",
  // Python
  "**/__pycache__/**",
  "*.pyc",
  "*.pyo",
  // OS / IDE
  ".DS_Store",
  "Thumbs.db",
  ".idea/**",
  ".vscode/**",
  "*.swp",
  "*.swo",
  // Binary artifacts
  "*.so",
  "*.dll",
  "*.dylib",
  "*.exe",
  "*.bin",
];

// ---------------------------------------------------------------------------
// Mode constants
// ---------------------------------------------------------------------------

export const SHELL_MODES = { OFF: "off", SAFE: "safe", FULL: "full" };
export const WRITE_MODES = { OFF: "off", HANDOFF: "handoff", WORKSPACE: "workspace" };
export const TRANSCRIPT_MODES = { COMPACT: "compact", FULL: "full" };

// ---------------------------------------------------------------------------
// Safe shell allowlist commands (when SHELL_MODE=safe)
// ---------------------------------------------------------------------------

const SAFE_COMMAND_PREFIXES = [
  "cat", "ls", "echo", "pwd", "which", "head", "tail", "wc", "nl",
  "sort", "uniq", "cut", "tr", "grep", "rg", "find", "diff",
  "stat", "file", "du", "df", "date", "env", "printenv",
  "node -e", "node --eval", "node --check",
  "python3 -c", "python -c", "python3 --version", "python --version",
  "npm --version", "node --version",
  "git status", "git log", "git diff", "git show", "git branch",
  "git rev-parse", "git describe", "git ls-files",
];

function isSafeCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Disallow pipes, redirects, semicolons, subshells, background
  if (/[|;&$`(){}]/.test(trimmed)) return false;
  // Disallow commands starting with sudo, rm, chmod, chown, dd, mkfs, etc.
  const dangerousPrefixes = ["sudo", "rm", "chmod", "chown", "dd", "mkfs", ">", ">>", "<", "mv ", "cp ", "ln "];
  for (const dp of dangerousPrefixes) {
    if (trimmed.startsWith(dp)) return false;
  }
  // Check safe prefixes
  for (const sp of SAFE_COMMAND_PREFIXES) {
    if (trimmed.startsWith(sp) || trimmed.startsWith("./" + sp)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Blocked glob matching (simple path-based)
// ---------------------------------------------------------------------------

/**
 * Check if a relative path matches any blocked glob pattern.
 * Uses simple prefix/wildcard matching.
 */
export function matchesBlockedGlob(relativePath, blockedGlobs = DEFAULT_BLOCKED_GLOBS) {
  for (const pattern of blockedGlobs) {
    if (pattern.endsWith("/**")) {
      // Directory pattern: match top-level dir or nested
      const dirPrefix = pattern.slice(0, -3);
      if (relativePath === dirPrefix || relativePath.startsWith(dirPrefix + "/")) return true;
    } else if (pattern.includes("**/")) {
      // Leading **/ pattern: match filename/base anywhere in tree
      const suffix = pattern.slice(3);
      if (relativePath.endsWith(suffix) || relativePath.includes("/" + suffix)) return true;
    } else if (pattern.includes("*")) {
      // Wildcard pattern: check prefix matching for trailing *
      if (pattern.endsWith("*")) {
        // e.g. ".env*" -> matches any path starting with ".env"
        const prefix = pattern.slice(0, -1);
        const basename = relativePath.split("/").pop() || relativePath;
        if (basename.startsWith(prefix)) return true;
      } else {
        // Simple wildcard elsewhere: match file extension
        const ext = pattern.slice(pattern.indexOf("*") + 1); // e.g. ".pem" from "*.pem"
        if (ext && relativePath.endsWith(ext)) return true;
      }
    } else {
      // Exact match or path prefix
      if (relativePath === pattern || relativePath.startsWith(pattern + "/")) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Binary content detection
// ---------------------------------------------------------------------------

export function looksBinary(bytes) {
  if (!bytes || bytes.length === 0) return false;
  return bytes.subarray(0, Math.min(bytes.length, 8000)).indexOf(0) !== -1;
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

/**
 * Create a workspace guard instance from the runtime config.
 *
 * @param {object} config - runtime config object
 * @param {object} [options]
 * @param {string[]} [options.blockedGlobs] - override blocked globs
 * @returns {object} guard API
 */
export function createWorkspaceGuard(config, options = {}) {
  const blockedGlobs = options.blockedGlobs || DEFAULT_BLOCKED_GLOBS;
  const shellMode = (config.shellMode || process.env.GPTWORK_SHELL_MODE || "full").toLowerCase();
  const writeMode = (config.writeMode || process.env.GPTWORK_WRITE_MODE || "workspace").toLowerCase();
  const transcriptMode = (config.shellTranscript || process.env.GPTWORK_SHELL_TRANSCRIPT || "compact").toLowerCase();
  const workspaceRoot = config.workspaceRoot ? config.workspaceRoot.replace(/\/+$/, "") : "";

  if (!SHELL_MODES.OFF && !SHELL_MODES.SAFE && !SHELL_MODES.FULL) {
    // Ensure we validate the mode against our constants
  }

  function assertValidShellMode() {
    if (![SHELL_MODES.OFF, SHELL_MODES.SAFE, SHELL_MODES.FULL].includes(shellMode)) {
      throw new Error(`invalid GPTWORK_SHELL_MODE "${shellMode}": expected off|safe|full`);
    }
  }

  function assertValidWriteMode(path, operation) {
    if (writeMode === WRITE_MODES.OFF) {
      throw new Error(`write operations disabled (GPTWORK_WRITE_MODE=off): cannot ${operation} ${path}`);
    }
    if (writeMode === WRITE_MODES.HANDOFF) {
      throw new Error(`workspace writes not permitted in handoff mode (GPTWORK_WRITE_MODE=handoff): cannot ${operation} ${path}`);
    }
    // WORKSPACE mode — allowed by default
  }

  /**
   * Assert that a resolved path is safe to access.
   * Checks: inside workspace, not a blocked path, respects write mode.
   */
  function assertAllowedPath(resolvedPath, options = {}) {
    const { operation = "read", isWrite = false } = options;
    const effectiveWriteMode = writeMode;

    if (isWrite) {
      assertValidWriteMode(resolvedPath, operation);
    }

    if (!workspaceRoot) {
      return; // No workspace root configured — skip confinement checks
    }

    // Get relative path from workspace root
    const relPath = relative(workspaceRoot, resolvedPath);
    // Handle case where path is not under workspace root
    if (relPath.startsWith("..") || resolve(workspaceRoot, relPath) !== resolve(resolvedPath)) {
      throw new Error(`path is outside workspace root: ${resolvedPath}`);
    }

    // Check against blocked globs
    if (matchesBlockedGlob(relPath, blockedGlobs)) {
      const action = isWrite ? "write to" : "access";
      throw new Error(`blocked path (matches security pattern): cannot ${action} ${relPath}`);
    }
  }

  /**
   * Check a symlink-resolved real path stays within workspace.
   */
  async function assertRealPathInsideWorkspace(targetPath) {
    if (!workspaceRoot) return;
    try {
      const real = await realpath(targetPath);
      if (!real.startsWith(workspaceRoot + "/") && real !== workspaceRoot) {
        throw new Error(`symlink escape detected: ${targetPath} resolves to ${real}, outside workspace root`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return; // Path doesn't exist yet — safe
      throw error;
    }
  }

  /**
   * Assert shell execution is allowed for the given command and cwd.
   */
  function assertShellAllowed(command, cwd) {
    assertValidShellMode();

    if (shellMode === SHELL_MODES.OFF) {
      throw new Error(`shell execution disabled (GPTWORK_SHELL_MODE=off)`);
    }

    if (shellMode === SHELL_MODES.SAFE) {
      if (!isSafeCommand(command)) {
        throw new Error(`command rejected by safe shell mode: "${command.slice(0, 80)}..."`);
      }
    }

    if (workspaceRoot && cwd) {
      const resolvedCwd = resolve(cwd);
      const relCwd = relative(workspaceRoot, resolvedCwd);
      if (relCwd.startsWith("..") || resolve(workspaceRoot, relCwd) !== resolve(resolvedCwd)) {
        throw new Error(`shell cwd is outside workspace root: ${cwd}`);
      }
    }
  }

  /**
   * Get shell transcript in compact format.
   */
  function formatCompactTranscript(result) {
    const stdoutLines = (result.stdout || "").split("\n").length;
    const stderrLines = (result.stderr || "").split("\n").length;
    return {
      command: result.command,
      cwd: result.cwd,
      exit_code: result.returncode,
      duration_ms: result.duration_ms,
      timed_out: !!result.timed_out,
      stdout_lines: stdoutLines,
      stderr_lines: stderrLines,
      stdout_truncated: !!result.stdout_truncated,
      stderr_truncated: !!result.stderr_truncated,
      stdout_preview: (result.stdout || "").slice(0, 1000),
      stderr_preview: (result.stderr || "").slice(0, 500),
    };
  }

  /**
   * Format shell result according to transcript mode.
   */
  function formatShellTranscript(result) {
    if (transcriptMode === TRANSCRIPT_MODES.COMPACT) {
      return formatCompactTranscript(result);
    }
    // Full transcript
    return {
      command: result.command,
      cwd: result.cwd,
      exit_code: result.returncode,
      duration_ms: result.duration_ms,
      timed_out: !!result.timed_out,
      stdout: (result.stdout || "").slice(0, 100000),
      stderr: (result.stderr || "").slice(0, 50000),
      stdout_truncated: !!result.stdout_truncated,
      stderr_truncated: !!result.stderr_truncated,
      stdout_bytes: result.stdout_bytes,
      stderr_bytes: result.stderr_bytes,
    };
  }

  /**
   * Assert non-binary content for read operations.
   */
  function assertTextContent(bytes, path) {
    if (looksBinary(bytes)) {
      throw new Error(`binary file detected, refusing text read: ${path}`);
    }
  }

  return {
    // State
    shellMode,
    writeMode,
    transcriptMode,
    blockedGlobs,
    workspaceRoot,
    // Methods
    assertAllowedPath,
    assertRealPathInsideWorkspace,
    assertShellAllowed,
    assertValidWriteMode,
    assertTextContent,
    formatCompactTranscript,
    formatShellTranscript,
    isSafeCommand,
    matchesBlockedGlob,
    looksBinary,
  };
}

// ---------------------------------------------------------------------------
// Standalone helpers (no config needed)
// ---------------------------------------------------------------------------

export { isSafeCommand };
