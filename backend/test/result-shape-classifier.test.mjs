import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT_SHAPE_TYPES,
  classifyResultShape,
  normalizeResultObject,
  resultEvidenceSummary,
} from '../src/result-shape-classifier.mjs';

test('exports frozen canonical result shape types', () => {
  assert.equal(Object.isFrozen(RESULT_SHAPE_TYPES), true);
  assert.deepEqual(RESULT_SHAPE_TYPES, {
    NO_RESULT: 'no_result',
    PROVIDER_NOOP: 'provider_noop',
    PROVIDER_TIMEOUT: 'provider_timeout',
    PROVIDER_NO_EVIDENCE: 'provider_no_evidence',
    FAILURE_EVIDENCE: 'failure_evidence',
    CODE_EVIDENCE: 'code_evidence',
    COMPLETION_EVIDENCE: 'completion_evidence',
    UNKNOWN: 'unknown',
  });
});

test('normalizeResultObject rejects nullish, arrays, and non-object inputs', () => {
  for (const value of [null, undefined, [], ['result'], 'result', 0, true]) {
    assert.equal(normalizeResultObject(value), null);
    assert.equal(classifyResultShape(value), RESULT_SHAPE_TYPES.NO_RESULT);
  }
});

test('normalizeResultObject returns plain result objects unchanged', () => {
  const result = { status: 'completed' };
  assert.equal(normalizeResultObject(result), result);
});

test('classifyResultShape detects passed completion evidence before code evidence', () => {
  for (const result of [
    { verification: { passed: true }, changed_files: ['backend/src/app.mjs'] },
    { reviewer: { passed: true } },
    { integration: { passed: true } },
  ]) {
    assert.equal(classifyResultShape(result), RESULT_SHAPE_TYPES.COMPLETION_EVIDENCE);
  }
});

test('classifyResultShape detects changed_files, tests, or commit evidence', () => {
  for (const result of [
    { changed_files: ['backend/src/app.mjs'] },
    { tests: 'node --test backend/test/example.test.mjs: pass' },
    { commit: 'b6e743ae57e734249efacc5477fbb7d970d2744e' },
  ]) {
    assert.equal(classifyResultShape(result), RESULT_SHAPE_TYPES.CODE_EVIDENCE);
  }
});

test('classifyResultShape detects provider no-op results', () => {
  assert.equal(classifyResultShape({ noop: true }), RESULT_SHAPE_TYPES.PROVIDER_NOOP);
  assert.equal(classifyResultShape({ failure_class: 'result_missing' }), RESULT_SHAPE_TYPES.PROVIDER_NOOP);
});

test('classifyResultShape detects provider timeout results', () => {
  assert.equal(classifyResultShape({ kind: 'codex_timeout' }), RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT);
  assert.equal(classifyResultShape({ failure_class: 'codex_timeout' }), RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT);
});

test('classifyResultShape detects codex failed results without evidence', () => {
  assert.equal(classifyResultShape({ kind: 'codex_failed' }), RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE);
});

test('classifyResultShape detects explicit failure evidence before provider-empty fallbacks', () => {
  for (const result of [
    { verification: { passed: false } },
    { findings: [{ code: 'verification_failed', message: 'Tests failed' }] },
    { commands: [{ cmd: 'npm test', exit_code: 1 }] },
    { failure_class: 'tests_failed' },
    { kind: 'verification_failed' },
    { requires_review: true },
  ]) {
    assert.equal(classifyResultShape(result), RESULT_SHAPE_TYPES.FAILURE_EVIDENCE);
  }
});

test('classifyResultShape keeps explicit noop and resolved failures non-blocking', () => {
  assert.equal(classifyResultShape({ noop: true, verification: { passed: false } }), RESULT_SHAPE_TYPES.PROVIDER_NOOP);
  assert.equal(classifyResultShape({ failure_class: 'result_missing', requires_review: false }), RESULT_SHAPE_TYPES.PROVIDER_NOOP);
});

test('classifyResultShape returns unknown for unrecognized object results', () => {
  assert.equal(classifyResultShape({ status: 'failed', summary: 'No classifier evidence' }), RESULT_SHAPE_TYPES.UNKNOWN);
});

test('resultEvidenceSummary returns deterministic evidence counts', () => {
  assert.deepEqual(resultEvidenceSummary({
    changed_files: ['backend/src/a.mjs', 'backend/src/b.mjs', '', 42],
    tests: ['node --test a.test.mjs', 'npm run check:syntax', null],
    commit: 'b6e743ae57e734249efacc5477fbb7d970d2744e',
    verification: { passed: true },
    reviewer: { passed: true },
    integration: { passed: false },
  }), {
    has_result: true,
    changed_files: 2,
    tests: 2,
    commits: 1,
    verification_passed: 1,
    reviewer_passed: 1,
    integration_passed: 0,
    failure_evidence: 0,
    code_evidence: 5,
    completion_evidence: 2,
    total: 7,
  });
});

test('resultEvidenceSummary returns zeroed counts for missing result shape', () => {
  assert.deepEqual(resultEvidenceSummary(null), {
    has_result: false,
    changed_files: 0,
    tests: 0,
    commits: 0,
    verification_passed: 0,
    reviewer_passed: 0,
    integration_passed: 0,
    failure_evidence: 0,
    code_evidence: 0,
    completion_evidence: 0,
    total: 0,
  });
});

// ===========================================================================
// P0-MA2: verification.commands as tests evidence
// ===========================================================================

test('P0-MA2: resultEvidenceSummary counts verification.commands as tests evidence', () => {
  const evidence = resultEvidenceSummary({
    changed_files: [],
    tests: null,
    verification: { commands: ['npm test'] },
  });

  assert.equal(evidence.tests, 1);
  assert.equal(evidence.code_evidence, 1);
});

test('P0-MA2: resultEvidenceSummary counts tests_derived_from_verification flag as tests evidence', () => {
  const evidence = resultEvidenceSummary({
    changed_files: [],
    tests: 'npm test',
    tests_derived_from_verification: true,
    verification: { commands: ['npm test'] },
  });

  assert.equal(evidence.tests, 1);
  assert.equal(evidence.code_evidence, 1);
});

test('P0-MA2: classifyResultShape with verification.commands but no changed_files is CODE_EVIDENCE', () => {
  assert.equal(
    classifyResultShape({
      changed_files: [],
      verification: { commands: ['npm test'] },
    }),
    RESULT_SHAPE_TYPES.CODE_EVIDENCE
  );
});

// ===========================================================================
// P0-MA2: Readonly and already_integrated as PROVIDER_NOOP
// ===========================================================================

test('P0-MA2: classifyResultShape with readonly_result is PROVIDER_NOOP', () => {
  assert.equal(
    classifyResultShape({
      readonly_result: true,
      operation_kind: 'readonly_validation',
    }),
    RESULT_SHAPE_TYPES.PROVIDER_NOOP
  );
});

test('P0-MA2: classifyResultShape with already_integrated_result is PROVIDER_NOOP', () => {
  assert.equal(
    classifyResultShape({
      already_integrated_result: true,
      operation_kind: 'already_integrated',
    }),
    RESULT_SHAPE_TYPES.PROVIDER_NOOP
  );
});

test('P0-MA2: classifyResultShape with noop_result is PROVIDER_NOOP', () => {
  assert.equal(
    classifyResultShape({
      noop_result: true,
      operation_kind: 'noop',
    }),
    RESULT_SHAPE_TYPES.PROVIDER_NOOP
  );
});
