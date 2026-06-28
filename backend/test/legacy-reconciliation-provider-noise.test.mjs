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
