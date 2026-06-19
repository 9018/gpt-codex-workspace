import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_TIMED_OUT,
  VALID_STATUSES,
  KIND_EXECUTED,
  KIND_FAILED,
  KIND_TIMEOUT,
  RESULT_FIELDS,
  RUNTIME_SRC_PATTERNS,
  isValidStatus,
  isNoopResult,
  createSuccessResult,
  createNoopResult,
  createFailedResult,
  createTimeoutResult,
  validateFinalizerResult,
  detectRuntimeCodeChanges,
  checkResultForRuntimeChanges,
} from '../src/codex-finalizer-contract.mjs';

// ===========================================================================
// Constants
// ===========================================================================

test('exports valid status constants', () => {
  assert.equal(STATUS_COMPLETED, 'completed');
  assert.equal(STATUS_FAILED, 'failed');
  assert.equal(STATUS_TIMED_OUT, 'timed_out');
  assert.deepEqual(VALID_STATUSES, ['completed', 'failed', 'timed_out']);
});

test('exports valid kind constants', () => {
  assert.equal(KIND_EXECUTED, 'codex_executed');
  assert.equal(KIND_FAILED, 'codex_failed');
  assert.equal(KIND_TIMEOUT, 'codex_timeout');
});

test('RESULT_FIELDS contains expected contract fields', () => {
  assert.deepEqual(RESULT_FIELDS, [
    'status',
    'summary',
    'changed_files',
    'tests',
    'commit',
    'remote_head',
    'warnings',
    'followups',
    'completed_at',
  ]);
});

test('RUNTIME_SRC_PATTERNS matches backend/src/*.mjs', () => {
  assert.ok(RUNTIME_SRC_PATTERNS[0].test('backend/src/codex-finalizer-contract.mjs'));
  assert.ok(RUNTIME_SRC_PATTERNS[0].test('backend/src/codex-result-parser.mjs'));
  assert.ok(!RUNTIME_SRC_PATTERNS[0].test('backend/test/codex-finalizer-contract.test.mjs'));
  assert.ok(!RUNTIME_SRC_PATTERNS[0].test('backend/package.json'));
  assert.ok(!RUNTIME_SRC_PATTERNS[0].test('README.md'));
});

// ===========================================================================
// isValidStatus
// ===========================================================================

test('isValidStatus returns true for valid statuses', () => {
  assert.equal(isValidStatus('completed'), true);
  assert.equal(isValidStatus('failed'), true);
  assert.equal(isValidStatus('timed_out'), true);
});

test('isValidStatus returns false for invalid values', () => {
  assert.equal(isValidStatus('unknown'), false);
  assert.equal(isValidStatus('COMPLETED'), false);    // case-sensitive
  assert.equal(isValidStatus(''), false);
  assert.equal(isValidStatus(null), false);
  assert.equal(isValidStatus(undefined), false);
  assert.equal(isValidStatus(0), false);
});

// ===========================================================================
// createSuccessResult — structured success result shape
// ===========================================================================

test('createSuccessResult produces contract-compliant completed result', () => {
  const result = createSuccessResult({
    summary: 'Deployed successfully',
    changed_files: ['src/main.js', 'src/utils.js'],
    tests: 'npm test: passed 15/15',
    commit: 'abc123def456',
    remote_head: '789ghi012jkl',
    warnings: ['Minor lint warning'],
    followups: ['Update docs'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.kind, 'codex_executed');
  assert.equal(result.summary, 'Deployed successfully');
  assert.deepEqual(result.changed_files, ['src/main.js', 'src/utils.js']);
  assert.equal(result.tests, 'npm test: passed 15/15');
  assert.equal(result.commit, 'abc123def456');
  assert.equal(result.remote_head, '789ghi012jkl');
  assert.deepEqual(result.warnings, ['Minor lint warning']);
  assert.deepEqual(result.followups, ['Update docs']);
  assert.ok(result.completed_at);
  assert.equal(typeof result.completed_at, 'string');
  assert.ok(result.completed_at.length > 0);
});

test('createSuccessResult omits optional fields as null/empty', () => {
  const result = createSuccessResult();
  assert.equal(result.summary, null);
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.tests, null);
  assert.equal(result.commit, null);
  assert.equal(result.remote_head, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.followups, []);
});

test('createSuccessResult accepts explicit completed_at', () => {
  const fixed = '2026-01-01T00:00:00.000Z';
  const result = createSuccessResult({ completed_at: fixed });
  assert.equal(result.completed_at, fixed);
});

// ===========================================================================
// createFailedResult
// ===========================================================================

test('createFailedResult produces contract-compliant failed result', () => {
  const result = createFailedResult({
    summary: 'Build failed',
    changed_files: ['src/broken.js'],
    warnings: ['Syntax error'],
    followups: ['Fix syntax error'],
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'codex_failed');
  assert.equal(result.summary, 'Build failed');
  assert.deepEqual(result.changed_files, ['src/broken.js']);
  assert.deepEqual(result.warnings, ['Syntax error']);
  assert.deepEqual(result.followups, ['Fix syntax error']);
  assert.equal(result.timed_out, false);
  assert.ok(result.completed_at);
});

// ===========================================================================
// createTimeoutResult
// ===========================================================================

test('createTimeoutResult produces contract-compliant timeout result', () => {
  const result = createTimeoutResult({
    summary: 'Timed out after 300s',
    timeoutSeconds: 300,
    warnings: ['Exceeded budget'],
    followups: ['Retry with larger budget'],
  });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.kind, 'codex_timeout');
  assert.equal(result.summary, 'Timed out after 300s');
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_seconds, 300);
  assert.deepEqual(result.warnings, ['Exceeded budget']);
  assert.deepEqual(result.followups, ['Retry with larger budget']);
  assert.deepEqual(result.changed_files, []);
  assert.ok(result.completed_at);
});

