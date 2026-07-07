/**
 * product-status-view.mjs — Product-level operator dashboard.
 *
 * Aggregates runtime_status, worker_status, queue metrics, review backlog,
 * retention pressure, and TUI diagnostics into a single compact status view.
 *
 * Distinguishes raw historical counts from current actionable blockers.
 *
 * Exports:
 *   collectProductStatus(services)   — gather all status data
 *   productStatusCard(data)          — format as text card
 *   formatProductStatus(data)        — format as structured plain-text summary
 */

import { formatToolCard, formatKeyValue, formatDiagnostics, formatNextActions } from "./card-format-utils.mjs";
import { TASK_STATUSES } from "./task-status-taxonomy.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_DISPLAY_STATUSES = [
  "assigned", "queued", "running", "completed", "failed",
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.WAITING_FOR_REVIEW,
];

const REVIEW_CATEGORIES = {
  HUMAN_REQUIRED: "human_required",
  MACHINE_REPAIRABLE: "machine_repairable",
  RESOLVED_HISTORY: "resolved_history",
  UNKNOWN: "unknown",
};

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/**
 * Collect git/runtime info from the cached diagnostics service.
 */
async function collectRuntimeGitInfo(services) {
  const { resolveRepoDir, collectRuntimeGitInfoCached } = await import("./diagnostics-service.mjs");
  const repoDir = resolveRepoDir();
  return collectRuntimeGitInfoCached(repoDir);
}

/**
 * Collect worker health snapshot.
 */
function collectWorkerHealth(services) {
  const { workerStatusExtendedSnapshot } = require_or_dynamic("./codex-worker-state.mjs");
  return workerStatusExtendedSnapshot(services.workerState);
}

/**
 * Parse queue data to distinguish raw counts from policy-filtered blockers.
 */
function parseQueueMetrics(queueCounts) {
  const raw = queueCounts.raw_counts || {};
  const policy = queueCounts.policy_counts || queueCounts;

  const rawBlockers = (raw[TASK_STATUSES.WAITING_FOR_LOCK] || 0)
    + (raw[TASK_STATUSES.WAITING_FOR_INTEGRATION] || 0)
    + (raw[TASK_STATUSES.WAITING_FOR_REPAIR] || 0)
    + (raw[TASK_STATUSES.WAITING_FOR_REVIEW] || 0)
    + (raw.failed || 0);

  const policyBlockers = (policy[TASK_STATUSES.WAITING_FOR_LOCK] || 0)
    + (policy[TASK_STATUSES.WAITING_FOR_INTEGRATION] || 0)
    + (policy[TASK_STATUSES.WAITING_FOR_REPAIR] || 0)
    + (policy[TASK_STATUSES.WAITING_FOR_REVIEW] || 0)
    + (policy.failed || 0);

  return {
    raw_counts: raw,
    policy_counts: policy,
    current_blockers: {
      raw: rawBlockers,
      policy_filtered: policyBlockers,
      policy_excluded: Math.max(0, rawBlockers - policyBlockers),
    },
    actionable_review: queueCounts.actionable_review ?? policy[TASK_STATUSES.WAITING_FOR_REVIEW] ?? 0,
    raw_legacy_resolved: queueCounts.raw_legacy_resolved ?? 0,
    raw_unresolved: queueCounts.raw_unresolved ?? 0,
  };
}

/**
 * Categorize review tasks: human-required, machine-repairable, resolved.
 */
