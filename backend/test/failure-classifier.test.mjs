import test from 'node:test';
import assert from 'node:assert/strict';

import { canRetryTask, classifyTaskFailure, classifyFailure, classifyFailureStructured } from '../src/failure-classifier.mjs';

test('classifyTaskFailure classifies required verification and execution failures', () => {
  const cases = [
    {
      name: 'missing result.json',
      input: { verification: { findings: [{ code: 'result_json_missing', message: 'No task result data' }] } },
      expected: 'missing_result_json',
      repairable: true,
    },
    {
      name: 'invalid result.json',
      input: { verification: { findings: [{ code: 'result_json_invalid', message: 'Unexpected token' }] } },
      expected: 'invalid_result_json',
      repairable: true,
    },
    {
      name: 'test failed',
      input: { verification: { commands: [{ cmd: 'npm test', exit_code: 1, stderr_tail: '1 failing' }] } },
      expected: 'test_failed',
      repairable: true,
    },
    {
      name: 'build failed',
      input: { verification: { commands: [{ cmd: 'npm run build', exit_code: 1, stderr_tail: 'build error' }] } },
      expected: 'build_failed',
      repairable: true,
    },
    {
      name: 'lint failed',
      input: { verification: { commands: [{ cmd: 'npm run lint', exit_code: 1, stderr_tail: 'lint error' }] } },
      expected: 'lint_failed',
      repairable: true,
    },
    {
      name: 'typecheck failed',
      input: { verification: { commands: [{ cmd: 'npm run typecheck', exit_code: 1, stderr_tail: 'type error' }] } },
      expected: 'typecheck_failed',
      repairable: true,
    },
    {
      name: 'git diff check failed',
      input: { verification: { commands: [{ cmd: 'git diff --check', exit_code: 1, stderr_tail: 'trailing whitespace' }] } },
      expected: 'git_diff_check_failed',
      repairable: true,
    },
    {
      name: 'no first output timeout',
      input: { codexResult: { no_first_output_timeout: true, summary: 'No first output' } },
      expected: 'no_first_output_timeout',
      repairable: true,
    },
    {
      name: 'codex timeout',
      input: { codexResult: { timed_out: true, kind: 'codex_timeout', summary: 'Codex timeout' } },
      expected: 'codex_timeout',
      repairable: false,
    },
    {
      name: 'merge conflict',
      input: { verification: { findings: [{ code: 'merge_conflict', message: 'CONFLICT in app.mjs' }] } },
      expected: 'merge_conflict',
      repairable: false,
    },
    {
      name: 'unknown',
      input: { error: new Error('unmatched failure') },
      expected: 'unknown',
      repairable: false,
    },
  ];

  for (const entry of cases) {
    const failure = classifyTaskFailure(entry.input);
    assert.equal(failure.failure_class, entry.expected, entry.name);
    assert.equal(failure.repairable, entry.repairable, entry.name);
    assert.ok(failure.reason, `${entry.name} should include a reason`);
    assert.ok(failure.repair_strategy, `${entry.name} should include a repair strategy`);
  }
});

test('canRetryTask respects attempt and max_attempts with default one repair retry', () => {
  const repairable = { failure_class: 'test_failed', repairable: true };
  assert.equal(canRetryTask({ attempt: 0, max_attempts: 2 }, repairable), true);
  assert.equal(canRetryTask({ attempt: 1, max_attempts: 2 }, repairable), false);
  assert.equal(canRetryTask({ attempt: 0 }, repairable), true);
  assert.equal(canRetryTask({ attempt: 0, max_attempts: 2 }, { failure_class: 'merge_conflict', repairable: false }), false);
});


// ================================================================
// P0: Quota/rate-limit classification tests
// ================================================================

