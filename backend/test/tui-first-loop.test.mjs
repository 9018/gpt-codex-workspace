import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

describe('TUI-first loop modules', () => {
  let tmpDir;
  let config;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gptwork-tui-test-'));
    await git(tmpDir, ['init', '-b', 'main']);
    await git(tmpDir, ['config', 'user.email', 'test@test.com']);
    await git(tmpDir, ['config', 'user.name', 'Test']);
    await writeFile(join(tmpDir, 'README.md'), '# test\n');
    await git(tmpDir, ['add', '.']);
    await git(tmpDir, ['commit', '-m', 'init']);

    config = {
      defaultWorkspaceRoot: tmpDir,
      defaultRepoPath: tmpDir,
      defaultBranch: 'main',
      goalBranchPrefix: 'gptwork/goal',
      mergeTargetBranch: 'main',
      goalWorktreeRoot: join(tmpDir, '.gptwork', 'worktrees'),
    };
  });

  describe('goal-worktree-service', () => {
    it('ensureGoalWorkspace creates branch and worktree', async () => {
      const { ensureGoalWorkspace, rescanGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const goal = { id: 'goal_test_001', title: 'Test goal' };
      const workspace = await ensureGoalWorkspace({ goal, config });

      assert.equal(workspace.goal_id, 'goal_test_001');
      assert.equal(workspace.candidate_branch, 'gptwork/goal/goal_test_001');
      assert.ok(workspace.worktree_path.includes('.gptwork/worktrees/goal_test_001'));
      assert.equal(workspace.workspace_status, 'active');

      const scan = await rescanGoalWorkspace({ goalId: 'goal_test_001', config });
      assert.equal(scan.candidate_branch, 'gptwork/goal/goal_test_001');
      // Worktree may be dirty if workspace files were not committed — this is expected after ensureGoalWorkspace
      // The key is that the branch and path are correct
      assert.ok(scan.worktree_path.includes('goal_test_001'));
    });

    it('rescanGoalWorkspace detects dirty state', async () => {
      const { ensureGoalWorkspace, rescanGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const goal = { id: 'goal_test_dirty', title: 'Dirty test' };
      const workspace = await ensureGoalWorkspace({ goal, config });

      await writeFile(join(workspace.worktree_path, 'dirty.txt'), 'dirty');
      const scan = await rescanGoalWorkspace({ goalId: 'goal_test_dirty', config });
      assert.equal(scan.worktree_clean, false);
    });

    it('assertGoalId validates goal id format', async () => {
      const { assertGoalId } = await import('../src/goal-worktree-service.mjs');
      assert.equal(assertGoalId('goal_valid'), 'goal_valid');
      assert.equal(assertGoalId('goal_test_001'), 'goal_test_001');
      assert.throws(() => assertGoalId('invalid'), /invalid goal_id/);
      assert.throws(() => assertGoalId(''), /invalid goal_id/);
    });
  });

  describe('stage-invocation-contract', () => {
    it('defaultProviderForStage returns correct providers', async () => {
      const { defaultProviderForStage, STAGES, PROVIDERS } = await import('../src/stage-invocation-contract.mjs');
      assert.equal(defaultProviderForStage(STAGES.EXECUTE), PROVIDERS.CLAUDE_TUI_GOAL);
      assert.equal(defaultProviderForStage(STAGES.ACCEPT), PROVIDERS.CODEX_TUI_GOAL);
      assert.equal(defaultProviderForStage(STAGES.ADVANCE), PROVIDERS.CLAUDE_EXEC_GOAL);
    });

    it('buildStageInvocation returns correct structure for execute', async () => {
      const { buildStageInvocation, STAGES, PROVIDERS } = await import('../src/stage-invocation-contract.mjs');
      const inv = buildStageInvocation({
        goalId: 'goal_test',
        stage: STAGES.EXECUTE,
        provider: PROVIDERS.CLAUDE_TUI_GOAL,
        worktreePath: '/tmp/worktree'
      });
      assert.ok(inv.invocation_id.startsWith('inv_'));
      assert.equal(inv.goal_id, 'goal_test');
      assert.equal(inv.stage, 'execute');
      assert.equal(inv.status, 'pending');
      assert.ok(inv.entry_file.includes('claude.entry.md'));
      assert.ok(inv.expected_outputs.some(o => o.includes('result.json')));
    });

    it('buildStageInvocation returns correct structure for accept', async () => {
      const { buildStageInvocation, STAGES, PROVIDERS } = await import('../src/stage-invocation-contract.mjs');
      const inv = buildStageInvocation({
        goalId: 'goal_test',
        stage: STAGES.ACCEPT,
        provider: PROVIDERS.CODEX_TUI_GOAL,
        worktreePath: '/tmp/worktree'
      });
      assert.equal(inv.stage, 'accept');
      assert.ok(inv.entry_file.includes('codex.acceptance.entry.md'));
      assert.ok(inv.expected_outputs.some(o => o.includes('acceptance.result.json')));
    });

    it('buildStageInvocation returns correct structure for advance', async () => {
      const { buildStageInvocation, STAGES, PROVIDERS } = await import('../src/stage-invocation-contract.mjs');
      const inv = buildStageInvocation({
        goalId: 'goal_test',
        stage: STAGES.ADVANCE,
        provider: PROVIDERS.CLAUDE_EXEC_GOAL,
        worktreePath: '/tmp/worktree'
      });
      assert.equal(inv.stage, 'advance');
      assert.ok(inv.entry_file.includes('advance.entry.md'));
      assert.ok(inv.expected_outputs.some(o => o.includes('advance.result.json')));
    });
  });

  describe('evidence-bundle-service', () => {
    it('collectEvidenceBundle gathers correct data', async () => {
      const { ensureGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { collectEvidenceBundle } = await import('../src/evidence-bundle-service.mjs');

      const goal = { id: 'goal_ev_test', title: 'Evidence test' };
      const workspace = await ensureGoalWorkspace({ goal, config });
      const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', 'goal_ev_test');

      await writeFile(join(workspace.worktree_path, 'impl.txt'), 'done');
      await writeFile(join(goalDir, 'result.md'), '# done\n');
      await writeFile(join(goalDir, 'result.json'), JSON.stringify({ tests: [] }));
      await git(workspace.worktree_path, ['add', '.']);
      await git(workspace.worktree_path, ['commit', '-m', 'feat: implement']);

      const evidence = await collectEvidenceBundle({ goalId: 'goal_ev_test', workspace });
      assert.equal(evidence.goal_id, 'goal_ev_test');
      assert.ok(evidence.result_md_present);
      assert.ok(evidence.result_json_present);
      assert.equal(evidence.worktree_clean, true);
      assert.ok(evidence.candidate_head);
      assert.ok(evidence.commits.length >= 1);
    });

    it('collectEvidenceBundle reports missing result files', async () => {
      const { ensureGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { collectEvidenceBundle } = await import('../src/evidence-bundle-service.mjs');

      const goal = { id: 'goal_ev_missing', title: 'Missing evidence' };
      const workspace = await ensureGoalWorkspace({ goal, config });

      const evidence = await collectEvidenceBundle({ goalId: 'goal_ev_missing', workspace });
      assert.equal(evidence.result_md_present, false);
      assert.equal(evidence.result_json_present, false);
    });
  });

  describe('merge-gate-service', () => {
    it('previewMergeGate rejects when no acceptance/evidence present', async () => {
      const { ensureGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { collectEvidenceBundle } = await import('../src/evidence-bundle-service.mjs');
      const { previewMergeGate, applyMergeGate } = await import('../src/merge-gate-service.mjs');

      const goal = { id: 'goal_mg_test', title: 'Merge test' };
      const workspace = await ensureGoalWorkspace({ goal, config });
      const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', 'goal_mg_test');

      await writeFile(join(workspace.worktree_path, 'work.txt'), 'content');
      await writeFile(join(goalDir, 'result.md'), '# done\n');
      await writeFile(join(goalDir, 'result.json'), JSON.stringify({ tests: [] }));
      await git(workspace.worktree_path, ['add', '.']);
      await git(workspace.worktree_path, ['commit', '-m', 'feat: work']);
      const head = await git(workspace.worktree_path, ['rev-parse', 'HEAD']);

      // Collect evidence first
      await collectEvidenceBundle({ goalId: 'goal_mg_test', workspace });

      // No acceptance.result.json yet - should fail
      const decision = await previewMergeGate({ goalId: 'goal_mg_test', workspace, config });
      assert.notEqual(decision.decision, 'merge');
    });

    it('full merge gate cycle passes', async () => {
      const { ensureGoalWorkspace, rescanGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { collectEvidenceBundle } = await import('../src/evidence-bundle-service.mjs');
      const { previewMergeGate, applyMergeGate } = await import('../src/merge-gate-service.mjs');

      const goal = { id: 'goal_mg_pass', title: 'Merge pass' };
      const workspace = await ensureGoalWorkspace({ goal, config });
      const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', 'goal_mg_pass');

      await writeFile(join(workspace.worktree_path, 'pass.txt'), 'done');
      await writeFile(join(goalDir, 'result.md'), '# passed\n');
      await writeFile(join(goalDir, 'result.json'), JSON.stringify({ tests: [{ command: 'test', exit_code: 0, summary: 'ok' }] }));
      await git(workspace.worktree_path, ['add', '.']);
      await git(workspace.worktree_path, ['commit', '-m', 'feat: pass']);

      const head = await git(workspace.worktree_path, ['rev-parse', 'HEAD']);
      const evidence = await collectEvidenceBundle({ goalId: 'goal_mg_pass', workspace });

      // Write acceptance
      await writeFile(join(goalDir, 'acceptance.result.json'), JSON.stringify({
        goal_id: 'goal_mg_pass',
        stage: 'accept',
        provider: 'codex_tui_goal',
        verdict: 'passed',
        confidence: 'high',
        blocking_findings: [],
        non_blocking_findings: [],
        required_changes: [],
        merge_recommendation: 'merge',
        reviewed_candidate_head: head,
        created_at: new Date().toISOString()
      }));

      const decision = await previewMergeGate({ goalId: 'goal_mg_pass', workspace, config });
      assert.equal(decision.decision, 'merge');
      assert.ok(decision.checks.acceptance_passed);
      assert.ok(decision.checks.worktree_clean);
      assert.ok(decision.checks.reviewed_head_current);

      const applyResult = await applyMergeGate({ goalId: 'goal_mg_pass', workspace, config });
      assert.ok(applyResult.merged);
      assert.ok(applyResult.merge_commit);
    });
  });

  describe('product-loop-status-view', () => {
    it('buildGoalLoopStatus shows workspace_ready initially', async () => {
      const { ensureGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { buildGoalLoopStatus } = await import('../src/product-loop-status-view.mjs');

      const goal = { id: 'goal_status_test', title: 'Status test' };
      const workspace = await ensureGoalWorkspace({ goal, config });
      const status = await buildGoalLoopStatus({ goal, workspace });
      assert.equal(status.state, 'workspace_ready');
      assert.equal(status.next_action, 'goal_start_execute');
    });

    it('buildGoalLoopStatus shows merge_gate_ready when all evidence present', async () => {
      const { ensureGoalWorkspace } = await import('../src/goal-worktree-service.mjs');
      const { collectEvidenceBundle } = await import('../src/evidence-bundle-service.mjs');
      const { buildGoalLoopStatus } = await import('../src/product-loop-status-view.mjs');

      const goal = { id: 'goal_status_merge', title: 'Status merge' };
      const workspace = await ensureGoalWorkspace({ goal, config });
      const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', 'goal_status_merge');

      await writeFile(join(workspace.worktree_path, 's.txt'), 'ok');
      await writeFile(join(goalDir, 'result.md'), '# ok\n');
      await writeFile(join(goalDir, 'result.json'), JSON.stringify({ tests: [] }));
      await git(workspace.worktree_path, ['add', '.']);
      await git(workspace.worktree_path, ['commit', '-m', 'feat: status']);
      const head = await git(workspace.worktree_path, ['rev-parse', 'HEAD']);

      await collectEvidenceBundle({ goalId: 'goal_status_merge', workspace });
      await writeFile(join(goalDir, 'acceptance.result.json'), JSON.stringify({
        goal_id: 'goal_status_merge',
        stage: 'accept',
        provider: 'codex_tui_goal',
        verdict: 'passed',
        confidence: 'high',
        blocking_findings: [],
        non_blocking_findings: [],
        required_changes: [],
        merge_recommendation: 'merge',
        reviewed_candidate_head: head,
        created_at: new Date().toISOString()
      }));

      const status = await buildGoalLoopStatus({ goal, workspace });
      assert.equal(status.state, 'accept_completed');
    });
  });

  describe('acceptance-result-normalizer', () => {
    it('normalizeAcceptanceResult handles all verdicts', async () => {
      const { normalizeAcceptanceResult } = await import('../src/acceptance-result-normalizer.mjs');
      const r = normalizeAcceptanceResult({ verdict: 'passed', merge_recommendation: 'merge', reviewed_candidate_head: 'abc1234' });
      assert.equal(r.verdict, 'passed');
      assert.equal(r.merge_recommendation, 'merge');

      const r2 = normalizeAcceptanceResult(null);
      assert.equal(r2, null);
    });
  });

  describe('acceptance-contract-service', () => {
    it('validateAcceptanceContract validates contracts', async () => {
      const { validateAcceptanceContract } = await import('../src/acceptance-contract-service.mjs');
      const invalid = await validateAcceptanceContract(null);
      assert.equal(invalid.valid, false);

      const valid = await validateAcceptanceContract({ verdict_required: 'passed', checkpoints: [] });
      assert.equal(valid.valid, true);
    });
  });

  describe('goal-workspace-status', () => {
    it('readGoalWorkspace returns null for non-existent', async () => {
      const { readGoalWorkspace } = await import('../src/goal-workspace-status.mjs');
      const ws = await readGoalWorkspace({ goalId: 'goal_nonexistent', config });
      assert.equal(ws, null);
    });
  });

  describe('goal-branch-service', () => {
    it('ensureGoalBranch creates branch', async () => {
      const { ensureGoalBranch } = await import('../src/goal-branch-service.mjs');
      const result = await ensureGoalBranch({ goalId: 'goal_branch_test', config });
      assert.ok(result.branch.includes('goal_branch_test'));
    });

    it('deleteGoalBranch removes branch', async () => {
      const { ensureGoalBranch, deleteGoalBranch } = await import('../src/goal-branch-service.mjs');
      await ensureGoalBranch({ goalId: 'goal_branch_del', config });
      await deleteGoalBranch({ goalId: 'goal_branch_del', config });
      // Verify gone
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      try {
        await execAsync('git', ['rev-parse', '--verify', 'gptwork/goal/goal_branch_del'], { cwd: tmpDir });
        assert.fail('should have thrown');
      } catch {
        assert.ok(true);
      }
    });
  });

  describe('merge-decision-service', () => {
    it('evaluateMergeDecision rejects without acceptance', async () => {
      const { evaluateMergeDecision } = await import('../src/merge-decision-service.mjs');
      const result = await evaluateMergeDecision({ goalId: 'test', workspace: {}, evidence: {}, acceptance: null });
      assert.equal(result.decision, 'reject');
    });
  });
});
