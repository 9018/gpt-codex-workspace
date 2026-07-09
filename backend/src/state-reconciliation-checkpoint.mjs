const TERMINAL_STOP_REASONS = new Set([
  'passed',
  'completed',
  'already_integrated',
]);

function compactStrings(values = []) {
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];
}

function blockerCodes(...sources) {
  const codes = [];
  for (const source of sources) {
    for (const blocker of source?.blockers || []) {
      if (blocker?.code) codes.push(String(blocker.code));
    }
    for (const finding of source?.acceptance_findings || []) {
      if (finding?.code) codes.push(String(finding.code));
    }
    for (const code of source?.diagnosis_codes || []) codes.push(String(code));
    if (source?.reason) codes.push(String(source.reason));
    if (source?.failure_class) codes.push(String(source.failure_class));
    if (source?.kind) codes.push(String(source.kind));
  }
  return compactStrings(codes);
}

function collectChangedFiles(...sources) {
  const files = [];
  for (const source of sources) {
    if (Array.isArray(source?.changed_files)) files.push(...source.changed_files);
    if (Array.isArray(source?.dirty_paths)) files.push(...source.dirty_paths);
    if (Array.isArray(source?.canonical_dirty_paths)) files.push(...source.canonical_dirty_paths);
    const bySource = source?.canonical_dirty_classification?.by_source;
    if (bySource && typeof bySource === 'object') {
      for (const value of Object.values(bySource)) {
        if (Array.isArray(value)) files.push(...value);
      }
    }
  }
  return compactStrings(files);
}

function evidencePaths(...sources) {
  const paths = [];
  for (const source of sources) {
    if (source?.result_json_path) paths.push(source.result_json_path);
    if (source?.result_md_path) paths.push(source.result_md_path);
    if (source?.review_packet_path) paths.push(source.review_packet_path);
    if (source?.acceptance_bundle_path) paths.push(source.acceptance_bundle_path);
    if (Array.isArray(source?.evidence_paths)) paths.push(...source.evidence_paths);
  }
  return compactStrings(paths);
}

function hasStructuredResult(...sources) {
  return sources.some((source) => Boolean(
    source?.result_json_path
      || source?.result_md_path
      || source?.structured_summary
      || source?.summary
      || source?.result?.structured_summary,
  ));
}

function isRunning(worker = {}, locks = {}) {
  return Boolean(
    worker?.running
      || worker?.status === 'running'
      || worker?.state === 'running'
      || locks?.active === true
      || Number(locks?.active_count || 0) > 0
      || Number(locks?.active_locks || 0) > 0,
  );
}

function inferPrimarySignal({ codes, changedFiles, structuredResult, worker, locks, task = {}, taskResult = {}, parsedResult = {}, recoveryEvidence = {} }) {
  if (isRunning(worker, locks)) return 'active_lock_or_running_worker';
  if (codes.includes('canonical_dirty') || recoveryEvidence?.canonical_clean_before === false) return 'canonical_dirty';
  if (codes.includes('result_missing') || taskResult?.failure_class === 'result_missing' || parsedResult?.failure_class === 'result_missing') return 'result_missing';
  if (codes.includes('codex_failed') || taskResult?.kind === 'codex_failed' || parsedResult?.kind === 'codex_failed') return 'codex_failed';
  if (changedFiles.length === 0 && !structuredResult) return 'no_op_without_evidence';
  if (task?.status === 'waiting_for_review' || taskResult?.status === 'waiting_for_review') return 'waiting_for_review';
  if (TERMINAL_STOP_REASONS.has(String(taskResult?.reason || parsedResult?.reason || recoveryEvidence?.reason || '').toLowerCase())) return 'terminal_evidence_present';
  return 'needs_reconciliation';
}

