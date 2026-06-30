import { normalizeList } from './acceptance-contract-schema.mjs';
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

