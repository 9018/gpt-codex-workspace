import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isContractValidTerminalResult,
  normalizeTerminalResultCandidate,
} from '../src/codex-tui/session-terminalizer.mjs';

test('normalizes semantic finished result to contract-valid completed result', () => {
  const normalized = normalizeTerminalResultCandidate({
    status: 'finished',
    summary: 'durable completion',
    changed_files: ['.gptwork-canary/live-fix-verification.txt'],
    tests: ['file content verified'],
    commit: 'fdd5957',
    remote_head: 'none',
    warnings: [],
    followups: [],
    verification: { passed: true, commands: ['cat file', 'git status'] },
  });

  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.commit, 'fdd5957');
  assert.equal(isContractValidTerminalResult(normalized), true);
});