test('createTimeoutResult defaults timeout_seconds to 0', () => {
  const result = createTimeoutResult();
  assert.equal(result.timeout_seconds, 0);
});

// ===========================================================================
// createNoopResult
// ===========================================================================

test('createNoopResult produces contract-compliant no-op completed result', () => {
  const result = createNoopResult({
    summary: 'Already up to date',
    warnings: ['No changes needed'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.kind, 'codex_executed');
  assert.equal(result.summary, 'Already up to date');
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.tests, null);
  assert.equal(result.commit, null);
  assert.equal(result.remote_head, null);
  assert.deepEqual(result.warnings, ['No changes needed']);
  assert.deepEqual(result.followups, []);
  assert.equal(result.noop, true);
  assert.ok(result.completed_at);
});

test('createNoopResult uses default summary when none given', () => {
  const result = createNoopResult();
  assert.equal(result.summary, 'No changes needed (no-op)');
  assert.equal(result.noop, true);
});

// ===========================================================================
// isNoopResult — no-op detection
// ===========================================================================

test('isNoopResult detects no-op: empty changed_files, no tests, no commit', () => {
  const result = {
    status: 'completed',
    changed_files: [],
    tests: null,
    commit: null,
  };
  assert.equal(isNoopResult(result), true);
});

test('isNoopResult detects no-op: missing fields', () => {
  const result = { status: 'completed' };
  assert.equal(isNoopResult(result), true);
});

test('isNoopResult detects no-op: "none" strings', () => {
  const result = {
    status: 'completed',
    changed_files: [],
    tests: 'none',
    commit: 'none',
  };
  assert.equal(isNoopResult(result), true);
});

test('isNoopResult returns false when changed_files present', () => {
  const result = {
    status: 'completed',
    changed_files: ['file.js'],
    tests: null,
    commit: null,
  };
  assert.equal(isNoopResult(result), false);
});

test('isNoopResult returns false when tests present', () => {
  const result = {
    status: 'completed',
    changed_files: [],
    tests: 'passed 10/10',
    commit: null,
  };
  assert.equal(isNoopResult(result), false);
});

test('isNoopResult returns false when commit present', () => {
  const result = {
    status: 'completed',
    changed_files: [],
    tests: null,
    commit: 'abc123',
  };
  assert.equal(isNoopResult(result), false);
});

test('isNoopResult returns false for non-completed statuses', () => {
  assert.equal(isNoopResult({ status: 'failed', changed_files: [], tests: null, commit: null }), false);
  assert.equal(isNoopResult({ status: 'timed_out', changed_files: [], tests: null, commit: null }), false);
});

test('isNoopResult returns false for null/undefined', () => {
  assert.equal(isNoopResult(null), false);
  assert.equal(isNoopResult(undefined), false);
});

test('isNoopResult works with createNoopResult', () => {
  assert.equal(isNoopResult(createNoopResult()), true);
});

test('isNoopResult works with createSuccessResult — not no-op', () => {
  const result = createSuccessResult({ changed_files: ['file.js'], tests: 'ok', commit: 'abc' });
  assert.equal(isNoopResult(result), false);
});

// ===========================================================================
// validateFinalizerResult — contract validation
// ===========================================================================

test('validateFinalizerResult passes a valid success result', () => {
  const result = createSuccessResult({
    summary: 'Done',
    changed_files: ['a.js'],
    tests: 'passed',
    commit: 'abc',
    remote_head: 'def',
    warnings: ['w1'],
    followups: ['f1'],
  });
  const { valid, errors } = validateFinalizerResult(result);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateFinalizerResult passes a valid noop result', () => {
  const result = createNoopResult();
  const { valid, errors } = validateFinalizerResult(result);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateFinalizerResult passes a valid failed result', () => {
  const result = createFailedResult();
  const { valid, errors } = validateFinalizerResult(result);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateFinalizerResult passes a valid timeout result', () => {
  const result = createTimeoutResult({ timeoutSeconds: 60 });
  const { valid, errors } = validateFinalizerResult(result);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateFinalizerResult rejects null', () => {
  const { valid, errors } = validateFinalizerResult(null);
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test('validateFinalizerResult rejects invalid status', () => {
  const { valid, errors } = validateFinalizerResult({ status: 'bogus' });
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('invalid status')));
});

test('validateFinalizerResult rejects wrong types', () => {
  const result = {
    status: 'completed',
    summary: 42,
    changed_files: 'not-an-array',
    tests: true,
    commit: 123,
    remote_head: ['not-a-string'],
    warnings: 'not-array',
    followups: 'not-array',
    completed_at: 0,
  };
  const { valid, errors } = validateFinalizerResult(result);
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test('validateFinalizerResult accepts undefined optional fields', () => {
  const { valid, errors } = validateFinalizerResult({ status: 'completed' });
  // status is valid, no other fields present — should pass (they're optional)
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

// ===========================================================================
// detectRuntimeCodeChanges / checkResultForRuntimeChanges
// ===========================================================================

test('detectRuntimeCodeChanges detects backend/src/ changes', () => {
  const files = ['backend/src/codex-finalizer-contract.mjs', 'README.md'];
  const result = detectRuntimeCodeChanges(files);
  assert.equal(result.hasRuntimeChanges, true);
  assert.deepEqual(result.matchedFiles, ['backend/src/codex-finalizer-contract.mjs']);
});

test('detectRuntimeCodeChanges returns false for test files', () => {
  const files = ['backend/test/codex-finalizer-contract.test.mjs'];
  const result = detectRuntimeCodeChanges(files);
  assert.equal(result.hasRuntimeChanges, false);
  assert.deepEqual(result.matchedFiles, []);
});

test('detectRuntimeCodeChanges returns false for empty array', () => {
  const result = detectRuntimeCodeChanges([]);
  assert.equal(result.hasRuntimeChanges, false);
  assert.deepEqual(result.matchedFiles, []);
});

test('detectRuntimeCodeChanges handles non-array input', () => {
  const result = detectRuntimeCodeChanges(null);
  assert.equal(result.hasRuntimeChanges, false);
  assert.deepEqual(result.matchedFiles, []);
});

// --- checkResultForRuntimeChanges (warning pass-through) ---

test('checkResultForRuntimeChanges extracts changed_files from result', () => {
  const result = createSuccessResult({
    changed_files: ['backend/src/codex-finalizer-contract.mjs', 'README.md'],
  });
  const check = checkResultForRuntimeChanges(result);
  assert.equal(check.hasRuntimeChanges, true);
  assert.deepEqual(check.matchedFiles, ['backend/src/codex-finalizer-contract.mjs']);
});

test('checkResultForRuntimeChanges returns false for result without runtime files', () => {
  const result = createSuccessResult({
    changed_files: ['README.md'],
  });
  const check = checkResultForRuntimeChanges(result);
  assert.equal(check.hasRuntimeChanges, false);
  assert.deepEqual(check.matchedFiles, []);
});

test('checkResultForRuntimeChanges handles null result', () => {
  const check = checkResultForRuntimeChanges(null);
  assert.equal(check.hasRuntimeChanges, false);
  assert.deepEqual(check.matchedFiles, []);
});

test('checkResultForRuntimeChanges handles result without changed_files', () => {
  const check = checkResultForRuntimeChanges({ status: 'completed' });
  assert.equal(check.hasRuntimeChanges, false);
  assert.deepEqual(check.matchedFiles, []);
});

// ===========================================================================
// Factory results are all contract-valid
// ===========================================================================

test('all factory functions produce contract-valid results', () => {
  const results = [
    createSuccessResult({ summary: 's', changed_files: ['f'], tests: 't', commit: 'c', remote_head: 'r' }),
    createNoopResult(),
    createFailedResult({ summary: 'f' }),
    createTimeoutResult({ timeoutSeconds: 10 }),
  ];
  for (const result of results) {
    const { valid, errors } = validateFinalizerResult(result);
    assert.equal(valid, true, `expected valid for kind=${result.kind}: ${JSON.stringify(errors)}`);
  }
});

console.log('codex-finalizer-contract tests loaded');
