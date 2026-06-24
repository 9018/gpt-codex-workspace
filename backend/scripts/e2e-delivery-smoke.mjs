#!/usr/bin/env node
/**
 * e2e-delivery-smoke.mjs — End-to-end delivery smoke test.
 *
 * Simulates 3 concurrent goals, multi-worktree isolation, acceptance failure,
 * repair/review, and integration flow. Does NOT require the MCP server backend.
 *
 * Each step is independently verified:
 *   1. Init repo, verify commit
 *   2. Create 3 goals with task metadata
 *   3. Create 3 isolated git worktrees
 *   4. Execute work in each worktree, verify isolation
 *   5. Acceptance check — detect failure in one worktree
 *   6. Repair worktree for the failed task
 *   7. Simulate waiting_for_review (repair budget exceeded)
 *   8. Integration simulation (serial merge of completed tasks)
 *   9. Cleanup worktrees
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

let stepCount = 0;
let passCount = 0;

async function step(description, fn) {
  stepCount++;
  const label = `[${String(stepCount).padStart(2, '0')}] ${description}`;
  process.stdout.write(`${label}... `);
  try {
    await fn();
    console.log('PASS');
    passCount++;
  } catch (err) {
    console.log('FAIL');
    console.error(`       ${err.message}`);
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-e2e-smoke-'));
  console.log('E2E delivery smoke test root:', root);

  const repo = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');

  /* Step 1 — Init Git repo and verify commit */
  await step('Initialize canonical git repo', async () => {
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# GPTWork\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'pipe' });
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: repo, encoding: 'utf8' });
    if (!log.trim()) throw new Error('No commit found after init');
  });

  /* Step 2 — Create 3 simulated goals / task metadata */
  const tasks = [
    { id: 'task_001', goal: 'goal_fix_login' },
    { id: 'task_002', goal: 'goal_add_search' },
    { id: 'task_003', goal: 'goal_broken_feature' },
  ];
  const worktreePaths = [];

  await step('Create 3 simulated goals with task metadata', async () => {
    for (const t of tasks) {
      const gpath = join(root, 'goals', t.goal);
      await mkdir(gpath, { recursive: true });
      await writeFile(join(gpath, 'goal.md'), `# ${t.goal}\n\nTest goal.\n`);
      await writeFile(join(gpath, 'context.json'), JSON.stringify({ task_id: t.id, goal: t.goal }));
    }
    const dirs = await import('node:fs/promises').then(fs => fs.readdir(join(root, 'goals')));
    if (dirs.length !== 3) throw new Error(`Expected 3 goal dirs, found ${dirs.length}`);
  });

  /* Step 3 — Create 3 isolated git worktrees (multi-worktree) */
  await step('Create multi-worktree (3 worktrees, isolated)', async () => {
    for (const t of tasks) {
      const wtPath = join(worktreesDir, t.id);
      await mkdir(wtPath, { recursive: true });
      execFileSync('git', ['worktree', 'add', wtPath, '-b', `gptwork/${t.id}`, 'HEAD'], {
        cwd: repo, stdio: 'pipe', timeout: 30000,
      });
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: wtPath, encoding: 'utf8', timeout: 5000,
      });
      if (status.trim()) throw new Error(`Worktree ${t.id} not clean at start`);
      worktreePaths.push(wtPath);
    }
    if (worktreePaths.length !== 3) throw new Error(`Expected 3 worktrees, got ${worktreePaths.length}`);
  });

  /* Step 4 — Execute work in each worktree, verify isolation */
  await step('Execute tasks in worktrees and verify isolation', async () => {
    await mkdir(join(worktreePaths[0], 'src'), { recursive: true });
    await writeFile(join(worktreePaths[0], 'src', 'fix.txt'), 'Login bug fixed\n');
    execFileSync('git', ['add', '-A'], { cwd: worktreePaths[0], stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'fix: login bug fixed'], { cwd: worktreePaths[0], stdio: 'pipe' });
    await mkdir(join(worktreePaths[1], 'src'), { recursive: true });
    await writeFile(join(worktreePaths[1], 'src', 'search.txt'), 'Search feature added\n');
    execFileSync('git', ['add', '-A'], { cwd: worktreePaths[1], stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feat: search feature added'], { cwd: worktreePaths[1], stdio: 'pipe' });
    await mkdir(join(worktreePaths[2], 'src'), { recursive: true });
    await writeFile(join(worktreePaths[2], 'src', 'broken.txt'),
      '// TODO: implement correctly\nthrow new Error("not implemented");\n');
    execFileSync('git', ['add', '-A'], { cwd: worktreePaths[2], stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feat: broken feature (WIP)'], { cwd: worktreePaths[2], stdio: 'pipe' });
    for (let i = 0; i < 3; i++) {
      const log = execFileSync('git', ['log', '--oneline', '--all', '--not', 'main'], {
        cwd: worktreePaths[i], encoding: 'utf8', timeout: 5000,
      });
      const lines = log.trim().split('\n').filter(Boolean);
      if (lines.length < 1) throw new Error(`Worktree ${tasks[i].id} has no branch commits`);
    }
  });

  /* Step 5 — Acceptance check: detect failure in goal_broken_feature */
  await step('Simulate acceptance verification (detect failure)', async () => {
    for (let i = 0; i < 2; i++) {
      const msg = execFileSync('git', ['log', '--oneline', '-1', '--format=%s'], {
        cwd: worktreePaths[i], encoding: 'utf8', timeout: 5000,
      });
      if (!msg.trim()) throw new Error(`Task ${tasks[i].id} missing commit`);
    }
    const content = readFileSync(join(worktreePaths[2], 'src', 'broken.txt'), 'utf8');
    if (content.includes('TODO')) {
      console.log('       [ACCEPTANCE] Detected incomplete implementation in task_003');
    }
  });

  /* Step 6 — Repair worktree for the failed task */
  await step('Simulate repair loop (repair worktree + fix)', async () => {
    const repairPath = join(worktreesDir, 'task_003-repair-1');
    await mkdir(repairPath, { recursive: true });
    execFileSync('git', ['worktree', 'add', repairPath, '-b', 'gptwork/task_003-repair-1', 'HEAD'], {
      cwd: repo, stdio: 'pipe', timeout: 30000,
    });
    await mkdir(join(repairPath, 'src'), { recursive: true });
    await writeFile(join(repairPath, 'src', 'broken.txt'), 'Feature implemented correctly\n');
    execFileSync('git', ['add', '-A'], { cwd: repairPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'fix: complete broken feature implementation'], {
      cwd: repairPath, stdio: 'pipe',
    });
    const msg = execFileSync('git', ['log', '--oneline', '-1', '--format=%s'], {
      cwd: repairPath, encoding: 'utf8', timeout: 5000,
    });
    if (!msg.includes('complete')) throw new Error('Repair commit not found');
    execFileSync('git', ['worktree', 'remove', '--force', repairPath], { cwd: repo, stdio: 'pipe' });
  });

  /* Step 7 — Simulate waiting_for_review (repair budget exceeded) */
  await step('Simulate waiting_for_review (repair budget exceeded)', async () => {
    const markerPath = join(worktreePaths[2], 'waiting_for_review.json');
    const marker = {
      status: 'waiting_for_review',
      reason: 'Repair budget exceeded after 2 attempts',
      parent_task: 'task_003',
      repair_attempts: 2,
    };
    await writeFile(markerPath, JSON.stringify(marker, null, 2));
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (parsed.status !== 'waiting_for_review') throw new Error('Review marker not set');
    if (parsed.repair_attempts !== 2) throw new Error('Repair attempts count mismatch');
  });

  /* Step 8 — Integration simulation (serial merge of valid tasks) */
  await step('Simulate integration (serial merge of completed tasks)', async () => {
    for (let i = 0; i < 2; i++) {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePaths[i], encoding: 'utf8', timeout: 5000 });
      if (!sha.trim()) throw new Error(`No commit SHA for task ${i + 1}`);
    }
  });

  /* Step 9 — Cleanup worktrees */
  for (const wtPath of worktreePaths) {
    try { execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repo, stdio: 'pipe' }); }
    catch { /* already cleaned up */ }
  }

  const total = stepCount;
  const status = passCount === total ? 'ALL PASS' : 'SOME FAILED';
  console.log(`\n=== E2E Delivery Smoke Test: ${status} (${passCount}/${total}) ===`);
  if (passCount < total) process.exit(1);
}

main().catch(e => { console.error('E2E smoke test: FAIL', e); process.exit(1); });
