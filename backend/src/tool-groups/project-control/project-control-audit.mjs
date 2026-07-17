/**
 * project-control-audit.mjs — Audit log for project control operations.
 *
 * @module project-control-audit
 */

/**
 * Create audit tools.
 *
 * @param {object} deps
 * @returns {object[]} Tool definitions
 */
export function createProjectControlAuditTools(deps) {
  const auditLog = [];

  return [
    {
      name: "project_audit_log",
      description: "Show the audit log of project control operations during this ChatGPT takeover session.",
      handler: async ({ limit = 50 } = {}) => {
        const entries = auditLog.slice(-Math.min(limit, 200));
        return { ok: true, entries, count: entries.length };
      },
    },
    {
      name: "project_audit_record",
      description: "(internal) Record an audit entry. Not exposed as a user-facing tool.",
      internal: true,
      handler: async ({ action, details } = {}) => {
        auditLog.push({ action, details, at: new Date().toISOString() });
        return { ok: true };
      },
    },
  ];
}
