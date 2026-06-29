import {
  RESULT_SHAPE_TYPES,
  classifyResultShape,
} from './result-shape-classifier.mjs';
import {
  TASK_STATUSES,
  isActiveExecutionStatus,
  isKnownTaskStatus,
  normalizeTaskStatus,
} from './task-status-taxonomy.mjs';

export const CURRENT_WORK_DECISION_LABELS = Object.freeze({
  ACTIVE: 'active',
  REVIEW: 'review',
  INTEGRATION: 'integration',
  COMPLETED: 'completed',
  PROVIDER_EMPTY: 'provider_empty',
  CODE_EVIDENCE_FAILURE: 'code_evidence_failure',
  RESOLVED_BY_OPTIONS: 'resolved_by_options',
  UNKNOWN_STATUS: 'unknown_status',
});

const PROVIDER_EMPTY_RESULT_SHAPES = Object.freeze(new Set([
  RESULT_SHAPE_TYPES.NO_RESULT,
  RESULT_SHAPE_TYPES.PROVIDER_NOOP,
  RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT,
  RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE,
]));

export function classifyCurrentBlockerTask(task) {
  const record = normalizeTaskRecord(task);
  const status = normalizeTaskStatus(record?.status);
  const result = record?.result;
  const resultShape = classifyResultShape(result);

  if (!isKnownTaskStatus(status)) return decision(CURRENT_WORK_DECISION_LABELS.UNKNOWN_STATUS, status, resultShape, false);
  if (isResolvedByOptions(result)) return decision(CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS, status, resultShape, false);
  if (status === TASK_STATUSES.WAITING_FOR_REVIEW || status === TASK_STATUSES.WAITING_FOR_REPAIR) {
    return decision(CURRENT_WORK_DECISION_LABELS.REVIEW, status, resultShape, true);
  }
  if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
    return decision(CURRENT_WORK_DECISION_LABELS.INTEGRATION, status, resultShape, true);
  }
  if (isActiveExecutionStatus(status)) return decision(CURRENT_WORK_DECISION_LABELS.ACTIVE, status, resultShape, true);
  if (status === TASK_STATUSES.COMPLETED) return decision(CURRENT_WORK_DECISION_LABELS.COMPLETED, status, resultShape, false);
  if (PROVIDER_EMPTY_RESULT_SHAPES.has(resultShape)) return decision(CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY, status, resultShape, false);
  if (resultShape === RESULT_SHAPE_TYPES.CODE_EVIDENCE) {
    return decision(CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE, status, resultShape, true);
  }

  return decision(CURRENT_WORK_DECISION_LABELS.UNKNOWN_STATUS, status, resultShape, false);
}

function normalizeTaskRecord(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  return task;
}

function isResolvedByOptions(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return result.resolved_legacy === true
    || hasStringEvidence(result.resolved_by_task_id)
    || hasStringEvidence(result.superseded_by_task_id)
    || result.noop === true;
}

function hasStringEvidence(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function decision(label, status, resultShape, blocksCurrentWork) {
  return {
    label,
    status,
    result_shape: resultShape,
    blocks_current_work: blocksCurrentWork,
  };
}
