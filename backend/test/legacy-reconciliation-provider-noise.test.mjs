import test from 'node:test';
import assert from 'node:assert/strict';

import { isResolvedLegacyTerminalTask } from '../src/legacy-reconciliation.mjs';

test('metadata-only terminal worker records are treated as historical non-current records', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_metadata_only',
    result: {
      worker_error: { message: 'terminal metadata record' },
    },
  };

  assert.equal(isResolvedLegacyTerminalTask(task), true);
});

test('terminal records with completion evidence are treated as resolved legacy records', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_verified_legacy',
    result: {
      kind: 'codex_executed',
      changed_files: ['backend/src/done.mjs'],
      tests: 'node --test passed',
      commit: 'abc123',
      verification: { passed: true },
      integration: { status: 'branch_pushed' },
    },
  };

  assert.equal(isResolvedLegacyTerminalTask(task), true);
});

test('terminal records with code evidence but no completion evidence remain current blockers', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_code_evidence_missing_closure',
    result: {
      kind: 'codex_executed',
      changed_files: ['backend/src/dirty.mjs'],
      tests: 'node --test passed',
      acceptance_findings: [{ code: 'commit_missing', severity: 'blocker' }],
    },
  };

  assert.equal(isResolvedLegacyTerminalTask(task), false);
});
// ===========================================================================
// P0: Direct tests for isHistoricalProviderNoResultFailure covering all
// diagnostic text patterns — provider no-result failures must not block.
// ===========================================================================

import { isHistoricalProviderNoResultFailure } from '../src/legacy-reconciliation.mjs';

test('isHistoricalProviderNoResultFailure: result_missing failure_class is historical', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_hist_result_missing',
    result: {
      failure_class: 'result_missing',
      kind: 'codex_failed',
      summary: 'No result.json produced',
      diagnostics: {
        detected_reason: 'No changed files, no tests, no commit, no structured summary',
      },
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), true);
});

test('isHistoricalProviderNoResultFailure: codex_timeout failure_class is historical', () => {
  const task = {
    assignee: 'codex',
    status: 'timed_out',
    id: 'task_hist_timeout',
    result: {
      failure_class: 'codex_timeout',
      kind: 'codex_timeout',
      summary: 'Codex execution timed out',
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), true);
});

test('isHistoricalProviderNoResultFailure: noop true without evidence is historical', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_hist_noop',
    result: {
      kind: 'codex_executed',
      noop: true,
      summary: 'No changes needed',
      failure_class: 'result_missing',
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), true);
});

test('isHistoricalProviderNoResultFailure: codex_failed with no evidence is historical', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_hist_codex_failed',
    result: {
      kind: 'codex_failed',
      summary: 'Codex execution failed (non-zero exit)',
      failure_class: 'result_missing',
      diagnostics: {
        detected_reason: 'No changed files, no tests, no commit, no structured summary',
      },
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), true);
});

test('isHistoricalProviderNoResultFailure: failed with changed_files still blocks', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_still_blocks',
    result: {
      kind: 'codex_failed',
      changed_files: ['backend/src/dirty.mjs'],
      tests: 'node --test failed',
      summary: 'Codex execution failed with real changes',
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), false);
});

test('isHistoricalProviderNoResultFailure: failed with commit evidence still blocks', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_commit_blocks',
    result: {
      kind: 'codex_executed',
      commit: 'abc123',
      summary: 'Task produced a commit but failed verification',
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), false);
});

test('isHistoricalProviderNoResultFailure: failed with verification.failed still blocks', () => {
  const task = {
    assignee: 'codex',
    status: 'failed',
    id: 'task_verification_blocks',
    result: {
      kind: 'codex_executed',
      changed_files: ['src/test.mjs'],
      verification: { passed: false },
      summary: 'Verification failed',
    },
  };
  assert.equal(isHistoricalProviderNoResultFailure(task), false);
});

