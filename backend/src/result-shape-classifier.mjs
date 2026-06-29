export const RESULT_SHAPE_TYPES = Object.freeze({
  NO_RESULT: 'no_result',
  PROVIDER_NOOP: 'provider_noop',
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_NO_EVIDENCE: 'provider_no_evidence',
  CODE_EVIDENCE: 'code_evidence',
  COMPLETION_EVIDENCE: 'completion_evidence',
  UNKNOWN: 'unknown',
});

const ZERO_EVIDENCE_SUMMARY = Object.freeze({
  has_result: false,
  changed_files: 0,
  tests: 0,
  commits: 0,
  verification_passed: 0,
  reviewer_passed: 0,
  integration_passed: 0,
  code_evidence: 0,
  completion_evidence: 0,
  total: 0,
});

export function normalizeResultObject(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return result;
}

export function resultEvidenceSummary(result) {
  const normalized = normalizeResultObject(result);
  if (!normalized) return { ...ZERO_EVIDENCE_SUMMARY };

  const changedFiles = countStringArrayEvidence(normalized.changed_files);
  const tests = countTestsEvidence(normalized.tests);
  const commits = hasStringEvidence(normalized.commit) ? 1 : 0;
  const verificationPassed = hasPassedEvidence(normalized.verification) ? 1 : 0;
  const reviewerPassed = hasPassedEvidence(normalized.reviewer) ? 1 : 0;
  const integrationPassed = hasPassedEvidence(normalized.integration) ? 1 : 0;
  const codeEvidence = changedFiles + tests + commits;
  const completionEvidence = verificationPassed + reviewerPassed + integrationPassed;

  return {
    has_result: true,
    changed_files: changedFiles,
    tests,
    commits,
    verification_passed: verificationPassed,
    reviewer_passed: reviewerPassed,
    integration_passed: integrationPassed,
    code_evidence: codeEvidence,
    completion_evidence: completionEvidence,
    total: codeEvidence + completionEvidence,
  };
}

export function classifyResultShape(result) {
  const normalized = normalizeResultObject(result);
  if (!normalized) return RESULT_SHAPE_TYPES.NO_RESULT;

  const evidence = resultEvidenceSummary(normalized);
  if (evidence.completion_evidence > 0) return RESULT_SHAPE_TYPES.COMPLETION_EVIDENCE;
  if (evidence.code_evidence > 0) return RESULT_SHAPE_TYPES.CODE_EVIDENCE;
  if (normalized.noop === true || normalized.failure_class === 'result_missing') return RESULT_SHAPE_TYPES.PROVIDER_NOOP;
  if (normalized.kind === 'codex_timeout' || normalized.failure_class === 'codex_timeout') return RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT;
  if (normalized.kind === 'codex_failed') return RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE;
  return RESULT_SHAPE_TYPES.UNKNOWN;
}

function countStringArrayEvidence(value) {
  if (!Array.isArray(value)) return 0;
  return value.filter(hasStringEvidence).length;
}

function countTestsEvidence(value) {
  if (Array.isArray(value)) return countStringArrayEvidence(value);
  return hasStringEvidence(value) ? 1 : 0;
}

function hasStringEvidence(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasPassedEvidence(value) {
  return normalizeResultObject(value)?.passed === true;
}
