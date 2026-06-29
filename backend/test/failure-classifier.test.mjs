import test from 'node:test';
import assert from 'node:assert/strict';

import { canRetryTask, classifyTaskFailure } from '../src/failure-classifier.mjs';

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
