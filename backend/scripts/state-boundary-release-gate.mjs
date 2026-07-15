#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const backendRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const reportIndex = args.indexOf('--json-report');
const reportPath = reportIndex >= 0 ? resolve(backendRoot, args[reportIndex + 1]) : null;
const skipTests = args.includes('--skip-tests');
const checks = [];

function add(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
}

function run(name, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: backendRoot, encoding: 'utf8', env: process.env });
  add(name, result.status === 0, (result.stdout || result.stderr || '').trim().slice(-4000));
}

const protectedModules = [
  'src/tool-groups/codex-tui-tools-group.mjs',
  'src/tool-groups/codex-exec-tools-group.mjs',
  'src/providers/codex-tui-execution-provider.mjs',
  'src/providers/codex-exec-execution-provider.mjs',
  'src/executions/execution-runtime-service.mjs',
];
const directWrite = /\b(?:task|item)\.status\s*=/g;
const violations = [];
for (const relative of protectedModules) {
  const path = join(backendRoot, relative);
  try {
    await access(path);
    const code = await readFile(path, 'utf8');
    const matches = [...code.matchAll(directWrite)];
    for (const match of matches) {
      const line = code.slice(0, match.index).split('\n').length;
      violations.push(`${relative}:${line}`);
    }
  } catch {
    // Optional provider modules may not exist in older layouts.
  }
}
add('protected modules have no direct task status writes', violations.length === 0, violations.join(', '));

run('syntax', process.execPath, ['scripts/check-syntax.mjs']);
run('imports', process.execPath, ['-e', 'Promise.all([import("./src/executions/execution-runtime-service.mjs"),import("./src/tool-groups/codex-tui-tools-group.mjs"),import("./src/runtime-watch-diagnostics.mjs")]).catch(e=>{console.error(e);process.exit(1)})']);

if (!skipTests) {
  run('targeted state-boundary tests', process.execPath, [
    '--test',
    'test/task-transition-matrix.test.mjs',
    'test/task-transition-service.test.mjs',
    'test/full-tui-tool-transition.test.mjs',
    'test/full-runtime-wiring.test.mjs',
    'test/runtime-reconciler-stale-tasks-transition.test.mjs',
    'test/runtime-watch-diagnostics.test.mjs',
  ]);
}

const verdict = checks.every((check) => check.passed) ? 'GO' : 'NO-GO';
const report = {
  schema_version: 'gptwork.state_boundary_release_gate.v1',
  generated_at: new Date().toISOString(),
  verdict,
  checks,
};
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(`STATE_BOUNDARY_GATE: ${verdict}`);
for (const check of checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail.split('\n').at(-1)}` : ''}`);
process.exitCode = verdict === 'GO' ? 0 : 1;
