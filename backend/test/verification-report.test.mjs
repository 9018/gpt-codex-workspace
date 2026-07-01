import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commandFingerprint,
  isVerificationReportReusable,
  verificationReportToEvidence,
} from '../src/verification-report.mjs';

function report(overrides = {}) {
  return {
    schema_version: 1,
    profile: 'fast',
    mode: 'fast',
    completed_at: '2026-06-30T00:00:00.000Z',
    repo: { head: 'abc123', dirty: false },
    passed: true,
    steps: [
      {
        name: 'check:imports',
        cmd: 'npm',
        args: ['run', 'check:imports'],
        cwd: '/repo/backend',
        exit_code: 0,
        signal: null,
        duration_ms: 25,
        stdout_tail: 'imports ok',
        stderr_tail: '',
        passed: true,
      },
    ],
    failures: [],
    ...overrides,
  };
}

test('commandFingerprint normalizes string and argv commands', () => {
  assert.equal(commandFingerprint('npm run check:imports'), commandFingerprint({ cmd: 'npm', args: ['run', 'check:imports'] }));
  assert.equal(commandFingerprint({ cmd: 'npm', args: ['run', 'check:imports'], cwd: '/repo/backend' }), 'npm run check:imports');
});

test('isVerificationReportReusable accepts matching passed report with required commands', () => {
  const reusable = isVerificationReportReusable(report(), {
    repoHead: 'abc123',
    profile: 'fast',
    requiredCommands: ['npm run check:imports'],
    maxAgeMs: 60_000,
    now: () => Date.parse('2026-06-30T00:00:30.000Z'),
  });

  assert.deepEqual(reusable, {
    reusable: true,
    reason: 'reusable',
    profile: 'fast',
    head: 'abc123',
    matched_commands: ['npm run check:imports'],
  });
});

test('isVerificationReportReusable rejects head mismatch', () => {
  const reusable = isVerificationReportReusable(report(), {
    repoHead: 'def456',
    profile: 'fast',
    requiredCommands: ['npm run check:imports'],
  });

  assert.equal(reusable.reusable, false);
  assert.equal(reusable.reason, 'head_mismatch');
  assert.equal(reusable.expected_head, 'def456');
  assert.equal(reusable.report_head, 'abc123');
});

test('isVerificationReportReusable rejects failed report', () => {
  const reusable = isVerificationReportReusable(report({ passed: false }), {
    repoHead: 'abc123',
    profile: 'fast',
    requiredCommands: ['npm run check:imports'],
  });

  assert.equal(reusable.reusable, false);
  assert.equal(reusable.reason, 'report_failed');
});

test('isVerificationReportReusable rejects missing required command', () => {
  const reusable = isVerificationReportReusable(report(), {
    repoHead: 'abc123',
    profile: 'fast',
    requiredCommands: ['npm test'],
    now: () => Date.parse('2026-06-30T00:00:30.000Z'),
  });

  assert.equal(reusable.reusable, false);
  assert.equal(reusable.reason, 'missing_required_command');
  assert.deepEqual(reusable.missing_commands, ['npm test']);
});

test('verificationReportToEvidence preserves verifier command shape', () => {
  const commands = verificationReportToEvidence(report()).commands;

  assert.deepEqual(commands, [
    {
      cmd: 'npm run check:imports',
      exit_code: 0,
      stdout_tail: 'imports ok',
      stderr_tail: '',
      reused: true,
      source: 'verification_report',
      name: 'check:imports',
      duration_ms: 25,
    },
  ]);
});
