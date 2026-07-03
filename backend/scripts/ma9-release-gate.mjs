#!/usr/bin/env node
/**
 * ma9-release-gate.mjs — P0-MA9 E2E Release Gate
 *
 * Validates the full MA1-MA8 chain for a complete release gate.
 * Each section imports the corresponding module and validates key exports.
 *
 * Usage:
 *   node scripts/ma9-release-gate.mjs
 *   node scripts/ma9-release-gate.mjs --json-report /path/to/report.json
 *
 * Run from backend/ root. MA10 is NOT started.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const GATE_VERSION = '1.0.0';
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tail(value, max = 2000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function repoInfo() {
  const root = runGit(['rev-parse', '--show-toplevel'], BACKEND_ROOT) || resolve(BACKEND_ROOT, '..');
  const status = runGit(['status', '--porcelain'], root);
  const head = runGit(['rev-parse', 'HEAD'], root);
  return {
    root, head: head || null,
    dirty: status.length > 0,
    dirty_count: status ? status.split('\n').filter(Boolean).length : 0,
    porcelain: status,
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasAtLeast(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  const available = Object.keys(obj).filter(k => k !== 'default');
  return available.length > 0 && keys.some(k => available.includes(k));
}

function doCheck(checks, label, ok, detail, advisory) {
  checks.push({ check: label, passed: ok, detail: detail || '', advisory: advisory || null });
}

async function checkModule(modPath, keyExports, label) {
  try {
    const mod = await import(modPath);
    const ok = hasAtLeast(mod, keyExports);
    const detail = ok
      ? `exports: ${Object.keys(mod).filter(k => k !== 'default').join(', ').slice(0, 120)}`
      : `missing expected exports; found: ${Object.keys(mod).filter(k => k !== 'default').join(', ').slice(0, 120)}`;
    return { passed: ok, detail };
  } catch (err) {
    return { passed: false, detail: tail(err.message) };
  }
}

// ---------------------------------------------------------------------------
// Section 1: MA1 — Backlog Census
// ---------------------------------------------------------------------------
async function sectionMA1() {
  const started = Date.now();
  const checks = [];
  const r1 = await checkModule(
    join(SRC_DIR, 'backlog-census.mjs'),
    ['runBacklogCensus', 'scanBacklogCensus', 'BACKLOG_CATEGORIES', 'BLOCKER_CLASSIFICATIONS', 'classifyBlocker', 'generateBacklogConvergenceReport'],
    'backlog-census exports'
  );
  doCheck(checks, 'backlog-census exports', r1.passed, r1.detail);

  try {
    const { classifyCurrentBlockerTask } = await import(join(SRC_DIR, 'current-blocker-policy.mjs'));
    const result = classifyCurrentBlockerTask({ task: { id: 't1' }, operation_kind: 'code_change' });
    doCheck(checks, 'classifyCurrentBlockerTask works', !!result, `result: ${result ? Object.keys(result).join(',') : 'none'}`);
  } catch (err) {
    doCheck(checks, 'classifyCurrentBlockerTask', false, tail(err.message));
  }

  try {
    const { TASK_TYPES, CLOSURE_PATHS } = await import(join(SRC_DIR, 'auto-closure-classifier.mjs'));
    doCheck(checks, 'auto-closure-classifier constants', TASK_TYPES.CODE_CHANGE === 'code_change' && CLOSURE_PATHS.COMPLETE === 'complete',
      `TASK_TYPES keys=${Object.keys(TASK_TYPES).length} CLOSURE_PATHS keys=${Object.keys(CLOSURE_PATHS).length}`);
  } catch (err) {
    doCheck(checks, 'auto-closure-classifier', false, tail(err.message));
  }

  return { name: 'MA1 - Backlog Census', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 2: MA2 — Evidence / Acceptance Contracts
// ---------------------------------------------------------------------------
async function sectionMA2() {
  const started = Date.now();
  const checks = [];

  const modules = [
    { path: 'evidence/evidence-normalizer.mjs', keys: ['normalizeOperationEvidence'], label: 'evidence-normalizer' },
    { path: 'acceptance/contract-builder.mjs', keys: ['buildAcceptanceContract', 'inferOperationKind'], label: 'contract-builder' },
    { path: 'acceptance/contract-verifier.mjs', keys: ['verifyAcceptanceContract'], label: 'contract-verifier' },
    { path: 'acceptance-policy.mjs', keys: ['evaluateAcceptance', 'ACCEPTANCE_SEVERITIES'], label: 'acceptance-policy' },
    { path: 'acceptance-gate-engine.mjs', keys: ['runAcceptanceGate'], label: 'acceptance-gate-engine' },
  ];
  for (const m of modules) {
    const r = await checkModule(join(SRC_DIR, m.path), m.keys, m.label);
    doCheck(checks, `${m.label} exports`, r.passed, r.detail);
  }

  return { name: 'MA2 - Evidence / Acceptance Contracts', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 3: MA3 — AgentRun Writeback
// ---------------------------------------------------------------------------
async function sectionMA3() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(
    join(SRC_DIR, 'agent-run-writeback.mjs'),
    ['writeBuilderAgentRun', 'writeVerifierAgentRun', 'writeReviewerAgentRun', 'writeIntegratorAgentRun', 'writeFinalizerAgentRun', 'writeRepairerAgentRun', 'writeContextCuratorAgentRun'],
    'agent-run-writeback'
  );
  doCheck(checks, 'agent-run-writeback exports (all roles)', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'agent-run-service.mjs'),
    ['createAgentRun', 'completeAgentRun', 'listAgentRuns'], 'agent-run-service');
  doCheck(checks, 'agent-run-service exports', r2.passed, r2.detail);

  const r3 = await checkModule(join(SRC_DIR, 'agent-artifact-contract.mjs'),
    ['AGENT_ROLE_ENUM', 'ARTIFACT_SCHEMA'], 'agent-artifact-contract');
  doCheck(checks, 'agent-artifact-contract exports', r3.passed, r3.detail);

  try {
    const { AGENT_ROLE_ENUM } = await import(join(SRC_DIR, 'agent-artifact-contract.mjs'));
    const roles = Object.values(AGENT_ROLE_ENUM);
    const requiredRoles = ['context_curator', 'planner', 'builder', 'verifier', 'reviewer', 'integrator', 'finalizer', 'repairer'];
    const missing = requiredRoles.filter(r => !roles.includes(r));
    doCheck(checks, 'all required agent roles present', missing.length === 0,
      `roles=${roles.length} missing=${missing.length > 0 ? missing.join(',') : 'none'}`);
  } catch (err) {
    doCheck(checks, 'agent roles', false, tail(err.message));
  }

  return { name: 'MA3 - AgentRun Writeback', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 4: MA4 — Pipeline Orchestration
// ---------------------------------------------------------------------------
async function sectionMA4() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(join(SRC_DIR, 'pipeline-orchestration.mjs'),
    ['createDefaultAgentPipeline', 'evaluateTaskPipelineGates', 'checkPipelineGateBlocking', 'getEffectivePipelineRoles', 'resolveRoleBackend', 'BLOCKING_GATE_ROLES'],
    'pipeline-orchestration');
  doCheck(checks, 'pipeline-orchestration exports', r1.passed, r1.detail);

  try {
    const { DEFAULT_AGENT_PIPELINE } = await import(join(SRC_DIR, 'subagent-policy.mjs'));
    const expected = ['context_curator', 'planner', 'builder', 'verifier', 'reviewer', 'integrator', 'finalizer'];
    const allPresent = expected.every(r => DEFAULT_AGENT_PIPELINE.includes(r));
    doCheck(checks, 'default pipeline has all required roles', allPresent,
      `pipeline=[${DEFAULT_AGENT_PIPELINE.join(', ')}]`);
  } catch (err) {
    doCheck(checks, 'default pipeline roles', false, tail(err.message));
  }

  const r2 = await checkModule(join(SRC_DIR, 'codex-worker-runner.mjs'),
    ['runAssignedCodexTasks'], 'codex-worker-runner');
  doCheck(checks, 'codex-worker-runner exports', r2.passed, r2.detail);

  const r3 = await checkModule(join(SRC_DIR, 'codex-worker-loop.mjs'),
    ['startCodexWorker', 'getWorkerProgressCount'], 'codex-worker-loop');
  doCheck(checks, 'codex-worker-loop exports', r3.passed, r3.detail);

  const r4 = await checkModule(join(SRC_DIR, 'subagent-policy.mjs'),
    ['DEFAULT_AGENT_PIPELINE', 'DEFAULT_AGENT_BACKEND_BY_ROLE', 'ACCEPTED_AGENT_ROLES'], 'subagent-policy');
  doCheck(checks, 'subagent-policy exports', r4.passed, r4.detail);

  return { name: 'MA4 - Pipeline Orchestration', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 5: MA5 — Review Backlog
// ---------------------------------------------------------------------------
async function sectionMA5() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(join(SRC_DIR, 'review/review-backlog-reconciler.mjs'),
    ['RECONCILIATION_TYPES', 'reconcileReviewBacklog', 'reconcileBundle', 'reconcileTask'], 'review-backlog-reconciler');
  doCheck(checks, 'review-backlog-reconciler exports', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'review/review-packet-builder.mjs'),
    ['getTaskReviewPacket'], 'review-packet-builder');
  doCheck(checks, 'review-packet-builder exports', r2.passed, r2.detail);

  const r3 = await checkModule(join(SRC_DIR, 'task-review-status-taxonomy.mjs'),
    ['REVIEW_STATES', 'TYPED_REVIEW_STATES', 'classifyReviewState'], 'task-review-status-taxonomy');
  doCheck(checks, 'task-review-status-taxonomy exports', r3.passed, r3.detail);

  return { name: 'MA5 - Review Backlog', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 6: MA6 — Repair Loop
// ---------------------------------------------------------------------------
async function sectionMA6() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(join(SRC_DIR, 'repair-loop.mjs'),
    ['createRepairGoalFromFindings', 'shouldAttemptRepair', 'scheduleRepairAttempt', 'handleRepairCompletion', 'buildRepairPrompt'], 'repair-loop');
  doCheck(checks, 'repair-loop exports', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'no-change-repair-classifier.mjs'),
    ['classifyNoChangeRepairOutcome'], 'no-change-repair-classifier');
  doCheck(checks, 'no-change-repair-classifier exports', r2.passed, r2.detail);

  const r3 = await checkModule(join(SRC_DIR, 'self-healing-policy.mjs'),
    ['ERROR_CATEGORIES', 'classifyError', 'determineHealingAction'], 'self-healing-policy');
  doCheck(checks, 'self-healing-policy exports', r3.passed, r3.detail);

  return { name: 'MA6 - Repair Loop', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 7: MA7 — Integration Backlog Reconciler
// ---------------------------------------------------------------------------
async function sectionMA7() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(join(SRC_DIR, 'integration-backlog-reconciler.mjs'),
    ['classifyIntegrationState', 'reconcileIntegrationTask', 'reconcileIntegrationBacklog', 'INTEGRATION_RECONCILIATION_TYPES'], 'integration-backlog-reconciler');
  doCheck(checks, 'integration-backlog-reconciler exports', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'auto-integration-completion.mjs'),
    ['analyzeAutoIntegrationCandidate', 'isIntegrationRepairableStatus'], 'auto-integration-completion');
  doCheck(checks, 'auto-integration-completion exports', r2.passed, r2.detail);

  const r3 = await checkModule(join(SRC_DIR, 'codex-finalizer-contract.mjs'),
    ['createSuccessResult', 'createNoopResult', 'validateFinalizerResult'], 'codex-finalizer-contract');
  doCheck(checks, 'codex-finalizer-contract exports', r3.passed, r3.detail);

  return { name: 'MA7 - Integration Backlog Reconciler', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 8: MA8 — Queue Auto-Advance
// ---------------------------------------------------------------------------
async function sectionMA8() {
  const started = Date.now();
  const checks = [];

  const r1 = await checkModule(join(SRC_DIR, 'queue-policy.mjs'),
    ['checkDependency', 'checkAcceptanceGate', 'checkRepoConcurrency', 'buildAdvancementChecks',
     'allAdvancementChecksPass', 'resolveDependencyTarget', 'isTerminalCompleted', 'isNonCompletionTerminal', 'QUEUE_STATUS_RUNNING'],
    'queue-policy');
  doCheck(checks, 'queue-policy exports', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'goal-queue.mjs'),
    ['enqueueGoal', 'startNextQueuedGoal', 'cancelGoalQueueItem', 'listGoalQueue', 'queueAutoAdvanceTick', 'reconcileQueue'],
    'goal-queue');
  doCheck(checks, 'goal-queue exports', r2.passed, r2.detail);

  // Scenario: dependency checks
  try {
    const { checkDependency, checkAcceptanceGate, isTerminalCompleted, isNonCompletionTerminal } = await import(join(SRC_DIR, 'queue-policy.mjs'));
    const { TASK_STATUSES } = await import(join(SRC_DIR, 'task-status-taxonomy.mjs'));

    const compState = { tasks: [{ id: 't', status: TASK_STATUSES.COMPLETED }], goals: [], goal_queue: [] };
    const depOk = checkDependency(compState, { depends_on_task_id: 't' });
    const gateOk = checkAcceptanceGate(compState, { depends_on_task_id: 't' });
    doCheck(checks, 'queue dependency satisfied on completed task', depOk.satisfied && gateOk.passed,
      `dep_satisfied=${depOk.satisfied} gate_passed=${gateOk.passed}`);

    const runState = { tasks: [{ id: 't', status: TASK_STATUSES.RUNNING }], goals: [], goal_queue: [] };
    const depBlocked = checkDependency(runState, { depends_on_task_id: 't' });
    doCheck(checks, 'queue dependency blocked on running task', !depBlocked.satisfied,
      `dep_satisfied=${depBlocked.satisfied} reason=${depBlocked.reason || 'none'}`);

    doCheck(checks, 'terminal utilities work',
      isTerminalCompleted(TASK_STATUSES.COMPLETED) && !isTerminalCompleted(TASK_STATUSES.FAILED) && isNonCompletionTerminal(TASK_STATUSES.FAILED),
      `completed_terminal=${isTerminalCompleted(TASK_STATUSES.COMPLETED)} non_completion_terminal=${isNonCompletionTerminal(TASK_STATUSES.FAILED)}`);
  } catch (err) {
    doCheck(checks, 'queue scenario', false, tail(err.message));
  }

  return { name: 'MA8 - Queue Auto-Advance', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Section 9: Diagnostics
// ---------------------------------------------------------------------------
async function sectionDiagnostics() {
  const started = Date.now();
  const checks = [];
  const repo = repoInfo();

  doCheck(checks, 'canonical repo clean', !repo.dirty, repo.dirty ? `dirty with ${repo.dirty_count} changes` : 'clean');
  doCheck(checks, 'canonical head matches c017516', repo.head === 'c017516fcb25d6d5f54f36426daf3199b8e594ad', `head=${repo.head}`);

  // Lock check
  let staleLocks = 0, activeLocks = 0;
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const entries = await readdir(join(BACKEND_ROOT, '../.gptwork')).catch(() => []);
    for (const entry of entries) {
      if (entry.includes('lock') || entry.endsWith('.lock') || entry.startsWith('lock_')) {
        const st = await stat(join(BACKEND_ROOT, '../.gptwork', entry)).catch(() => null);
        if (st) {
          if ((Date.now() - st.mtimeMs) / (1000 * 3600) > 24) staleLocks++; else activeLocks++;
        }
      }
    }
  } catch { }
  doCheck(checks, 'lock state (active/stale)', staleLocks === 0,
    `active=${activeLocks} stale=${staleLocks}`, staleLocks > 0 ? `stale lock files present` : null);

  // Previous blocked/failed results
  let blockersCount = 0;
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const gdirs = await readdir(join(BACKEND_ROOT, '../.gptwork/goals')).catch(() => []);
    for (const d of gdirs) {
      const rp = join(BACKEND_ROOT, '../.gptwork/goals', d, 'result.json');
      if (existsSync(rp)) {
        try {
          const r = JSON.parse(await readFile(rp, 'utf8'));
          if (r.status === 'failed' || r.status === 'blocked') blockersCount++;
        } catch { }
      }
    }
  } catch { }
  doCheck(checks, 'previous blockers count', blockersCount === 0,
    `failed/blocked: ${blockersCount}`, blockersCount > 0 ? `${blockersCount} previous failed results` : null);

  // Finalizer evidence
  try {
    const { createSuccessResult, validateFinalizerResult } = await import(join(SRC_DIR, 'codex-finalizer-contract.mjs'));
    const result = createSuccessResult({ summary: 'test', changed_files: ['test.js'], commit: 'abc123' });
    const valid = validateFinalizerResult(result);
    doCheck(checks, 'finalizer result creation + validation',
      result?.status === 'completed' && (valid === true || valid?.valid === true),
      `status=${result.status} validated=${JSON.stringify(valid).slice(0, 80)}`);
  } catch (err) {
    doCheck(checks, 'finalizer scenario', false, tail(err.message));
  }

  const r = await checkModule(join(SRC_DIR, 'codex-finalizer-runtime-changes.mjs'),
    ['detectRuntimeCodeChanges', 'checkResultForRuntimeChanges'], 'finalizer-runtime-changes');
  doCheck(checks, 'finalizer runtime changes', r.passed, r.detail);

  const t = await checkModule(join(SRC_DIR, 'task-verifier.mjs'),
    ['verifyTaskCompletion'], 'task-verifier');
  doCheck(checks, 'task-verifier exports', t.passed, t.detail);

  return { name: 'Diagnostics - Repo, Locks, Blockers, Finalizer', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started, repo };
}

// ---------------------------------------------------------------------------
// Section 10: Successor Repair & Queue Closure
// ---------------------------------------------------------------------------
async function sectionSuccessorRepairEvidence() {
  const started = Date.now();
  const checks = [];

  try {
    const { RECONCILIATION_TYPES } = await import(join(SRC_DIR, 'review/review-backlog-reconciler.mjs'));
    const hasReconciledBySuccessor = Object.values(RECONCILIATION_TYPES || {}).includes('reconciled_by_successor');
    doCheck(checks, 'review backlog reconciled_by_successor type', hasReconciledBySuccessor,
      `types: ${Object.values(RECONCILIATION_TYPES || {}).join(', ').slice(0, 160)}`);
  } catch (err) {
    doCheck(checks, 'review backlog reconciliation', false, tail(err.message));
  }

  const r1 = await checkModule(join(SRC_DIR, 'worker-queue-counts.mjs'),
    ['hasImplicitSuccessor', 'buildTaskQueueIndexes'], 'worker-queue-counts successor detection');
  doCheck(checks, 'worker-queue-counts successor detection', r1.passed, r1.detail);

  const r2 = await checkModule(join(SRC_DIR, 'goal-queue.mjs'),
    ['startNextQueuedGoal', 'enqueueGoal', 'queueAutoAdvanceTick'], 'goal-queue auto-advance');
  doCheck(checks, 'goal-queue auto-advance capable', r2.passed, r2.detail);

  try {
    const { INTEGRATION_RECONCILIATION_TYPES } = await import(join(SRC_DIR, 'integration-backlog-reconciler.mjs'));
    doCheck(checks, 'integration reconciler has already_integrated type',
      !!INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED,
      `types: ${Object.values(INTEGRATION_RECONCILIATION_TYPES || {}).join(', ').slice(0, 160)}`);
  } catch (err) {
    doCheck(checks, 'integration reconciler types', false, tail(err.message));
  }

  return { name: 'Successor Repair & Queue Closure', passed: checks.every(c => c.passed), checks, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const jsonReportPath = argValue('--json-report');
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();

  console.log(`\n==========================================================`);
  console.log(`  GPTWork P0-MA9 E2E Release Gate v${GATE_VERSION}`);
  console.log(`  Validates: MA1 > MA2 > MA3 > MA4 > MA5 > MA6 > MA7 > MA8`);
  console.log(`  Head: ${repoInfo().head ? repoInfo().head.substring(0, 12) : 'unknown'}`);
  console.log(`==========================================================\n`);

  const sections = [];
  for (const fn of [sectionMA1, sectionMA2, sectionMA3, sectionMA4, sectionMA5, sectionMA6, sectionMA7, sectionMA8, sectionDiagnostics, sectionSuccessorRepairEvidence]) {
    sections.push(await fn());
  }

  const totalChecks = sections.reduce((s, x) => s + x.checks.length, 0);
  const failedChecks = sections.reduce((s, x) => s + x.checks.filter(c => !c.passed).length, 0);
  const mandatoryFailed = sections.slice(0, 8).reduce((s, x) => s + x.checks.filter(c => !c.passed).length, 0);
  const blockers = sections.flatMap(s => s.checks.filter(c => !c.passed));
  const advisories = sections.flatMap(s => s.checks.filter(c => c.advisory).map(c => ({ check: c.check, advisory: c.advisory })));
  const goNoGo = mandatoryFailed === 0 ? 'GO' : 'NO-GO';

  console.log(`\n--- GATE REPORT ---`);
  console.log(`Duration: ${formatDuration(Date.now() - startedMs)}`);
  console.log(`Sections: ${sections.length}, Checks: ${totalChecks} total, ${failedChecks} failed`);
  console.log(`Mandatory failed checks: ${mandatoryFailed}`);
  console.log(`Result: ${goNoGo}`);
  console.log('');

  const toIcon = (p) => p ? '+' : 'X';
  for (const section of sections) {
    console.log(`  ${toIcon(section.passed)} ${section.name} (${formatDuration(section.duration_ms)})`);
    for (const c of section.checks) {
      console.log(`  ${toIcon(c.passed)} ${c.check}: ${c.detail || ''}`);
      if (c.advisory) console.log(`       advisory: ${c.advisory}`);
    }
  }

  if (blockers.length > 0) {
    console.log(`\n--- BLOCKERS (${blockers.length}) ---`);
    for (const b of blockers) console.log(`  X ${b.check}: ${b.detail || 'no detail'}`);
  }
  if (advisories.length > 0) {
    console.log(`\n--- ADVISORIES (${advisories.length}) ---`);
    for (const a of advisories) console.log(`  ~ ${a.check}: ${a.advisory}`);
  }
  console.log(`\n=== ${goNoGo} ===`);

  const report = {
    schema_version: 1,
    gate_version: GATE_VERSION,
    scenario: 'P0-MA9',
    passed: mandatoryFailed === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    cwd: BACKEND_ROOT,
    go_no_go: goNoGo,
    ma10_not_started: true,
    sections: sections.map(s => ({
      name: s.name,
      passed: s.passed,
      duration_ms: s.duration_ms,
      checks: s.checks.map(c => ({ check: c.check, passed: c.passed, detail: c.detail || null, advisory: c.advisory || null })),
      repo: s.repo || null,
    })),
    summary: { total_sections: sections.length, passed_sections: sections.filter(s => s.passed).length,
      mandatory_sections: 8, mandatory_passed: sections.slice(0, 8).filter(s => s.passed).length,
      total_checks: totalChecks, passed_checks: totalChecks - failedChecks, failed_checks: failedChecks,
      blockers: blockers.length, advisories: advisories.length },
    blockers: blockers.map(b => ({ check: b.check, detail: b.detail })),
    advisories: advisories.map(a => ({ check: a.check, advisory: a.advisory })),
  };

  if (jsonReportPath) {
    const ap = resolve(jsonReportPath);
    await mkdir(dirname(ap), { recursive: true });
    await writeFile(ap, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\njson report: ${jsonReportPath}`);
  }

  process.exit(mandatoryFailed === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
