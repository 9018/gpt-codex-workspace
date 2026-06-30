#!/usr/bin/env node
/**
 * release-delivery-check.mjs — Release gate for delivery system.
 * ESM module. Runs from backend/ root.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const DEFAULT_TIMEOUT_MS = 180_000;
const FAST_TIMEOUT_MS = 180_000;

function tail(value, max = 2000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runGit(execFileSync, args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function repoInfo(execFileSync, backendRoot) {
  const root = runGit(execFileSync, ['rev-parse', '--show-toplevel'], backendRoot) || resolve(backendRoot, '..');
  const status = runGit(execFileSync, ['status', '--porcelain'], root);
  return {
    root,
    head: runGit(execFileSync, ['rev-parse', 'HEAD'], root) || null,
    branch: runGit(execFileSync, ['branch', '--show-current'], root) || null,
    dirty: status.length > 0,
  };
}

function changedFiles(execFileSync, repoRoot, base) {
  if (!base) return [];
  const output = runGit(execFileSync, ['diff', `${base}..HEAD`, '--name-only'], repoRoot);
  return output ? output.split('\n').filter(Boolean) : [];
}

function isDocsFile(file) {
  return /(^|\/)README(\.|$)/i.test(file) || /(^|\/)docs\//.test(file) || /\.(md|mdx|txt)$/i.test(file);
}

function touchesCore(file) {
  return /(^backend\/)?(scripts\/release-delivery-check\.mjs|src\/(codex-worker|worker|goal-queue|worker-queue|task-final|delivery-result-recovery|task-verifier|acceptance-agent)|test\/)/.test(file);
}

function selectMode({ fast, profile, files }) {
  if (profile === 'fast' || fast) return { mode: 'fast', effectiveProfile: 'fast' };
  if (profile !== 'changed') return { mode: 'full', effectiveProfile: 'full' };
  if (files.length === 0 || files.every(isDocsFile)) return { mode: 'changed', effectiveProfile: 'docs' };
  if (files.some(touchesCore)) return { mode: 'changed', effectiveProfile: 'fast' };
  return { mode: 'changed', effectiveProfile: 'changed' };
}

function makeChangedSteps(files) {
  const jsFiles = files.filter((file) => /\.(mjs|js|cjs)$/i.test(file)).map((file) => file.replace(/^backend\//, ''));
  const steps = [];
  if (jsFiles.length > 0) {
    steps.push({ name: 'changed syntax files', cmd: 'node', args: ['scripts/check-syntax.mjs', '--files', jsFiles.join('\n')], timeout: 30_000 });
  }
  steps.push({ name: 'check:imports', cmd: 'npm', args: ['run', 'check:imports'] });
  return steps;
}

async function writeJsonReport(path, report) {
  if (!path) return;
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[release-delivery-check] json report: ${absolutePath}`);
}

async function main() {
  const { execFileSync } = await import("node:child_process");
  const fast = process.argv.includes('--fast');
  const profile = argValue('--profile') || (fast ? 'fast' : 'full');
  const jsonReportPath = argValue('--json-report');
  const base = argValue('--base');

  // Run from backend/ root, NOT from scripts/ directory
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const backendRoot = join(scriptsDir, '..');

  const fullSteps = [
    { name: "check:syntax", cmd: "npm", args: ["run", "check:syntax"] },
    { name: "check:imports", cmd: "npm", args: ["run", "check:imports"] },
    { name: "productization P0 tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/productization-p0.test.mjs",
    ]},
    { name: "P0 queue/blocker tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/worker-queue-counts.test.mjs",
      "test/current-blocker-policy.test.mjs",
      "test/result-shape-classifier.test.mjs",
    ]},
    { name: "task verifier tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/task-verifier.test.mjs",
    ]},
    { name: "runtime workflow card tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/card-view-model.test.mjs",
      "test/runtime-status-tools-group.test.mjs",
      "test/workflow-tools-group.test.mjs",
    ]},
    { name: "delivery-contracts test", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/delivery-contracts.test.mjs",
      "test/delivery-spec-compat.test.mjs",
    ]},
    { name: "worktree lifecycle tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/task-worktree-manager.test.mjs",
      "test/task-repo-resolution.test.mjs",
    ]},
    { name: "queue & lock tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/goal-queue.test.mjs",
      "test/repo-lock.test.mjs",
    ]},
    { name: "acceptance & context tests", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/acceptance-policy.test.mjs",
      "test/context-index.test.mjs",
      "test/acceptance-agent.test.mjs",
    ]},
    { name: "acceptance-agent runtime test", cmd: "node", args: [
      "--input-type=module", "-e",
      "import { runAcceptanceAgent } from \"./src/acceptance-agent.mjs\"; const r=await runAcceptanceAgent({task:{id:\"t\"},result:{status:\"completed\",summary:\"ok\",changed_files:[],verification:{commands:[\"true\"],passed:true}},repoPath:process.cwd(),evidence:{result_json_valid:true,result_summary:\"ok\",changed_files:[],git_status:\"clean\",verification_log_exists:true,commit_exists:true}}); if(!r.passed)throw new Error(\"acceptance-agent runtime failed: \"+r.status); console.log(\"runtime PASS: findings=\"+r.findings.length);",
    ]},
    { name: "E2E delivery test", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/e2e-delivery.test.mjs",
    ]},
  ];

  const fastSyntaxFiles = [
    "scripts/release-delivery-check.mjs",
    "src/worker-queue-counts.mjs",
    "src/current-blocker-policy.mjs",
    "src/result-shape-classifier.mjs",
    "src/task-verifier.mjs",
    "src/card-runtime-cards.mjs",
    "src/card-view-model.mjs",
    "src/project-context-service.mjs",
    "src/tool-groups/runtime-status-tools-group.mjs",
    "src/tool-groups/workflow-tools-group.mjs",
    "test/productization-p0.test.mjs",
    "test/worker-queue-counts.test.mjs",
    "test/current-blocker-policy.test.mjs",
    "test/result-shape-classifier.test.mjs",
    "test/task-verifier.test.mjs",
    "test/card-view-model.test.mjs",
    "test/runtime-status-tools-group.test.mjs",
    "test/workflow-tools-group.test.mjs",
  ];

  const fastSteps = [
    { name: "fast syntax core files", cmd: "node", args: [
      "scripts/check-syntax.mjs", "--files", fastSyntaxFiles.join("\n"),
    ], timeout: 30_000 },
    ...fullSteps.filter((step) => [
      "check:imports",
      "productization P0 tests",
      "P0 queue/blocker tests",
      "task verifier tests",
      "runtime workflow card tests",
    ].includes(step.name)),
  ];
  const repo = repoInfo(execFileSync, backendRoot);
  const files = profile === 'changed' ? changedFiles(execFileSync, repo.root, base) : [];
  const selection = selectMode({ fast, profile, files });
  const docsSteps = [{ name: 'check:imports', cmd: 'npm', args: ['run', 'check:imports'] }];
  let steps = selection.effectiveProfile === 'fast' ? fastSteps : fullSteps;
  if (profile === 'changed' && selection.effectiveProfile === 'changed') steps = makeChangedSteps(files);
  if (profile === 'changed' && selection.effectiveProfile === 'docs') steps = docsSteps;
  const failures = [];
  const stepReports = [];
  const startedAt = new Date();
  const startedMs = Date.now();
  console.log(`[release-delivery-check] mode=${selection.mode} profile=${selection.effectiveProfile} steps=${steps.length}`);
  for (const step of steps) {
    const timeout = step.timeout || (fast ? FAST_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    console.log(`[RUN] ${step.name} timeout=${formatDuration(timeout)}`);
    try {
      const stdout = execFileSync(step.cmd, step.args, { cwd: backendRoot, stdio: "pipe", timeout, encoding: "utf8" });
      const stepReport = {
        name: step.name,
        cmd: step.cmd,
        args: step.args || [],
        cwd: backendRoot,
        timeout_ms: timeout,
        exit_code: 0,
        signal: null,
        duration_ms: Date.now() - started,
        stdout_tail: tail(stdout),
        stderr_tail: '',
        passed: true,
      };
      stepReports.push(stepReport);
      console.log(`[PASS] ${step.name} duration=${formatDuration(Date.now() - started)}`);
      if (stdout.trim()) console.log(tail(stdout, 1200));
    } catch (err) {
      const failure = {
        name: step.name,
        cmd: step.cmd,
        args: step.args || [],
        cwd: backendRoot,
        timeout_ms: timeout,
        exit_code: typeof err.status === 'number' ? err.status : (typeof err.code === 'number' ? err.code : 1),
        signal: err.signal || null,
        duration_ms: Date.now() - started,
        stdout_tail: tail(err.stdout),
        stderr_tail: tail(err.stderr || err.message),
        passed: false,
      };
      failures.push(failure);
      stepReports.push(failure);
      console.log(`[FAIL] ${failure.name} duration=${formatDuration(failure.duration_ms)} exit=${failure.exit_code}${failure.signal ? ` signal=${failure.signal}` : ''}`);
      if (failure.stdout_tail) console.error(`--- stdout tail: ${failure.name} ---\n${failure.stdout_tail}`);
      if (failure.stderr_tail) console.error(`--- stderr tail: ${failure.name} ---\n${failure.stderr_tail}`);
    }
  }

  if (failures.length > 0) {
    console.error('\n=== FAILED STEPS ===');
    for (const failure of failures) {
      console.error(`${failure.name}: exit=${failure.exit_code}${failure.signal ? ` signal=${failure.signal}` : ''} duration=${formatDuration(failure.duration_ms)}`);
    }
  }
  console.log(`\n=== ${failures.length === 0 ? "ALL PASS" : "SOME FAILED"} ===`);
  await writeJsonReport(jsonReportPath, {
    schema_version: 1,
    mode: selection.mode,
    profile: selection.effectiveProfile,
    requested_profile: profile,
    base: base || null,
    changed_files: files,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    cwd: backendRoot,
    repo,
    passed: failures.length === 0,
    steps: stepReports,
    failures,
  });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
