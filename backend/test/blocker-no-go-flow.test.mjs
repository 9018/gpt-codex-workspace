import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('BLOCKER → NO-GO Release Semantics', () => {
  let classifyBlockersSummary;
  let CURRENT_WORK_DECISION_LABELS;

  before(async () => {
    const mod = await import('../src/current-blocker-policy.mjs');
    classifyBlockersSummary = mod.classifyBlockersSummary;
    CURRENT_WORK_DECISION_LABELS = mod.CURRENT_WORK_DECISION_LABELS;
  });

  it('classifyBlockersSummary returns a structured result', () => {
    const result = classifyBlockersSummary([]);
    assert.ok(result);
    assert.equal(typeof result, 'object');
    assert.ok('hasBlockers' in result);
    assert.ok('blockerCount' in result);
    assert.ok('blockers' in result);
    assert.ok(Array.isArray(result.blockers));
  });

  it('empty task list produces no blockers', () => {
    const result = classifyBlockersSummary([]);
    assert.equal(result.hasBlockers, false);
    assert.equal(result.blockerCount, 0);
    assert.equal(result.blockers.length, 0);
  });

  it('null/undefined task list produces no blockers', () => {
    const result1 = classifyBlockersSummary(null);
    assert.equal(result1.hasBlockers, false);
    const result2 = classifyBlockersSummary(undefined);
    assert.equal(result2.hasBlockers, false);
  });

  it('completed task with passing verification is not a blocker', () => {
    const tasks = [{
      id: 'task_1',
      status: 'completed',
      result: {
        status: 'completed',
        verification: { passed: true, commands: [{ cmd: 'test', exit_code: 0 }] },
      },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.equal(result.hasBlockers, false);
    assert.equal(result.blockerCount, 0);
  });

  it('failed task with no remediation is a blocker', () => {
    const tasks = [{
      id: 'task_1',
      status: 'failed',
      result: {
        status: 'failed',
        verification: { passed: false, commands: [] },
      },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.ok(result.hasBlockers);
    assert.ok(result.blockerCount >= 1);
    assert.ok(result.blockers.some(b => b.task_id === 'task_1'));
  });

  it('active execution tasks are blockers', () => {
    const tasks = [{
      id: 'task_running',
      status: 'running',
      result: { status: 'running' },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.ok(result.hasBlockers);
    const activeBlocker = result.blockers.find(b => b.task_id === 'task_running');
    assert.ok(activeBlocker);
    assert.ok(activeBlocker.isBlocker);
    assert.ok(activeBlocker.label);
  });

  it('waiting_for_integration tasks are blockers', () => {
    const tasks = [{
      id: 'task_integ',
      status: 'waiting_for_integration',
      result: { status: 'completed', verification: { passed: true, commands: [{ cmd: 'test', exit_code: 0 }] } },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.ok(result.hasBlockers);
    const integBlocker = result.blockers.find(b => b.task_id === 'task_integ');
    assert.ok(integBlocker);
    assert.ok(integBlocker.isBlocker);
    assert.equal(integBlocker.label, CURRENT_WORK_DECISION_LABELS.INTEGRATION);
  });

  it('report includes noGo verdict from blocker state', () => {
    const tasks = [{
      id: 'task_blocked',
      status: 'failed',
      result: { status: 'failed', verification: { passed: false, commands: [] } },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.ok(result.hasBlockers);
    assert.equal(result.verdict, 'NO-GO');
  });

  it('report includes GO verdict when no blockers', () => {
    const tasks = [{
      id: 'task_ok',
      status: 'completed',
      result: { status: 'completed', verification: { passed: true, commands: [{ cmd: 'test', exit_code: 0 }] } },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.equal(result.hasBlockers, false);
    assert.equal(result.verdict, 'GO');
  });

  it('blockers have structured detail for downstream consumption', () => {
    const tasks = [{
      id: 'task_b1',
      status: 'waiting_for_integration',
      result: { status: 'completed', verification: { passed: true, commands: [{ cmd: 'test', exit_code: 0 }] } },
    }, {
      id: 'task_b2',
      status: 'running',
      result: { status: 'running' },
    }];
    const result = classifyBlockersSummary(tasks);
    assert.ok(result.hasBlockers);
    assert.ok(result.blockerCount >= 2);
    for (const blocker of result.blockers) {
      assert.ok(blocker.task_id);
      assert.ok(blocker.status);
      assert.ok(blocker.label);
      assert.equal(typeof blocker.isBlocker, 'boolean');
    }
  });
});
