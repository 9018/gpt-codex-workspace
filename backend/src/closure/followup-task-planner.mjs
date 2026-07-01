import { normalizeList } from '../acceptance/contract-schema.mjs';
import { CLOSURE_STATUSES } from './auto-progress-policy.mjs';

function textFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.title || value.message || value.reason || value.code || '').trim();
  return '';
}

function reasonFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.reason || value.message || value.title || value.code || '').trim();
  return '';
}

function followupTitle(value, task = {}) {
  if (value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()) return value.title.trim();
  const text = textFrom(value);
  if (text) return `P1: ${text}`;
  return `P1: Continue improving ${task.title || task.id || 'completed task'}`;
}

function normalizeFollowup(value, { task = {}, goal = {}, source = 'closure_decision' } = {}) {
  return {
    title: followupTitle(value, task),
    reason: reasonFrom(value) || 'Current implementation is acceptable and blocking gate passed, but this item remains useful follow-up work.',
    severity: 'non_blocking',
    source_task_id: task?.id || null,
    source_goal_id: goal?.id || null,
    source,
    auto_enqueue: false,
  };
}

function qualityNoteFollowup(note, context) {
  const normalized = normalizeFollowup(note, { ...context, source: 'quality_note' });
  return {
    ...normalized,
    reason: `Blocking gate passed; quality note for later: ${reasonFrom(note) || normalized.reason}`,
  };
}

function statusIsAccepted(status) {
  return status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN || status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
}

function attemptFromTask(task = {}, result = {}) {
  if (Number.isInteger(result.handling_attempt)) return result.handling_attempt;
  if (Number.isInteger(result.repair_attempt)) return result.repair_attempt;
  if (Number.isInteger(result.attempt)) return result.attempt;
  if (Number.isInteger(task.repair_attempt)) return task.repair_attempt + 1;
  if (Number.isInteger(task.attempt)) return task.attempt + 1;
  return 1;
}

function blockersFromClosure(closureDecision = {}) {
  return [
    ...normalizeList(closureDecision.repairable_blockers),
    ...normalizeList(closureDecision.blockers),
  ];
}

export function planUnacceptedTaskFollowup({ task = {}, goal = {}, result = {}, closureDecision = {}, acceptanceGate = {}, created = null } = {}) {
  if (!closureDecision?.status || statusIsAccepted(closureDecision.status)) return null;
  if (acceptanceGate?.passed === true || acceptanceGate?.status === 'passed') return null;

  const followupGoalId = created?.goal?.id || result.repair_goal_id || result.followup_goal_id || null;
  const followupTaskId = created?.task?.id || result.repair_task_id || result.followup_task_id || null;
  const blockers = blockersFromClosure(closureDecision);
  const failureClass = result.failure_class || result.repair_goal?.failure_class || blockers[0]?.code || null;

  return {
    kind: 'unaccepted_task_followup',
    source: 'acceptance_gate',
    source_task_id: task.id || null,
    source_goal_id: task.goal_id || goal.id || null,
    root_task_id: task.root_task_id || result.root_task_id || task.id || null,
    followup_goal_id: followupGoalId,
    followup_task_id: followupTaskId,
    handling_attempt: attemptFromTask(task, result),
    handling_result: {
      status: closureDecision.task_status || closureDecision.status || null,
      closure_status: closureDecision.status || null,
      reason: closureDecision.reason || result.reason || null,
      failure_class: failureClass,
      acceptance_status: acceptanceGate?.status || null,
      passed: acceptanceGate?.passed === true,
    },
    blockers,
    auto_enqueue: Boolean(followupGoalId || followupTaskId),
  };
}

export function planFollowupTasks({ task = {}, goal = {}, result = {}, contractVerification = {}, closureDecision = {} } = {}) {
  if (closureDecision.status !== CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS) return [];

  const explicit = [
    ...normalizeList(closureDecision.non_blocking_followups),
    ...normalizeList(contractVerification.non_blocking_followups),
    ...normalizeList(result.non_blocking_followups),
    ...normalizeList(result.followup_findings),
    ...normalizeList(result.followups),
  ];
  const qualityNotes = [
    ...normalizeList(closureDecision.quality_notes),
    ...normalizeList(contractVerification.quality_notes),
    ...normalizeList(result.quality_notes),
  ];

  const seen = new Set();
  const tasks = [];
  for (const followup of explicit) {
    const planned = normalizeFollowup(followup, { task, goal, source: 'closure_decision' });
    const key = `${planned.title}\n${planned.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(planned);
  }
  for (const note of qualityNotes) {
    const planned = qualityNoteFollowup(note, { task, goal });
    const key = `${planned.title}\n${planned.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(planned);
  }
  return tasks;
}
