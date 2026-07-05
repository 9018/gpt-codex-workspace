import assert from 'node:assert';
import { describe, it } from 'node:test';

// ---- Import the modules under test ----
import { normalizeOperationEvidence } from '../src/evidence/evidence-normalizer.mjs';
import { classifyCurrentBlockerTask } from '../src/current-blocker-policy.mjs';
import { reconcileBundle } from '../src/review/review-backlog-reconciler.mjs';

// -------------------------------------------------------------------------
// P0-MA20 Regression tests: verification evidence normalization & review cleanup
// -------------------------------------------------------------------------

describe('P0-MA20: verification evidence normalization', () => {

  // ── Case A: result.verification=null, but result.tests has commands ──
  it('Case A: normalizeOperationEvidence synthesizes verification from tests', () => {
    const result = {
      status: 'completed',
      summary: 'Fixed verification normalization',
      tests: 'check:syntax pass; check:imports pass; node --test test/task-finalizer.test.mjs 11/11 pass',
      changed_files: ['backend/src/evidence/evidence-normalizer.mjs'],
      verification: null,
    };
    const contract = {
      intent: { operation_kind: 'code_change' },
      requirements: { requires_commit: false },
    };
    const normalized = normalizeOperationEvidence({ result, contract });
    // Verification should be synthesized from tests
    assert.ok(normalized.verification, 'verification should exist');
    assert.strictEqual(normalized.verification.passed, true, 'verification.passed should be true');
    assert.ok(Array.isArray(normalized.verification.commands), 'verification.commands should be an array');
    assert.ok(normalized.verification.commands.length > 0, 'verification.commands should not be empty');
    assert.ok(normalized.verification.commands[0].cmd.includes('check:syntax'), 'command should include tests text');
  });

  // ── Case B: successor completed with verification, old task not blocking ──
  it('Case B: reconciliation resolves verification_missing when successor has verification', () => {
    const task = {
      id: 'task_stale_001',
      status: 'completed',
      result: { changed_files: ['test.js'] },
    };
    const bundle = {
      task_id: 'task_stale_001',
      status: 'waiting_for_review',
      result_summary: { status: 'completed', tests: '' },
      verification: { passed: null, status: 'missing', commands: [] },
      blockers: [{ code: 'verification_missing', severity: 'major', message: 'Verification commands not present' }],
      missing_evidence: [{ code: 'verification_missing', message: 'No verification evidence' }],
      integration: null,
    };
    const state = {
      tasks: [
        task,
        {
          id: 'task_successor_001',
          status: 'completed',
          repair_of_task_id: 'task_stale_001',  // successor is a child repair of stale task
          result: {
            status: 'completed',
            summary: 'successor fix',
            changed_files: ['fix.js'],
            commit: 'abc123',
            verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0, passed: true }] },
            integration: { status: 'integrated', merged: true, commit: 'abc123' },
          },
        },
      ],
      goals: [],
    };
    const result = reconcileBundle({ task, bundle, state });
    assert.ok(result.reconciled, 'should be reconciled via successor evidence');
    // Check reconciliation type includes successor
    const succType = result.reconciled_findings.find(f => f.code === 'reconciled_by_successor' || f.resolved_by === 'successor_repair');
    assert.ok(succType, 'should find successor reconciliation');
  });

  // ── Case C: changed_files=[] diagnostic/no-mutation + verification evidence ──
  it('Case C: changed_files=[] diagnostic no-mutation does not block when verification exists', () => {
    const task = {
      id: 'task_diag_001',
      status: 'completed',
      result: null,
    };
    const result = {
      status: 'completed',
      summary: 'Read-only diagnostics complete',
      tests: 'check:syntax pass; check:imports pass',
      changed_files: [],
      verification: null,
    };
    const decision = classifyCurrentBlockerTask({ ...task, result });
    // Should not block current work
    assert.strictEqual(decision.blocks_current_work, false,
      'diagnostic/no-mutation with tests should not block current work');
    assert.ok(['completed', 'resolved_by_options'].includes(decision.label),
      'label should be completed or resolved_by_options');
  });

  // ── Verify that null tests does not get synthesized verification ──
  it('preserves null verification when tests is missing', () => {
    const result = {
      status: 'completed',
      summary: 'No tests result',
      verification: null,
    };
    const contract = {
      intent: { operation_kind: 'code_change' },
      requirements: { requires_commit: false },
    };
    const normalized = normalizeOperationEvidence({ result, contract });
    assert.strictEqual(normalized.verification.passed, null, 'verification.passed should stay null');
    assert.strictEqual(normalized.verification.commands.length, 0, 'verification.commands should be empty');
  });

  // ── IsVerificationNormalized accepts tests evidence ──
  it('isVerificationNormalized returns true when tests exist', async () => {
    const { isVerificationNormalized: ivn } = await import('../src/current-blocker-policy.mjs');
    const result = {
      status: 'completed',
      summary: 'Some work',
      tests: 'npm test passed',
      changed_files: ['file.js'],
    };
    assert.ok(ivn(result), 'should be normalized with tests');
  });
});