function categorizeReviewQueue(tasks = []) {
  const categories = { [REVIEW_CATEGORIES.HUMAN_REQUIRED]: 0, [REVIEW_CATEGORIES.MACHINE_REPAIRABLE]: 0, [REVIEW_CATEGORIES.RESOLVED_HISTORY]: 0, [REVIEW_CATEGORIES.UNKNOWN]: 0 };
  for (const task of tasks) {
    if (!task) continue;
    const status = task.status || "";
    if (status === TASK_STATUSES.WAITING_FOR_REVIEW) {
      categories[REVIEW_CATEGORIES.HUMAN_REQUIRED]++;
    } else if (status === TASK_STATUSES.WAITING_FOR_REPAIR) {
      categories[REVIEW_CATEGORIES.MACHINE_REPAIRABLE]++;
    } else if (task.result?.resolved_legacy || task.result?.superseded_by_task_id) {
      categories[REVIEW_CATEGORIES.RESOLVED_HISTORY]++;
    } else {
      categories[REVIEW_CATEGORIES.UNKNOWN]++;
    }
  }
  return categories;
}

/**
 * Detect retention pressure from task/goal counts relative to limit.
 */
function retentionPressure(queueCounts, state) {
  const limit = Number(process.env.GPTWORK_RETENTION_LIMIT) || 50;
  const tasks = state.tasks?.length || 0;
  const goals = state.goals?.length || 0;

  let pressure = "none";
  let details = [];
  const overLimit = [];

  if (tasks > limit * 2) { pressure = "high"; overLimit.push(`tasks=${tasks}`); }
  else if (tasks > limit) { pressure = "medium"; overLimit.push(`tasks=${tasks}`); }

  if (goals > limit * 2) { pressure = "high" !== "none" ? pressure : "high"; overLimit.push(`goals=${goals}`); }
  else if (goals > limit) { pressure = pressure === "none" ? "medium" : pressure; overLimit.push(`goals=${goals}`); }

  if (overLimit.length > 0) {
    details = [`limit=${limit}, ` + overLimit.join(", ")];
  }

  return { pressure, limit, tasks, goals, details };
}

/**
 * Collect canonical outcome health from tasks with unified_decision.
 * P0-AFC8: Reports the distribution of canonical outcome decisions
 * and identifies tasks with degraded or missing canonical outcomes.
 */
function collectCanonicalOutcomeHealth(tasks = []) {
  const codexTasks = tasks.filter(t => t.assignee === 'codex');
  const withUnifiedDecision = codexTasks.filter(t => t.result?.unified_decision);
  const withoutUnifiedDecision = codexTasks.filter(t => !t.result?.unified_decision);

  const outcomeCounts = {};
  for (const t of withUnifiedDecision) {
    const s = t.result.unified_decision.status || 'unknown';
    outcomeCounts[s] = (outcomeCounts[s] || 0) + 1;
  }

  const degradedTasks = withUnifiedDecision.filter(t => {
    const ud = t.result.unified_decision;
    return ud.status === 'completed' && (ud.requires_review === true || ud.blocking_passed === false);
  }).length;

  const canonicalBlockers = withUnifiedDecision.filter(t => {
    const ud = t.result.unified_decision;
    return Array.isArray(ud.blockers) && ud.blockers.length > 0;
  }).length;

  return {
    tasks_with_unified_decision: withUnifiedDecision.length,
    tasks_without_unified_decision: withoutUnifiedDecision.length,
    canonical_outcome_counts: outcomeCounts,
    tasks_with_canonical_blockers: canonicalBlockers,
    tasks_degraded_outcome: degradedTasks,
    total_codex_tasks: codexTasks.length,
  };
}

/**
 * Collect context bundle health from tasks.
 * P0-AFC8: Reports context bundle health across goals/tasks,
 * identifying tasks with stalled, degraded, or healthy context bundles.
 */
