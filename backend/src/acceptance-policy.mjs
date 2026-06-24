export const ACCEPTANCE_SEVERITIES = ['blocker', 'major', 'minor', 'followup'];

const BLOCKING_SEVERITIES = new Set(['blocker', 'major']);

function normalizeFinding(finding = {}) {
  const severity = ACCEPTANCE_SEVERITIES.includes(finding.severity) ? finding.severity : 'major';
  return {
    severity,
    code: typeof finding.code === 'string' && finding.code ? finding.code : 'acceptance_finding',
    message: typeof finding.message === 'string' ? finding.message : '',
    source: typeof finding.source === 'string' ? finding.source : 'acceptance_agent',
    evidence: finding.evidence || null,
  };
}

function priorityForSeverity(severity) {
  if (severity === 'blocker' || severity === 'major') return 'P0';
  if (severity === 'minor') return 'P1';
  return 'P2';
}

function taskFromFinding(finding) {
  return {
    priority: priorityForSeverity(finding.severity),
    title: `${finding.code}: ${finding.message || 'Resolve acceptance finding'}`.slice(0, 160),
    source: 'acceptance_agent',
    finding_code: finding.code,
    severity: finding.severity,
  };
}

export function evaluateAcceptance({ findings = [], needs_gpt_review = false, review_reason = null } = {}) {
  const normalized = (Array.isArray(findings) ? findings : []).map(normalizeFinding);
  const blocking = normalized.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const residual = normalized.filter((finding) => !BLOCKING_SEVERITIES.has(finding.severity));
  const next_tasks = normalized.map(taskFromFinding);
  const repair_proposals = blocking.map((finding) => ({
    priority: 'P0',
    title: `${finding.code}: ${finding.message || 'Fix blocking acceptance failure'}`.slice(0, 160),
    finding_code: finding.code,
    severity: finding.severity,
    proposed_action: finding.message || 'Fix the blocking acceptance failure and rerun verification.',
  }));

  const passed = blocking.length === 0;
  return {
    status: passed ? (residual.length > 0 ? 'accepted_with_followups' : 'accepted') : 'needs_fix',
    passed,
    should_enter_review: passed ? needs_gpt_review === true : false,
    review_reason: needs_gpt_review ? review_reason : null,
    blocking_count: blocking.length,
    residual_count: residual.length,
    repair_proposals,
    next_tasks,
  };
}

export function buildReviewerDecision({ result = {}, findings = [], needs_gpt_review = false, review_reason = null } = {}) {
  const acceptance_findings = (Array.isArray(findings) ? findings : []).map(normalizeFinding);
  const decision = evaluateAcceptance({ findings: acceptance_findings, needs_gpt_review, review_reason });
  const summary = decision.passed
    ? `Acceptance agent verdict: ${decision.status}; ${decision.residual_count} residual finding(s).`
    : `Acceptance agent verdict: ${decision.status}; ${decision.blocking_count} blocking finding(s) require automatic repair.`;
  return {
    role: 'acceptance_agent',
    summary,
    decision,
    acceptance_findings,
    next_tasks: decision.next_tasks,
    original_status: result?.status || null,
  };
}

export function buildWorktreeReliabilityFindings(signals = {}) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message, source: 'worktree_reliability_policy' });

  const lifecycle = signals.worktree_lifecycle || signals.repo_resolution?.worktree_lifecycle || null;
  if (lifecycle) {
    if (lifecycle.mode !== 'git_worktree') {
      add('major', 'git_worktree_lifecycle_metadata_only', 'Task repo resolution must record a real git_worktree lifecycle, not metadata-only isolation.');
    } else if (lifecycle.ok !== true) {
      add('blocker', 'git_worktree_lifecycle_failed', lifecycle.error || 'git worktree lifecycle failed before task execution.');
    } else if (lifecycle.cleanup_supported !== true) {
      add('major', 'worktree_cleanup_lifecycle_missing', 'Real git worktree lifecycle must advertise cleanup support.');
    }
  } else if (signals.git_worktree_created !== true) {
    add('followup', 'git_worktree_not_created', 'Task worktree lifecycle is metadata-only; implement git worktree add/remove before claiming per-task isolation.');
  }
  if (signals.repo_lock_atomic !== true) {
    add('blocker', 'repo_lock_not_atomic', 'Repository lock acquisition must use an atomic filesystem protocol.');
  }
  if (signals.queue_dirty_check_repo_id_driven !== true) {
    add('major', 'queue_dirty_check_not_repo_id_driven', 'Queue dirty checks must resolve repo_id to the canonical repo/worktree path.');
  }
  if (signals.task_processor_lock_repo_id_driven !== true) {
    add('blocker', 'task_processor_lock_not_repo_id_driven', 'Task processor lock scope must use the resolved repo/worktree path.');
  }
  if (!lifecycle && signals.worktree_cleanup_lifecycle !== true) {
    add('major', 'worktree_cleanup_lifecycle_missing', 'Worktree cleanup/prune lifecycle is required beyond prompt-file cleanup.');
  }
  if (signals.crash_recovery_supported !== true) {
    add('major', 'lock_worktree_crash_recovery_missing', 'Lock/worktree state must be diagnosable and recoverable after crashes.');
  }

  return findings;
}
