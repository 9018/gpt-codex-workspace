import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isContractValidTerminalResult,
  normalizeTerminalResultCandidate,
  recoverTerminalResultFromEvidence,
  terminalizeCodexTuiSession,
} from '../src/codex-tui/session-terminalizer.mjs';
import { createCodexTuiSessionStore } from '../src/codex-tui-session-store.mjs';

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

test('recovers completed result from marker + partial when result.json is missing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'tui-terminal-recover-'));
  const goalId = 'goal_recover_1';
  const goalDir = join(workspaceRoot, '.gptwork', 'goals', goalId);
  const markerRel = '.gptwork/tmp/tui-loop-canary10-demo.txt';
  await mkdir(goalDir, { recursive: true });
  await mkdir(join(workspaceRoot, '.gptwork', 'tmp'), { recursive: true });
  await writeFile(join(workspaceRoot, markerRel), 'tui-loop-ok demo\n');
  await writeFile(join(goalDir, 'result.partial.json'), JSON.stringify({
    status: 'running',
    phase: 'finished',
    summary: 'marker written for tui-loop-canary10-demo',
    changed_files: [markerRel],
    verification: { passed: true, commands: [] },
  }));
  await writeFile(join(goalDir, 'acceptance.contract.json'), JSON.stringify({
    profile: 'noop',
    must_have_files: [markerRel],
    requirements: { requires_commit: false, requires_integration: false },
  }));

  const recovered = await recoverTerminalResultFromEvidence({
    workspaceRoot,
    goalId,
    event: { source: 'pty-exit', exit_code: 0 },
  });

  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.verification.passed, true);
  assert.equal(isContractValidTerminalResult(recovered), true);
  assert.ok(Array.isArray(recovered.marker_files));
  assert.ok(recovered.marker_files.includes(markerRel));
});


test('terminalizeCodexTuiSession does not fail-closed when marker evidence exists', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'tui-term-session-'));
  const goalId = 'goal_marker_2';
  const taskId = 'task_marker_2';
  const sessionId = `${goalId}_${taskId}`;
  const goalDir = join(workspaceRoot, '.gptwork', 'goals', goalId);
  const markerRel = '.gptwork/tmp/tui-loop-canary10-y.txt';
  await mkdir(goalDir, { recursive: true });
  await mkdir(join(workspaceRoot, '.gptwork', 'tmp'), { recursive: true });
  await writeFile(join(workspaceRoot, markerRel), 'tui-loop-ok y\n');
  await writeFile(join(goalDir, 'acceptance.contract.json'), JSON.stringify({
    profile: 'noop',
    must_have_files: [markerRel],
    requirements: { requires_commit: false, requires_integration: false },
  }));
  const store = createCodexTuiSessionStore({ workspaceRoot });
  await store.createSession({
    sessionId,
    taskId,
    goalId,
    cwd: workspaceRoot,
    repoLockId: 'lock1',
    metadata: { workspace_root: workspaceRoot, session_store_root: workspaceRoot },
  });
  const updated = await terminalizeCodexTuiSession({
    sessionId,
    store,
    event: { source: 'node-pty-exit', exit_code: 0 },
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.result_status, 'completed');
  const { readFile } = await import('node:fs/promises');
  const result = JSON.parse(await readFile(join(goalDir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.passed, true);
});