export function collectContextBundleHealth(tasks = []) {
  const codexTasks = tasks.filter(t => t.assignee === 'codex');
  let healthy = 0;
  let degraded = 0;
  let stale = 0;

  for (const t of codexTasks) {
    const ud = t.result?.unified_decision;
    const verification = t.result?.verification;
    const resultStatus = t.result?.status;
    const missingEvidence = (t.result?.acceptance_findings || []).length;

    if (ud && verification && verification.passed !== null && resultStatus && missingEvidence === 0) {
      healthy++;
    } else if (ud && missingEvidence <= 1) {
      degraded++;
    } else {
      stale++;
    }
  }

  return { healthy, degraded, stale, total_codex_tasks: codexTasks.length };
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Collect all product-level status data.
 *
 * @param {object} services - Dependency injection bag:
 *   { store, config, workerState, collectWorkerQueueCounts, workerStatusExtendedSnapshot,
 *     activeCodexTasks, github, bark, registry, envLoadResult, processStartedAt, sources }
 * @returns {Promise<object>} Structured product status data
 */
export async function collectProductStatus(services) {
  const startTime = Date.now();
  const { store, config, workerState, collectWorkerQueueCounts, github, bark } = services;

  // 1. Git info
  const gitInfo = await collectRuntimeGitInfo(services);

  // 2. Queue counts
  const queueCounts = await collectWorkerQueueCounts(store);
  const queueMetrics = parseQueueMetrics(queueCounts);

  // 3. Worker health
  const { workerStatusExtendedSnapshot } = await import("./codex-worker-state.mjs");
  const workerHealth = workerStatusExtendedSnapshot(workerState);

  // 4. Review classification from state
  const state = await store.load();
  const codexTasks = (state.tasks || []).filter(t => t.assignee === "codex");
  const reviewCategories = categorizeReviewQueue(codexTasks);

  // 5. Retention pressure (with full diagnostic status)
  const retention = retentionPressure(queueCounts, state);
  let retentionFamilies = null;
  try {
    const { retentionStatus } = await import("./retention-service.mjs");
    const wsRoot = config.defaultWorkspaceRoot || config.workspaceRoot || ".";
    const retentionData = await retentionStatus({ config, store, workspaceRoot: wsRoot });
    if (retentionData && Array.isArray(retentionData.families)) {
      retentionFamilies = retentionData.families.map(f => ({
        name: f.name,
        type: f.type,
        current_count: f.current_count,
        active_count: f.active_count,
        terminal_count: f.terminal_count,
        bytes_h: f.bytes_h || "0 B",
        proposed_action: f.proposed_action || null,
        cleanup_safe: f.cleanup_safe,
      }));
    }
  } catch (e) {
    // Non-fatal: retention status unavailable
  }

  // 6. TUI diagnostics
  let tuiDiagnostics = null;
  try {
    const { collectCodexTuiRuntimeDiagnostics } = await import("./codex-tui-runtime-diagnostics.mjs");

  // 6b. Agent backend chain diagnostics (canonical source)
  let roleBackends = null;
  try {
    const { formatBackendChainSummary } = await import("./agent-execution-backends.mjs");
    roleBackends = formatBackendChainSummary(config);
  } catch { /* non-fatal */ }


    tuiDiagnostics = await collectCodexTuiRuntimeDiagnostics({ workspaceRoot: config.defaultWorkspaceRoot, store, config });
  } catch { /* non-fatal */ }

  // 7. Build next actions (prioritized)
  const nextActions = buildNextActions({
    gitInfo, queueMetrics, workerHealth, reviewCategories, retention, tuiDiagnostics,
    config, state,
  });

  // 8. Summary line
  const summary = buildSummaryLine({ gitInfo, queueMetrics, workerHealth, retention });
  const contextBundleHealth = collectContextBundleHealth(state.tasks || []);

  return {
    scanned_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startTime,
    summary,
    system: {
      pid: process.pid,
      started_at: services.processStartedAt?.toISOString?.() || null,
      running_commit: gitInfo.running_commit ? gitInfo.running_commit.slice(0, 12) : null,
      repo_head: gitInfo.repo_head,
      remote_head: gitInfo.remote_head,
      worktree_dirty: gitInfo.worktree_dirty,
      dirty_paths: gitInfo.dirty_paths || [],
      runtime_env_loaded: services.envLoadResult?.loadedPath !== null,
      restart_required: Boolean(gitInfo.running_commit && gitInfo.repo_head && gitInfo.running_commit !== gitInfo.repo_head),
      tool_mode: config.toolMode || "standard",
    },
    worker: {
      enabled: workerHealth.enabled,
      running: workerHealth.running,
      health_phase: workerHealth.health?.phase || "unknown",
      last_tick_age_s: workerHealth.health?.last_tick_age_ms != null ? Math.round(workerHealth.health.last_tick_age_ms / 1000) : null,
      last_error: workerHealth.last_error || null,
      concurrency: workerHealth.concurrency || null,
    },
    queue: {
      assigned: queueCounts.assigned ?? 0,
      queued: queueCounts.queued ?? 0,
      running: queueCounts.running ?? 0,
      completed: queueCounts.completed ?? 0,
      failed: queueCounts.failed ?? 0,
    },
    current_blockers: queueMetrics.current_blockers,
    review_classification: {
      categories: {
        human_required: reviewCategories[REVIEW_CATEGORIES.HUMAN_REQUIRED],
        machine_repairable: reviewCategories[REVIEW_CATEGORIES.MACHINE_REPAIRABLE],
        resolved_history: reviewCategories[REVIEW_CATEGORIES.RESOLVED_HISTORY],
      },
      total: reviewCategories[REVIEW_CATEGORIES.HUMAN_REQUIRED]
        + reviewCategories[REVIEW_CATEGORIES.MACHINE_REPAIRABLE]
        + reviewCategories[REVIEW_CATEGORIES.RESOLVED_HISTORY],
      actionable_review: queueMetrics.actionable_review,
    },
    raw_historical: {
      raw_legacy_resolved: queueMetrics.raw_legacy_resolved,
      raw_unresolved: queueMetrics.raw_unresolved,
      total_codex_tasks: state.tasks?.filter(t => t.assignee === "codex").length || 0,
      total_tasks: state.tasks?.length || 0,
      total_goals: state.goals?.length || 0,
    },
    retention,
    retention_families: retentionFamilies,
    canonical_outcome_health: collectCanonicalOutcomeHealth(state.tasks || []),
    context_bundle_health: contextBundleHealth,
    tui_provider: tuiDiagnostics ? {
      enabled: tuiDiagnostics.enabled,
      provider: tuiDiagnostics.provider,
      session_count: tuiDiagnostics.session_store?.session_count ?? 0,
      active_count: tuiDiagnostics.session_store?.active_count ?? 0,
      highest_severity: tuiDiagnostics.highest_severity || "ok",
      finding_count: tuiDiagnostics.finding_count || 0,
    } : null,
    config: {
      bark_enabled: bark?.isEnabled?.() || false,
      github_enabled: github?.enabled || false,
      agent_backend: config.agentBackend || "codex_exec",
      agent_role_backends: config.agentRoleBackends || {},
      worker_interval_ms: workerHealth.interval_ms || null,
    },
    next_actions: nextActions,
    role_backends: roleBackends,
    _diagnostics: {
      warnings: [
        ...(gitInfo.worktree_dirty ? [{ severity: "warning", message: `Dirty worktree (${(gitInfo.dirty_paths || []).length} files)`, code: "worktree_dirty" }] : []),
        ...(queueMetrics.current_blockers.policy_filtered > 0 ? [{ severity: "warning", message: `${queueMetrics.current_blockers.policy_filtered} current blocker(s)`, code: "current_blockers" }] : []),
        ...(retention.pressure !== "none" ? [{ severity: "info", message: `Retention pressure: ${retention.pressure}`, code: "retention_pressure" }] : []),
        ...(tuiDiagnostics?.findings || []).filter(f => f.severity === "warning").slice(0, 5),
        ...(contextBundleHealth.degraded > 0 || contextBundleHealth.stale > 0
          ? [{ severity: 'info', message: 'Context bundle health degraded - inspect context-health tools', code: 'context_bundle_health' }] : []),
        ...(workerHealth.health?.phase === "stalled" || workerHealth.health?.phase === "overdue" || workerHealth.health?.phase === "enabled_but_not_running"
          ? [{ severity: "warning", message: `Worker health: ${workerHealth.health.phase}${workerHealth.health.reason ? ` - ${workerHealth.health.reason}` : ""}`, code: "worker_health" }] : []),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Next-actions builder (prioritized by severity)
// ---------------------------------------------------------------------------

function buildNextActions({ gitInfo, queueMetrics, workerHealth, reviewCategories, retention, tuiDiagnostics, config, state }) {
  const actions = [];

  // Blocker-level
  if (gitInfo.worktree_dirty) actions.push({ action: "Commit or stash dirty worktree", priority: "blocker" });
  if (gitInfo.running_commit && gitInfo.repo_head && gitInfo.running_commit !== gitInfo.repo_head) {
    actions.push({ action: "Restart runtime to align running_commit with repo_head", priority: "blocker" });
  }
  if (workerHealth.health?.phase === "stalled" || workerHealth.health?.phase === "overdue" || workerHealth.health?.phase === "enabled_but_not_running") {
    actions.push({ action: `Check worker health: ${workerHealth.health.phase}`, priority: "blocker" });
  }

  // Warning-level
  if (queueMetrics.current_blockers.policy_filtered > 0) {
    const blockers = [];
    const p = queueMetrics.policy_counts;
    if (p[TASK_STATUSES.WAITING_FOR_REVIEW]) blockers.push(`${p[TASK_STATUSES.WAITING_FOR_REVIEW]} review`);
    if (p[TASK_STATUSES.WAITING_FOR_REPAIR]) blockers.push(`${p[TASK_STATUSES.WAITING_FOR_REPAIR]} repair`);
    if (p[TASK_STATUSES.WAITING_FOR_INTEGRATION]) blockers.push(`${p[TASK_STATUSES.WAITING_FOR_INTEGRATION]} integration`);
    if (p[TASK_STATUSES.WAITING_FOR_LOCK]) blockers.push(`${p[TASK_STATUSES.WAITING_FOR_LOCK]} lock`);
    if (p.failed) blockers.push(`${p.failed} failed`);
    actions.push({ action: `Resolve blockers: ${blockers.join(", ")}`, priority: "warning" });
  }
  if (reviewCategories[REVIEW_CATEGORIES.HUMAN_REQUIRED] > 0) {
    actions.push({ action: `${reviewCategories[REVIEW_CATEGORIES.HUMAN_REQUIRED]} task(s) need human review`, priority: "warning" });
  }
  if (reviewCategories[REVIEW_CATEGORIES.MACHINE_REPAIRABLE] > 0) {
    actions.push({ action: `${reviewCategories[REVIEW_CATEGORIES.MACHINE_REPAIRABLE]} task(s) need auto-repair`, priority: "warning" });
  }
  if (!workerHealth.enabled && (queueMetrics.raw_counts.assigned > 0 || queueMetrics.raw_counts.queued > 0)) {
    actions.push({ action: "Worker disabled but tasks queued — enable worker or process manually", priority: "warning" });
  }

  // Info-level
  if (retention.pressure !== "none") {
    actions.push({ action: `Retention pressure ${retention.pressure} — run retention_cleanup`, priority: "info" });
  }
  if (tuiDiagnostics && !tuiDiagnostics.enabled && tuiDiagnostics.session_store?.session_count > 0) {
    actions.push({ action: "TUI sessions exist but provider disabled — check config", priority: "info" });
  }
  if (queueMetrics.raw_legacy_resolved > 0) {
    actions.push({ action: `${queueMetrics.raw_legacy_resolved} legacy-resolved task(s) — run retention for cleanup`, priority: "info" });
  }
  if (queueMetrics.raw_unresolved > 0) {
    actions.push({ action: `${queueMetrics.raw_unresolved} unresolved task(s) to investigate`, priority: "info" });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummaryLine({ gitInfo, queueMetrics, workerHealth, retention }) {
  const parts = [];

  const worktreeStatus = gitInfo.worktree_dirty ? "dirty" : "clean";
  const workerStatus = workerHealth.enabled ? (workerHealth.running ? "running" : "enabled_but_not_running") : "disabled";
  const blockers = queueMetrics.current_blockers;

  parts.push(`commit ${gitInfo.running_commit ? gitInfo.running_commit.slice(0, 8) : "?"}`);
  parts.push(`worktree ${worktreeStatus}`);
  parts.push(`worker ${workerStatus}`);
  if (workerHealth.health?.phase && !["running", "enabled"].includes(workerHealth.health.phase)) {
    parts.push(`health:${workerHealth.health.phase}`);
  }
  parts.push(`blockers ${blockers.policy_filtered}/${blockers.raw}`);
  if (retention.pressure !== "none") parts.push(`retention:${retention.pressure}`);

  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Card formatter (text fallback for non-SDK consumers)
// ---------------------------------------------------------------------------

/**
 * Format product status data as a compact text card.
 *
 * @param {object} data   - Result from collectProductStatus
 * @returns {string}
 */
export function productStatusCard(data) {
  if (!data) return "  No product status data.";

  const lines = [];

  // ── System ──
  lines.push('');
  lines.push(' System:');
  lines.push(formatKeyValue('running commit', data.system.running_commit || '-'));
  lines.push(formatKeyValue('repo head', data.system.repo_head ? data.system.repo_head.slice(0, 12) : '-'));
  lines.push(formatKeyValue('remote head', data.system.remote_head ? data.system.remote_head.slice(0, 12) : '-'));
  lines.push(formatKeyValue('worktree', data.system.worktree_dirty ? 'dirty' : 'clean'));
  if (data.system.restart_required) lines.push(formatKeyValue('restart', 'required (commit mismatch)'));
  lines.push(formatKeyValue('runtime env', data.system.runtime_env_loaded ? 'loaded' : 'missing'));
  lines.push(formatKeyValue('tool mode', data.system.tool_mode));

  // ── Worker Health ──
  lines.push('');
  lines.push(' Worker:');
  lines.push(formatKeyValue('status', data.worker.enabled ? (data.worker.running ? 'running' : 'enabled_but_not_running') : 'disabled'));
  lines.push(formatKeyValue('health phase', data.worker.health_phase));
  if (data.worker.last_tick_age_s != null) lines.push(formatKeyValue('last tick', `${data.worker.last_tick_age_s}s ago`));
  if (data.worker.last_error) lines.push(formatKeyValue('last error', data.worker.last_error.slice(0, 80)));

  // ── Queue Progress ──
  lines.push('');
  lines.push(' Queue:');
  for (const status of QUEUE_DISPLAY_STATUSES) {
    const v = data.queue[status];
    if (v !== undefined) {
      lines.push(formatKeyValue(status, v));
    }
  }

  // ── Current Blockers (distinguished from raw) ──
  lines.push('');
  lines.push(' Current Blockers:');
  const cb = data.current_blockers;
  lines.push(formatKeyValue('raw total (all non-terminal)', cb.raw));
  lines.push(formatKeyValue('policy-filtered (actionable)', cb.policy_filtered));
  lines.push(formatKeyValue('excluded by policy', cb.policy_excluded));
  lines.push(formatKeyValue('actionable review', data.review_classification.actionable_review));

  // ── Canonical Outcome Health (P0-AFC8) ──
  if (data.canonical_outcome_health) {
    lines.push('');
    lines.push(' Canonical Outcome:');
    const och = data.canonical_outcome_health;
    lines.push(formatKeyValue('with unified decision', och.tasks_with_unified_decision));
    lines.push(formatKeyValue('without unified decision', och.tasks_without_unified_decision));
    if (och.tasks_with_canonical_blockers > 0) lines.push(formatKeyValue('with canonical blockers', och.tasks_with_canonical_blockers));
    if (och.tasks_degraded_outcome > 0) lines.push(formatKeyValue('degraded outcome', och.tasks_degraded_outcome));
  }

  // ── Context Bundle Health (P0-AFC8) ──
  if (data.context_bundle_health) {
    lines.push('');
    lines.push(' Context Bundle:');
    const cbh = data.context_bundle_health;
    lines.push(formatKeyValue('healthy', cbh.healthy));
    lines.push(formatKeyValue('degraded', cbh.degraded));
    lines.push(formatKeyValue('stale', cbh.stale));
  }

  // ── Review Classification ──
  lines.push('');
  lines.push(' Review:');
  const rc = data.review_classification.categories;
  lines.push(formatKeyValue('human required', rc.human_required));
  lines.push(formatKeyValue('machine repairable', rc.machine_repairable));
  lines.push(formatKeyValue('resolved history', rc.resolved_history));

  // ── Raw Historical (for context, not to be confused with current blockers) ──
  lines.push('');
  lines.push(' Raw Historical:');
  lines.push(formatKeyValue('legacy resolved', data.raw_historical.raw_legacy_resolved));
  lines.push(formatKeyValue('unresolved', data.raw_historical.raw_unresolved));
  lines.push(formatKeyValue('total codex tasks', data.raw_historical.total_codex_tasks));

  // ── Retention ──
  lines.push('');
  lines.push(' Retention:');
  lines.push(formatKeyValue('pressure', data.retention.pressure));
  lines.push(formatKeyValue('tasks', data.retention.tasks));
  lines.push(formatKeyValue('goals', data.retention.goals));
  lines.push(formatKeyValue('limit', data.retention.limit));
  if (data.retention.details.length > 0) lines.push(formatKeyValue('details', data.retention.details.join('; ')));
  if (data.retention_families && data.retention_families.length > 0) {
    // Show first few families
    const shown = data.retention_families.slice(0, 10);
    for (const f of shown) {
      const hint = f.terminal_count > 0 ? '(' + f.active_count + ' active, ' + f.terminal_count + ' term)' : '';
      lines.push(formatKeyValue('  ' + f.name, f.current_count + ' ' + hint + ' ' + f.bytes_h));
    }
    if (data.retention_families.length > 10) {
      lines.push(formatKeyValue('  ...', data.retention_families.length + ' total families'));
    }
  }

  // ── TUI Provider ──
  if (data.tui_provider) {
    lines.push('');
    lines.push(' TUI Provider:');
    lines.push(formatKeyValue('enabled', data.tui_provider.enabled ? 'yes' : 'no'));
    lines.push(formatKeyValue('sessions', data.tui_provider.session_count));
    lines.push(formatKeyValue('active', data.tui_provider.active_count));
    lines.push(formatKeyValue('findings', data.tui_provider.finding_count));
  }

  // ── Config Summary ──
  lines.push('');
  lines.push(' Config:');
  lines.push(formatKeyValue('bark', data.config.bark_enabled ? 'enabled' : 'disabled'));
  lines.push(formatKeyValue('github', data.config.github_enabled ? 'enabled' : 'disabled'));
  lines.push(formatKeyValue('agent backend', data.config.agent_backend));
  // Backend chain from canonical source (shows per-role product defaults vs overrides)
  if (data.role_backends && data.role_backends.text) {
    lines.push(formatKeyValue('backend chain', data.role_backends.text));
  } else {
    lines.push(formatKeyValue('all roles', 'codex_exec (product default)'));
  }

  // ── Diagnostics ──
  const diagnostics = data._diagnostics?.warnings || [];
  const diagBlock = diagnostics.length > 0 ? diagnostics : null;

  // ── Next Actions ──
  const nextActions = (data.next_actions || []).map(a => a.action);

  return formatToolCard('Product Status', { lines, diagnostics: diagBlock, nextActions });
}

// ---------------------------------------------------------------------------
// Dynamic import helper (avoids top-level import side effects)
// ---------------------------------------------------------------------------

async function require_or_dynamic(modulePath) {
  return import(modulePath);
}

export default { collectProductStatus, productStatusCard };