test('classifyTaskFailure classifies quota_exhausted from codexResult failure_class', () => {
  const failure = classifyTaskFailure({
    codexResult: { failure_class: 'quota_exhausted', summary: 'insufficient_quota error from OpenAI' }
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.equal(failure.repairable, false);
  assert.equal(failure.repair_strategy, 'quota_wait_or_capacity_check');
  assert.match(failure.reason, /quota/i);
});

test('classifyTaskFailure classifies rate_limited from codexResult failure_class', () => {
  const failure = classifyTaskFailure({
    codexResult: { failure_class: 'rate_limited', summary: '429 too many requests' }
  });
  assert.equal(failure.failure_class, 'rate_limited');
  assert.equal(failure.repairable, false);
  assert.equal(failure.repair_strategy, 'rate_limit_backoff');
});

test('classifyTaskFailure classifies quota_exhausted_or_rate_limited as quota_exhausted', () => {
  const failure = classifyTaskFailure({
    codexResult: { failure_class: 'quota_exhausted_or_rate_limited', summary: 'quota exceeded' }
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure detects quota_exhausted from text patterns in combined output', () => {
  const failure = classifyTaskFailure({
    error: new Error('Error: insufficient_quota - you have exceeded your quota')
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure detects quota_exhausted from billing_hard_limit_reached pattern', () => {
  const failure = classifyTaskFailure({
    error: new Error('billing_hard_limit_reached: Monthly credit limit exceeded')
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure detects rate_limited from 429 status code', () => {
  const failure = classifyTaskFailure({
    error: new Error('HTTP 429: too many requests, retry after 60s')
  });
  assert.equal(failure.failure_class, 'rate_limited');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure detects rate_limited from rate_limit_exceeded text', () => {
  const failure = classifyTaskFailure({
    error: new Error('rate_limit_exceeded: requests per minute limit reached')
  });
  assert.equal(failure.failure_class, 'rate_limited');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure detects resource_exhausted as quota_exhausted', () => {
  const failure = classifyTaskFailure({
    task: { result: { failure_class: 'resource_exhausted', summary: 'OpenAI API resource exhausted' } }
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.equal(failure.repairable, false);
});

test('classifyTaskFailure does NOT go to unknown for quota patterns', () => {
  // Without quota detection, this would be classified as "unknown"
  const failure = classifyTaskFailure({
    error: new Error('insufficient_quota: exceeded current quota for this API key')
  });
  assert.notEqual(failure.failure_class, 'unknown');
  assert.equal(failure.repairable, false);
});

test('quota_exhausted is in TASK_FAILURE_DEFINITIONS, not unknown', () => {
  // The classifyTaskFailure function uses TASK_FAILURE_DEFINITIONS lookup
  // We can test indirectly by checking that codexResult failure_class maps correctly
  const failure = classifyTaskFailure({
    codexResult: { failure_class: 'quota_exhausted' }
  });
  assert.equal(failure.failure_class, 'quota_exhausted');
  assert.ok(failure.reason.length > 0);
});

test('rate_limited is in TASK_FAILURE_DEFINITIONS, not unknown', () => {
  const failure = classifyTaskFailure({
    codexResult: { failure_class: 'rate_limited' }
  });
  assert.equal(failure.failure_class, 'rate_limited');
  assert.ok(failure.reason.length > 0);
});

test('classifyFailure simple function also detects quota patterns', () => {
  // Test the simple classifyFailure function
  // Already imported at top: classifyFailure, classifyFailureStructured

  assert.equal(classifyFailure({ message: 'quota exceeded for model gpt-4' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'insufficient_quota error' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'rate limit exceeded' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'HTTP 429 Too Many Requests' }), 'rate_limited');
  assert.equal(classifyFailure({ message: 'billing limit reached' }), 'unknown');
});

test('classifyFailureStructured returns quota_wait nextStatusHint for quota_exceeded', () => {
  // Already imported at top: classifyFailure, classifyFailureStructured

  const result = classifyFailureStructured({ rateLimited: true, message: 'quota exceeded' });
  assert.equal(result.class, 'rate_limited');
  assert.equal(result.nextStatusHint, 'quota_wait');
  assert.equal(result.retryable, true);
  assert.equal(result.repairable, false);
});

test('classifyFailureStructured returns quota_wait for rate_limited input', () => {
  // Already imported at top: classifyFailure, classifyFailureStructured

  const result = classifyFailureStructured({ message: '429 too many requests' });
  assert.equal(result.class, 'rate_limited');
  assert.equal(result.nextStatusHint, 'quota_wait');
  assert.equal(result.retryable, true);
});

test('provider responses endpoint 404 is an actionable non-repairable blocker', () => {
  const message = 'ERROR unexpected status 404 Not Found: not found, url: http://www.9017i.cc:58901/v1/responses';

  assert.equal(classifyFailure({ message }), 'codex_transport_404');

  const structured = classifyFailureStructured({ message });
  assert.equal(structured.class, 'codex_transport_404');
  assert.equal(structured.retryable, false);
  assert.equal(structured.repairable, false);
  assert.equal(structured.nextStatusHint, 'blocked');

  const taskFailure = classifyTaskFailure({
    codexResult: {
      kind: 'codex_failed',
      summary: 'Codex execution failed (non-zero exit)',
      diagnostics: { raw_stderr_excerpt: message },
    },
  });
  assert.equal(taskFailure.failure_class, 'codex_transport_404');
  assert.equal(taskFailure.repairable, false);
  assert.equal(taskFailure.repair_strategy, 'fix_provider_endpoint');
});
