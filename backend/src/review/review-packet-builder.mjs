import { REVIEW_STATES, isTypedReviewState } from '../task-review-status-taxonomy.mjs';

import { getTaskAcceptanceBundle } from './task-acceptance-bundle.mjs';
import { reconcileBundle } from './review-backlog-reconciler.mjs';

function compactGitSummary(bundle = {}, taskResult = {}) {
  const summary = taskResult.compact_git_summary || taskResult.git_summary || {};
  const diffStat = summary.diff_stat || summary.diffStat || {};
  const changedFiles = Array.isArray(bundle.changed_files) ? bundle.changed_files : [];
  return {
    files_changed: Number.isFinite(diffStat.files_changed) ? diffStat.files_changed : changedFiles.length,
    insertions: Number.isFinite(diffStat.insertions) ? diffStat.insertions : null,
    deletions: Number.isFinite(diffStat.deletions) ? diffStat.deletions : null,
    commit: bundle.result_summary?.commit || bundle.integration?.commit || null,
    remote_head: bundle.result_summary?.remote_head || null,
  };
}

function reasonForReview(bundle = {}) {
  if (bundle.closure_decision?.reason) return bundle.closure_decision.reason;
  if (bundle.blockers?.length) return 'Blocking findings require review.';
  if (bundle.missing_evidence?.length) return 'Required result or verification evidence is missing.';
  if (bundle.status === 'waiting_for_review' || isTypedReviewState(bundle.status)) return 'Task is waiting for review: ' + bundle.status + '.';
  if (bundle.status === 'failed') return 'Task failed and needs triage.';
  if (bundle.status === 'running' || bundle.status === 'assigned') return 'Task is still running or not finalized.';
  return 'Review packet requested.';
}

function recommendedNextAction(bundle = {}) {
  if (bundle.status === 'running' || bundle.status === 'assigned' || bundle.status === 'queued') {
    return { action: 'wait_for_result', reason: 'Task has not produced final result evidence yet.' };
  }
  if (bundle.missing_evidence?.some((item) => item.code === 'result_missing' || item.code === 'verification_missing')) {
    return { action: 'wait_for_result', reason: 'Result or verification evidence is missing.' };
  }
  if (bundle.blockers?.length) {
    return { action: 'review_blockers', reason: 'Blocking findings are present in the compact evidence.' };
  }
  if (bundle.closure_decision?.status === 'requires_review' || bundle.status === 'waiting_for_review' || isTypedReviewState(bundle.status)) {
    return { action: 'manual_review', reason: 'Closure decision requires human review.' };
  }
  if (bundle.status === 'completed' && bundle.verification?.passed === true) {
    return { action: 'close_task', reason: 'Verification passed and no blocking findings are present.' };
  }
  if (bundle.status === 'failed') return { action: 'triage_failure', reason: 'Task is failed.' };
  return { action: 'inspect_packet', reason: 'Packet contains enough compact evidence for review.' };
}

function keyEvidence(bundle = {}) {
  return {
    result_summary: bundle.result_summary,
    verification: bundle.verification,
    contract_verification: bundle.contract_verification,
    no_change_repair_completion_summary: bundle.no_change_repair_completion_summary || null,
    closure_decision: bundle.closure_decision,
    report_paths: bundle.report_paths,
    run_evidence: bundle.run_evidence,
  };
}

export async function getTaskReviewPacket({ store, config = {}, task_id } = {}) {
  const bundle = await getTaskAcceptanceBundle({ store, config, task_id });
  const state = await store.load();
  const task = typeof store.findTaskById === 'function'
    ? await store.findTaskById(task_id)
    : state.tasks?.find((item) => item.id === task_id) || null;
  const taskResult = task?.result && typeof task.result === 'object' ? task.result : {};

  const packet = {
    task_id: bundle.task_id,
    goal_id: bundle.goal_id,
    title: bundle.title,
    status: bundle.status,
    task_status: task?.status || bundle.status,
    reason_for_review: reasonForReview(bundle),
    compact_git_summary: compactGitSummary(bundle, taskResult),
    changed_files: bundle.changed_files,
    reconciliation: null,
    reconciled_evidence: null,
    key_evidence: keyEvidence(bundle),
    blocking_findings: bundle.blockers,
    non_blocking_followups: bundle.non_blocking_followups,
    recommended_next_action: recommendedNextAction(bundle),
    missing_evidence: bundle.missing_evidence,
  };

  // Run reconciliation against the bundle to detect stale state
  try {
    const reconciliation = reconcileBundle({ task, bundle });
    packet.reconciliation = {
      reconciled: reconciliation.reconciled,
      reconciled_count: reconciliation.reconciled_count,
      still_blocking_count: reconciliation.still_blocking_count,
      reconciled_findings: reconciliation.reconciled_findings,
    };
    packet.reconciled_evidence = reconciliation.evidence;
  } catch {
    // Reconciliation is best-effort; packet still returns without it
  }

  return packet;
}
