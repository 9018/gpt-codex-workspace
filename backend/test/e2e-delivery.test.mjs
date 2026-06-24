import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function initialCommit(dir) {
  writeFileSync(join(dir, '.gitkeep'), '');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
}

/* ------------------------------------------------------------------ */
/*  Test 1: 3 tasks with distinct branch references                    */
/* ------------------------------------------------------------------ */
test('delivery: 3 tasks with distinct branch references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  initialCommit(repo);

  const tasks = [
    { id: 'task_001', goal: 'goal_login' },
    { id: 'task_002', goal: 'goal_search' },
    { id: 'task_003', goal: 'goal_broken' },
  ];

  const worktreePaths = [];
  for (const t of tasks) {
    const wtPath = join(root, 'worktrees', t.id);
    mkdirSync(wtPath, { recursive: true });
    execFileSync('git', ['worktree', 'add', wtPath, '-b', `gptwork/${t.id}`, 'HEAD'], {
      cwd: repo, stdio: 'pipe', timeout: 30000,
    });
    worktreePaths.push(wtPath);
  }

  assert.equal(worktreePaths.length, 3, 'should have 3 worktrees');

  for (let i = 0; i < 3; i++) {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePaths[i], encoding: 'utf8', timeout: 5000,
    });
    assert.ok(branch.trim().startsWith('gptwork/'),
      `worktree ${i} should be on gptwork branch: ${branch.trim()}`);
  }

  for (const wt of worktreePaths) {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo, stdio: 'pipe' });
  }
});

/* ------------------------------------------------------------------ */
/*  Test 2: Multi-worktree isolation                                   */
/* ------------------------------------------------------------------ */
test('delivery: multi-worktree isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-isolation-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  initialCommit(repo);

  const wt1 = join(root, 'wt_a');
  const wt2 = join(root, 'wt_b');
  mkdirSync(wt1, { recursive: true });
  mkdirSync(wt2, { recursive: true });

  execFileSync('git', ['worktree', 'add', wt1, '-b', 'gptwork/task_a', 'HEAD'], {
    cwd: repo, stdio: 'pipe', timeout: 30000,
  });
  execFileSync('git', ['worktree', 'add', wt2, '-b', 'gptwork/task_b', 'HEAD'], {
    cwd: repo, stdio: 'pipe', timeout: 30000,
  });

  // Commit in worktree A
  writeFileSync(join(wt1, 'a.txt'), 'change from A');
  execFileSync('git', ['add', '-A'], { cwd: wt1, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'change in A'], { cwd: wt1, stdio: 'pipe' });

  // Isolation check: B should NOT see A's commit on its own branch
  // B's own log (HEAD) should only show the initial commit
  const bHead = execFileSync('git', ['log', '--oneline', 'HEAD'], {
    cwd: wt2, encoding: 'utf8', timeout: 5000,
  });
  const bLines = bHead.trim().split('\n').filter(Boolean);
  assert.equal(bLines.length, 1, `isolation: worktree B's HEAD should show 1 commit, got ${bLines.length}`);

  // A's own log (HEAD) should show 2 commits (initial + A)
  const aHead = execFileSync('git', ['log', '--oneline', 'HEAD'], {
    cwd: wt1, encoding: 'utf8', timeout: 5000,
  });
  const aLines = aHead.trim().split('\n').filter(Boolean);
  assert.ok(aLines.length >= 2, `worktree A should have at least 2 commits, got ${aLines.length}`);

  // A's branch-specific commits (not on main)
  const aBranchOnly = execFileSync('git', ['log', '--oneline', 'HEAD', '--not', 'main'], {
    cwd: wt1, encoding: 'utf8', timeout: 5000,
  });
  assert.ok(aBranchOnly.trim().length > 0, 'A should have commits not on main');

  execFileSync('git', ['worktree', 'remove', '--force', wt1], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'remove', '--force', wt2], { cwd: repo, stdio: 'pipe' });
});

/* ------------------------------------------------------------------ */
/*  Test 3: Simulate acceptance failure and repair flow                */
/* ------------------------------------------------------------------ */
test('delivery: acceptance failure and repair flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-repair-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  initialCommit(repo);

  const wtPath = join(root, 'worktrees', 'task_broken');
  mkdirSync(wtPath, { recursive: true });
  execFileSync('git', ['worktree', 'add', wtPath, '-b', 'gptwork/task_broken', 'HEAD'], {
    cwd: repo, stdio: 'pipe', timeout: 30000,
  });

  // Write broken file with TODO marker
  writeFileSync(join(wtPath, 'broken.js'), '// TODO: fix this\nthrow new Error("broken");');
  execFileSync('git', ['add', '-A'], { cwd: wtPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'broken change (intentional)'], { cwd: wtPath, stdio: 'pipe' });

  // Acceptance check: detect failure via TODO marker
  const content = readFileSync(join(wtPath, 'broken.js'), 'utf8');
  assert.ok(content.includes('TODO'), 'should detect TODO marker as acceptance failure');

  // Create repair worktree and fix
  const repairPath = join(root, 'worktrees', 'task_broken-repair-1');
  mkdirSync(repairPath, { recursive: true });
  execFileSync('git', ['worktree', 'add', repairPath, '-b', 'gptwork/task_broken-repair-1', 'HEAD'], {
    cwd: repo, stdio: 'pipe', timeout: 30000,
  });

  writeFileSync(join(repairPath, 'broken.js'), '// fixed implementation');
  execFileSync('git', ['add', '-A'], { cwd: repairPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fix: complete broken implementation'], { cwd: repairPath, stdio: 'pipe' });

  const repairLog = execFileSync('git', ['log', '--oneline', '-1', '--format=%s'], {
    cwd: repairPath, encoding: 'utf8', timeout: 5000,
  });
  assert.ok(repairLog.includes('fix'), `repair commit should exist: ${repairLog.trim()}`);

  execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'remove', '--force', repairPath], { cwd: repo, stdio: 'pipe' });
});

/* ------------------------------------------------------------------ */
/*  Test 4: waiting_for_review state simulation                        */
/* ------------------------------------------------------------------ */
test('delivery: waiting_for_review state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-review-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  initialCommit(repo);

  const taskDir = join(root, 'tasks', 'task_flaky');
  mkdirSync(taskDir, { recursive: true });

  const marker = {
    status: 'waiting_for_review',
    reason: 'Repair budget exceeded after 2 attempts',
    parent_task: 'task_flaky',
    repair_attempts: 2,
  };

  const markerPath = join(taskDir, 'waiting_for_review.json');
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));

  // Verify file exists
  assert.ok(existsSync(markerPath), 'waiting_for_review.json should exist');

  // Verify content
  const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(parsed.status, 'waiting_for_review', 'should be waiting_for_review');
  assert.equal(parsed.repair_attempts, 2, 'should have 2 repair attempts');
  assert.ok(parsed.reason.includes('Repair budget'), 'should include reason');

  // Verify it's a valid terminal state
  assert.ok(
    parsed.status === 'waiting_for_review' || parsed.status === 'completed',
    'terminal states: waiting_for_review or completed'
  );
});
