/**
 * admin-audit-log.mjs — Emergency/recovery audit log for GPTWork
 *
 * Every recovery operation that mutates state or runs a command must
 * write an audit record to the configured audit log (.gptwork/admin-audit.jsonl).
 *
 * Audit fields:
 *   timestamp   - ISO timestamp
 *   tool        - tool name
 *   action      - what was done
 *   dry_run     - whether it was a dry run
 *   apply       - whether changes were actually applied
 *   path/cwd    - affected path or working directory
 *   result      - result status (ok/fail/skipped)
 *   elapsed_ms  - execution time in ms
 *   summary     - redacted output summary
 *   actor       - who performed the action
 *
 * No secret values are ever written to the audit log.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const REDACTED = "[REDACTED]";

// Known secret key patterns for redaction
const SECRET_KEY_PATTERNS = [
  /^.*_TOKEN$/i,
  /^.*_KEY$/i,
  /^.*_SECRET$/i,
  /^.*_PASSWORD$/i,
  /^.*_API_KEY$/i,
  /^.*_ACCESS_KEY$/i,
  /^.*_SECRET_KEY$/i,
  /^GITHUB_TOKEN$/i,
  /^BARK_KEY$/i,
];

// Known secret value patterns for redaction
const SECRET_VALUE_PATTERNS = [
  /github_pat_[a-zA-Z0-9_]+/g,
  /ghp_[a-zA-Z0-9]+/g,
  /gho_[a-zA-Z0-9]+/g,
  /ghu_[a-zA-Z0-9]+/g,
  /ghr_[a-zA-Z0-9]+/g,
  /sk-[a-zA-Z0-9]+/g,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /Authorization:\s*Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
];

/**
 * Deep-redact an object: replace known secret key values with [REDACTED].
 * Mutates the input object (shallow) for performance and returns it.
 */
function redactSecrets(obj) {
  if (!obj || typeof obj !== "object") return obj;
  for (const [key, val] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERNS.some(p => p.test(key))) {
      obj[key] = REDACTED;
    } else if (typeof val === "string") {
      let redacted = val;
      for (const pattern of SECRET_VALUE_PATTERNS) {
        redacted = redacted.replace(pattern, REDACTED);
      }
      obj[key] = redacted;
    }
  }
  return obj;
}

/**
 * Redact a string by replacing known secret patterns.
 */
function redactString(str) {
  if (!str) return str;
  let result = String(str);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Create an audit logger bound to a workspace root and log path.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} [options.logPath] - relative to workspaceRoot or absolute
 * @returns {object} audit logger API
 */
export function createAdminAuditLogger({ workspaceRoot, logPath }) {
  // Default path: .gptwork/admin-audit.jsonl
  const auditPath = resolveAuditPath(workspaceRoot, logPath || ".gptwork/admin-audit.jsonl");
  const auditDir = dirname(auditPath);

  /**
   * Append an audit record to the log.
   * Automatically redacts secrets from the record data.
   *
   * @param {object} record
   * @param {string} record.tool - tool name
   * @param {string} record.action - action taken
   * @param {boolean} [record.dry_run] - whether dry run
   * @param {boolean} [record.apply] - whether changes applied
   * @param {string} [record.path] - affected path
   * @param {string} [record.queue_id] - queue item id
   * @param {string} [record.lock_id] - lock id
   * @param {string} [record.task_id] - task id
   * @param {string} [record.result] - result status
   * @param {number} [record.elapsed_ms] - duration
   * @param {string} [record.summary] - redacted summary
   * @param {string} [record.actor] - actor
   * @returns {Promise<{ok: boolean, auditId: string}>}
   */
  async function appendRecord(record) {
    try {
      await mkdir(auditDir, { recursive: true });
      const auditId = `audit_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      const entry = {
        audit_id: auditId,
        timestamp: new Date().toISOString(),
        ...redactSecrets({ ...record }),
      };
      // Ensure summary is redacted
      if (entry.summary) {
        entry.summary = redactString(entry.summary);
      }
      await appendFile(auditPath, JSON.stringify(entry) + "\n", "utf8");
      return { ok: true, auditId };
    } catch (err) {
      // Audit log failure is non-fatal
      return { ok: false, error: err.message, auditId: null };
    }
  }

  /**
   * Read recent audit records.
   *
   * @param {number} [limit=100]
   * @returns {Promise<object[]>}
   */
  async function readRecent(limit = 100) {
    if (!existsSync(auditPath)) return [];
    try {
      const content = await readFile(auditPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      return lines.slice(-limit).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Get the audit log path.
   */
  function getPath() {
    return auditPath;
  }

  return { appendRecord, readRecent, getPath };
}

function resolveAuditPath(workspaceRoot, logPath) {
  if (!logPath) return join(workspaceRoot, ".gptwork/admin-audit.jsonl");
  if (logPath.startsWith("/")) return logPath;
  return join(workspaceRoot, logPath);
}

export { redactSecrets, redactString };
