/**
 * legacy-state-migration.mjs — Safe migration tooling for legacy raw task states.
 *
 * Scans task records and classifies raw waiting_for_review, waiting_for_repair,
 * and failed records based on current-blocker-policy decisions. Default mode is
 * dry-run/report-only. Apply mode requires explicit --apply flag.
 *
 * Canonical resolved-legacy metadata fields:
 *   result.resolved_legacy          = true
 *   result.resolved_legacy_reason   = string
 *   result.previous_status          = prior task status
 *   result.resolved_at              = ISO timestamp
 *   result.resolution_policy_label  = policy decision label
 *
 * Usage as script:
 *   node backend/src/legacy-state-migration.mjs <state.json> [--apply]
 */

import { classifyCurrentBlockerTask } from './current-blocker-policy.mjs';
import { TASK_STATUSES } from './task-status-taxonomy.mjs';

// ---------------------------------------------------------------------------
// Classification constants
// ---------------------------------------------------------------------------

const LEGACY_SCAN_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.FAILED,
]));

const ACTIVE_PROTECTED_STATUSES = Object.freeze(new Set([
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.QUEUED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.WAITING_FOR_LOCK,
]));

export const MIGRATION_CLASSIFICATIONS = Object.freeze({
  RAW_LEGACY_RESOLVED: 'raw_legacy_resolved',
  RAW_UNRESOLVED: 'raw_unresolved',
  POLICY_EXCLUDED: 'policy_excluded',
  ACTIVE_CURRENT_BLOCKER: 'active_current_blocker',
  ALREADY_RESOLVED: 'already_resolved',
});

export const LEGACY_RESOLUTION_LABELS = Object.freeze({
  REVIEW_NO_ACTIONABLE: 'review_no_actionable',
  REPAIR_VERIFIED: 'repair_verified',
  PROVIDER_EMPTY_FAILURE: 'provider_empty_failure',
  RESOLVED_BY_OPTIONS: 'resolved_by_options',
  COMPLETED_NO_BLOCKER: 'completed_no_blocker',
});

// ---------------------------------------------------------------------------
// Real-blocker patterns that must never be migrated
// ---------------------------------------------------------------------------

const REAL_BLOCKER_PATTERNS = Object.freeze([
  { key: 'code_evidence_failure', check: (d) => d.label === 'code_evidence_failure' },
  { key: 'verification_failed', check: (d) => d.label === 'failure_evidence' },
  { key: 'active_dependency_blocker', check: (d) => d.label === 'integration' },
  { key: 'active_execution', check: (d) => d.label === 'active' },
]);

// ---------------------------------------------------------------------------
// Scanning and classification
// ---------------------------------------------------------------------------

/**
 * Scan task records and classify for legacy migration eligibility.
 *
 * @param {object[]} tasks - Array of task objects.
 * @param {object} [options]
 * @param {boolean} [options.includeAlreadyResolved=false] - Include already-resolved in scan.
 * @returns {{
 *   rawLegacyResolved: Array<{task: object, decision: object}>,
 *   rawUnresolved: object[],
 *   policyExcluded: object[],
 *   activeCurrentBlockers: object[],
 *   alreadyResolved: object[]
 * }}
 */