function decisionForSignal(signal) {
  switch (signal) {
    case 'active_lock_or_running_worker':
      return {
        verdict: 'partial',
        decision: 'continue',
        next_action: 'append_requirements_to_current_task',
        rationale: 'Active execution or lock is present; do not抢占 or force-clear. Append evidence and acceptance requirements to the current task or queue a non-conflicting follow-up.',
      };
    case 'canonical_dirty':
      return {
        verdict: 'blocked-with-next-action',
        decision: 'replan',
        next_action: 'attribute_dirty_paths_before_repair',
        rationale: 'Canonical repository is dirty; do not reset, clean, or overwrite. Attribute paths first, then split a minimal repair/evidence task.',
      };
    case 'result_missing':
    case 'no_op_without_evidence':
      return {
        verdict: 'blocked-with-next-action',
        decision: 'replan',
        next_action: 'collect_result_and_acceptance_evidence',
        rationale: 'Execution produced no recoverable result evidence. Convert the no-op into an evidence packet before retrying implementation.',
      };
    case 'codex_failed':
      return {
        verdict: 'partial',
        decision: 'replan',
        next_action: 'split_failure_into_minimal_repair',
        rationale: 'Provider failure is machine-actionable only after logs, result artifacts, and verification commands are captured.',
      };
    case 'waiting_for_review':
      return {
        verdict: 'partial',
        decision: 'continue',
        next_action: 'gptchat_default_continue_with_guardrails',
        rationale: 'Human-review state defaults to GPTChat judgment: continue with guardrails, but require evidence before marking passed.',
      };
    case 'terminal_evidence_present':
      return {
        verdict: 'passed',
        decision: 'stop',
        next_action: 'record_terminal_evidence',
        rationale: 'Terminal evidence is present. Record it and stop only when verification and acceptance evidence are sufficient.',
      };
    default:
      return {
        verdict: 'partial',
        decision: 'continue',
        next_action: 'build_decision_snapshot_and_verify',
        rationale: 'State needs reconciliation; continue only by creating a durable decision snapshot and targeted verification evidence.',
      };
  }
}

export function buildStateReconciliationCheckpoint({
  task = {},
  taskResult = {},
  parsedResult = {},
  recoveryEvidence = {},
  resolvedRepo = {},
  locks = {},
  worker = {},
  retainedWorktrees = [],
  docs = [],
} = {}) {
  const codes = blockerCodes(task, taskResult, parsedResult, recoveryEvidence);
  const changedFiles = collectChangedFiles(task, taskResult, parsedResult, recoveryEvidence);
  const paths = evidencePaths(task, taskResult, parsedResult, recoveryEvidence);
  const structuredResult = hasStructuredResult(task, taskResult, parsedResult, recoveryEvidence);
  const primarySignal = inferPrimarySignal({ codes, changedFiles, structuredResult, worker, locks, task, taskResult, parsedResult, recoveryEvidence });
  const decision = decisionForSignal(primarySignal);

  const requiredEvidence = compactStrings([
    'result.json',
    'result.md',
    'review packet',
    'acceptance bundle',
    'test commands and outputs',
    'changed_files',
    'evidence_paths',
    primarySignal === 'canonical_dirty' ? 'dirty path attribution' : null,
    primarySignal === 'active_lock_or_running_worker' ? 'current task/workflow log append' : null,
    primarySignal === 'result_missing' || primarySignal === 'no_op_without_evidence' ? 'retained worktree inspection' : null,
  ]);

  return {
    schema: 'gptwork.state_reconciliation_checkpoint.v1',
    task_id: task?.id || taskResult?.task_id || parsedResult?.task_id || null,
    goal_id: task?.goal_id || taskResult?.goal_id || parsedResult?.goal_id || recoveryEvidence?.goal_id || null,
    primary_signal: primarySignal,
    verdict: decision.verdict,
    decision: decision.decision,
    next_action: decision.next_action,
    rationale: decision.rationale,
    guardrails: {
      do_not_force_clear_locks: true,
      do_not_overwrite_dirty_worktree: true,
      do_not_discard_existing_changes: true,
      do_not_fake_completion: true,
      do_not_bypass_acceptance: true,
    },
    state: {
      status: task?.status || taskResult?.status || parsedResult?.status || null,
      blockers: codes,
      changed_files: changedFiles,
      evidence_paths: paths,
      canonical_repo_path: resolvedRepo?.canonical_repo_path || recoveryEvidence?.canonical_repo_path || null,
      task_worktree_path: resolvedRepo?.task_worktree_path || recoveryEvidence?.worktree_path || null,
      retained_worktrees: compactStrings(retainedWorktrees),
      canonical_dirty_classification: recoveryEvidence?.canonical_dirty_classification || null,
      active_lock_or_running_worker: isRunning(worker, locks),
    },
    required_evidence: requiredEvidence,
    documentation_updates: compactStrings([
      ...docs,
      'docs/run-evidence.md',
      'docs/closure-acceptance.md',
      'docs/queue-auto-advance.md',
    ]),
  };
}

export default buildStateReconciliationCheckpoint;