export function scanAndClassifyTasks(tasks, options = {}) {
  const { includeAlreadyResolved = false } = options;

  const result = {
    rawLegacyResolved: [],
    rawUnresolved: [],
    policyExcluded: [],
    activeCurrentBlockers: [],
    alreadyResolved: [],
  };

  if (!Array.isArray(tasks)) return result;

  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;

    const status = (task.status || '').trim().toLowerCase();

    // Track already resolved tasks separately
    if (task.result?.resolved_legacy === true) {
      result.alreadyResolved.push(task);
      if (!includeAlreadyResolved) continue;
    }

    // Active tasks are always protected from migration
    if (ACTIVE_PROTECTED_STATUSES.has(status)) {
      result.activeCurrentBlockers.push(task);
      continue;
    }

    // Only target legacy statuses for classification
    if (!LEGACY_SCAN_STATUSES.has(status)) {
      result.policyExcluded.push(task);
      continue;
    }

    // Classify via the production current-blocker policy engine
    let decision;
    try {
      decision = classifyCurrentBlockerTask(task);
    } catch {
      // Classification error: treat as unresolved for safety
      result.rawUnresolved.push(task);
      continue;
    }

    if (!decision || typeof decision !== 'object') {
      result.rawUnresolved.push(task);
      continue;
    }

    // Tasks that block current work have real blockers — never migrate
    if (decision.blocks_current_work === true) {
      result.rawUnresolved.push(task);
      continue;
    }

    // Verify that the non-blocking decision does not hide a real blocker pattern
    const hasHiddenBlocker = REAL_BLOCKER_PATTERNS.some((pattern) => pattern.check(decision));
    if (hasHiddenBlocker) {
      result.rawUnresolved.push(task);
      continue;
    }

    // Non-blocking legacy-status task — eligible for resolution
    result.rawLegacyResolved.push({ task, decision });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Migration plan
// ---------------------------------------------------------------------------

/**
 * Build a migration plan from scan results.
 * @param {object} scanResult - Result from scanAndClassifyTasks.
 * @returns {{ candidates: Array<{task: object, decision: object}>, stats: object }}
 */
export function buildMigrationPlan(scanResult) {
  const candidates = scanResult?.rawLegacyResolved || [];
  return {
    candidates,
    stats: {
      total: candidates.length,
      rawLegacyResolved: scanResult?.rawLegacyResolved?.length || 0,
      rawUnresolved: scanResult?.rawUnresolved?.length || 0,
      policyExcluded: scanResult?.policyExcluded?.length || 0,
      activeCurrentBlockers: scanResult?.activeCurrentBlockers?.length || 0,
      alreadyResolved: scanResult?.alreadyResolved?.length || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Single-task resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single legacy task with canonical metadata.
 *
 * Mutates the task object in place. Sets resolved_legacy=true on result,
 * records previous_status and policy metadata, then transitions task
 * status to 'completed' to archive it from the active queue.
 *
 * @param {object} task - Task object to mutate.
 * @param {object} decision - Policy decision from classifyCurrentBlockerTask.
 * @param {string} [reason] - Human-readable reason for resolution.
 * @returns {object} The mutated task.
 */
export function resolveLegacyTask(task, decision, reason) {
  if (!task || typeof task !== 'object') return task;

  const now = new Date().toISOString();
  const defaultReason = 'Legacy task with non-blocking policy decision';
  const policyLabel = decision?.label || 'unknown';

  // Ensure result object exists
  if (!task.result || typeof task.result !== 'object') {
    task.result = {};
  }

  // Set canonical resolved-legacy metadata
  task.result = {
    ...task.result,
    resolved_legacy: true,
    resolved_legacy_reason: reason || defaultReason,
    previous_status: task.status,
    resolved_at: now,
    resolution_policy_label: policyLabel,
  };

  // Transition to completed to archive from the active queue.
  // The previous_status field preserves the original status.
  task.status = 'completed';

  return task;
}

// ---------------------------------------------------------------------------
// Apply migration plan
// ---------------------------------------------------------------------------

/**
 * Apply a migration plan to state tasks.
 *
 * Creates an in-memory deep-copy backup before mutating. Only performs
 * mutation when the `apply` option is explicitly true.
 *
 * @param {object} plan - Migration plan from buildMigrationPlan.
 * @param {object} [options]
 * @param {boolean} [options.apply=false] - Must be true to perform mutation.
 * @param {boolean} [options.createBackup=true] - Snapshot backup before mutation.
 * @returns {{ mutated: number, backup: object|null, errors: string[] }}
 */
export function applyMigrationPlan(plan, options = {}) {
  const { apply = false, createBackup = true } = options;
  const errors = [];

  if (!apply) {
    return {
      mutated: 0,
      backup: null,
      errors: ['apply flag not set — no mutations performed'],
    };
  }

  let backup = null;
  const candidates = plan?.candidates || [];

  for (const entry of candidates) {
    const { task, decision } = entry;
    if (!task) continue;

    try {
      // Create a deep-copy snapshot before the first mutation
      if (createBackup && backup === null) {
        backup = JSON.parse(JSON.stringify(task));
      }

      resolveLegacyTask(task, decision);
    } catch (err) {
      errors.push(`Failed to resolve task ${task.id || 'unknown'}: ${err.message}`);
    }
  }

  return {
    mutated: candidates.length - errors.length,
    backup,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic report
// ---------------------------------------------------------------------------

/**
 * Generate a formatted diagnostic report from scan results.
 *
 * Distinguishes: raw legacy resolved, raw unresolved, policy excluded,
 * active current blockers, and already resolved.
 *
 * @param {object} scanResult - Result from scanAndClassifyTasks.
 * @returns {string} Formatted report.
 */
export function formatReport(scanResult) {
  const lines = [];
  lines.push('=== Legacy State Migration Report ===');
  lines.push('');
  lines.push(`Raw Legacy Resolved (eligible):    ${scanResult?.rawLegacyResolved?.length || 0}`);
  lines.push(`Raw Unresolved (blockers remain):   ${scanResult?.rawUnresolved?.length || 0}`);
  lines.push(`Policy Excluded:                    ${scanResult?.policyExcluded?.length || 0}`);
  lines.push(`Active Current Blockers:             ${scanResult?.activeCurrentBlockers?.length || 0}`);
  lines.push(`Already Resolved:                    ${scanResult?.alreadyResolved?.length || 0}`);
  lines.push('');

  // Detail: raw legacy resolved (eligible for migration)
  const resolved = scanResult?.rawLegacyResolved || [];
  if (resolved.length > 0) {
    lines.push('--- Raw Legacy Resolved (eligible for migration) ---');
    for (const entry of resolved) {
      const t = entry.task || entry;
      const d = entry.decision || {};
      lines.push(`  [${t.id || 'unknown'}] status=${t.status} policy=${d.label}`);
    }
    lines.push('');
  }

  // Detail: raw unresolved (real blockers remain)
  const unresolved = scanResult?.rawUnresolved || [];
  if (unresolved.length > 0) {
    lines.push('--- Raw Unresolved (blockers remain — not eligible) ---');
    for (const t of unresolved) {
      lines.push(`  [${t.id || 'unknown'}] status=${t.status}`);
    }
    lines.push('');
  }

  // Detail: active current blockers
  const blockers = scanResult?.activeCurrentBlockers || [];
  if (blockers.length > 0) {
    lines.push('--- Active Current Blockers (protected from migration) ---');
    for (const t of blockers) {
      lines.push(`  [${t.id || 'unknown'}] status=${t.status}`);
    }
    lines.push('');
  }

  // Detail: policy excluded
  const excluded = scanResult?.policyExcluded || [];
  if (excluded.length > 0) {
    lines.push('--- Policy Excluded (not a legacy status) ---');
    for (const t of excluded) {
      lines.push(`  [${t.id || 'unknown'}] status=${t.status}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const statePath = args.find((a) => !a.startsWith('--'));
  const isApply = args.includes('--apply');
  const noBackup = args.includes('--no-backup');

  if (!statePath) {
    console.error('Usage: node backend/src/legacy-state-migration.mjs <state.json> [--apply] [--no-backup]');
    process.exit(1);
  }

  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    const tasks = raw.tasks || [];

    console.log(`Loaded ${tasks.length} tasks from ${statePath}`);

    const scanResult = scanAndClassifyTasks(tasks);
    const report = formatReport(scanResult);
    console.log(report);

    if (isApply) {
      console.log('--- Apply Mode ---');
      const plan = buildMigrationPlan(scanResult);
      const result = applyMigrationPlan(plan, { apply: true, createBackup: !noBackup });
      console.log(`Mutated: ${result.mutated} tasks`);
      if (result.backup) {
        console.log('Backup snapshot created for first mutated task (in-memory)');
      }
      if (result.errors.length > 0) {
        console.error('Errors:', result.errors.join('; '));
      }
    } else {
      console.log('');
      console.log('Dry-run mode (use --apply to perform migration)');
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

// Run as CLI only when invoked directly
const isMainScript =
  process.argv[1] &&
  (process.argv[1].endsWith('legacy-state-migration.mjs') ||
    process.argv[1].endsWith('legacy-state-migration'));

if (isMainScript) {
  main();
}
