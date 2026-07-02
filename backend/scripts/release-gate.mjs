#!/usr/bin/env node
/**
 * release-gate.mjs — P0-C10b Release Gate for Fresh Install to Demo Goal Auto-Close
 *
 * Proves GPTWork can run the core product loop:
 *   setup → demo goal → verification → closure → queue advancement
 *
 * Scenarios:
 *   1. Self-test / baseline — imports resolve, runtime env valid
 *   2. Readonly demo goal    — verify → accepted → integration_not_required → closed
 *   3. Mutating demo goal    — implement → verify → accepted → integrate → closed
 *   4. Queue auto-advance    — dependent item advances after upstream terminal
 *   5. Diagnostics           — env, repo, locks, blockers, worktrees
 *
 * Reports: Go / No-Go with blocker summary.
 *
 * Usage:
 *   node scripts/release-gate.mjs
 *   node scripts/release-gate.mjs --json-report /path/to/report.json
 *
 * Run from backend/ root.
 */
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GATE_VERSION = '1.0.0';
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const branch = runGit(['branch', '--show-current'], root);
  const head = runGit(['rev-parse', 'HEAD'], root);
  return {
    root,
    head: head || null,
    branch: branch || null,
    dirty: status.length > 0,
    dirty_count: status ? status.split('\n').filter(Boolean).length : 0,
    porcelain: status,
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

// ---------------------------------------------------------------------------
// Gate sections
// ---------------------------------------------------------------------------

/**
 * Section 1: Self-test / Baseline — verify all core imports resolve and
 * the runtime environment loads correctly.
 */
async function sectionSelfTest() {
  const checks = [];
  const started = Date.now();

  // 1. Check all core modules import cleanly
  const modules = [
    'task-graph-state.mjs',
    'task-status-taxonomy.mjs',
    'auto-closure-classifier.mjs',
    'closure/task-closure-decider.mjs',
    'closure/auto-progress-policy.mjs',
    'acceptance-gate-engine.mjs',
    'acceptance-policy.mjs',
    'goal-queue.mjs',
    'queue-policy.mjs',
    'auto-integration-completion.mjs',
  ];

  for (const mod of modules) {
    try {
      const modPath = join(SRC_DIR, mod);
      await import(modPath);
      checks.push({ check: `import ${mod}`, passed: true });
    } catch (err) {
      checks.push({ check: `import ${mod}`, passed: false, detail: err.message });
    }
  }

  // 2. Verify graph state constants
  try {
    const { GRAPH_NODES, isValidTransition } = await import(join(SRC_DIR, 'task-graph-state.mjs'));
    const validNodes = Object.values(GRAPH_NODES);
    const readonlyPath = ['verified', 'accepted', 'integration_not_required', 'closure_eligible', 'closed'];
    const mutatingPath = ['verified', 'accepted', 'integration_required', 'integrated', 'deployment_checked', 'closure_eligible', 'closed'];

    let allValid = validNodes.length >= 12;
    let pathValid = true;
    for (let i = 0; i < readonlyPath.length - 1; i++) {
      if (!isValidTransition(readonlyPath[i], readonlyPath[i + 1])) {
        pathValid = false;
        break;
      }
    }
    for (let i = 0; i < mutatingPath.length - 1; i++) {
      if (!isValidTransition(mutatingPath[i], mutatingPath[i + 1])) {
        pathValid = false;
        break;
      }
    }
    checks.push({ check: 'graph state readonly path valid', passed: allValid && pathValid, detail: `nodes=${validNodes.length} path_ok=${pathValid}` });
  } catch (err) {
    checks.push({ check: 'graph state readonly path valid', passed: false, detail: err.message });
  }

  // 3. Verify env
  const envOk = process.env.GPTWORK_TOOL_MODE === 'full';
  const envDetail = envOk ? `GPTWORK_TOOL_MODE=${process.env.GPTWORK_TOOL_MODE}` : `expected full, got ${process.env.GPTWORK_TOOL_MODE || '(unset)'}`;
  checks.push({ check: 'runtime env valid', passed: envOk, detail: envDetail });

  // 4. Verify module exports on key modules
  try {
    const { TASK_TYPES, CLOSURE_PATHS } = await import(join(SRC_DIR, 'auto-closure-classifier.mjs'));
    checks.push({
      check: 'auto-closure-classifier exports',
      passed: TASK_TYPES.CODE_CHANGE === 'code_change' && CLOSURE_PATHS.COMPLETE === 'complete',
      detail: `TASK_TYPES keys=${Object.keys(TASK_TYPES).length} CLOSURE_PATHS keys=${Object.keys(CLOSURE_PATHS).length}`,
    });
  } catch (err) {
    checks.push({ check: 'auto-closure-classifier exports', passed: false, detail: err.message });
  }

  const duration = Date.now() - started;
  const passed = checks.every(c => c.passed);
  return {
    name: 'self-test baseline',
    passed,
    checks,
    duration_ms: duration,
  };
}

/**
 * Section 2: Readonly demo goal — verify → accepted → integration_not_required → closed.
 *
 * Uses task-closure-decider with an integration_not_required contract.
 * A "readonly" task has no code changes, passes verification, and the acceptance
 * contract says integration is not required → closure_eligible → closed.
 */
async function sectionReadonlyDemo() {
  const started = Date.now();
  const checks = [];

  try {
    const { decideTaskClosure } = await import(join(SRC_DIR, 'closure/task-closure-decider.mjs'));
    const { CLOSURE_STATUSES } = await import(join(SRC_DIR, 'closure/auto-progress-policy.mjs'));

    // Simulate a readonly / sync task:
    // - operation_kind = "diagnostic" (no repo mutation)
    // - result has no changed_files, verification passed
    // - contract says integration not required, completion auto
    const contract = {
      intent: { operation_kind: 'diagnostic', semantic_confidence: 'high', mutation_scope: 'none' },
      requirements: { requires_commit: false, requires_integration: false, requires_deployment: false },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true, allow_completed_with_followups: true },
    };

    // Case A: Clean readonly — no findings, no blockers
    const cleanResult = { status: 'completed', summary: 'Readonly diagnostic ok', changed_files: [], operation_kind: 'diagnostic', verification: { passed: true, commands: [{ cmd: 'check', exit_code: 0 }] } };
    const cleanContractVerification = { contract_valid: true, blocking_passed: true, acceptance_status: 'satisfied', completion_eligible: true, blockers: [], non_blocking_followups: [], quality_notes: [], state_assertions: { passed: true, failures: [] } };
    const cleanVerification = { passed: true, findings: [], commands: [{ cmd: 'check', exit_code: 0 }] };

    const deciderResult = decideTaskClosure({
      contract,
      contractVerification: cleanContractVerification,
      verification: cleanVerification,
      result: cleanResult,
      task: { id: 'task_readonly_demo', title: 'P0-C10b: readonly demo' },
    });

    const isAutoCompleted = deciderResult.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN || deciderResult.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
    const blocksRendered = deciderResult.blocking_passed === true || deciderResult.blockers.length === 0;
    checks.push({
      check: 'readonly clean closure',
      passed: isAutoCompleted && blocksRendered,
      detail: `closure_status=${deciderResult.status} blocking_passed=${deciderResult.blocking_passed} blockers=${deciderResult.blockers.length}`,
    });

    // Case B: Followup-only readonly — quality notes but still auto-completes
    const followupResult = { ...cleanResult };
    const followupCv = { ...cleanContractVerification, quality_notes: ['Consider improving diagnostic coverage.'] };
    const followupDecision = decideTaskClosure({
      contract,
      contractVerification: followupCv,
      verification: cleanVerification,
      result: followupResult,
      task: { id: 'task_readonly_followup', title: 'P0-C10b: readonly followup demo' },
    });

    const followupOk = followupDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
    checks.push({
      check: 'readonly followup closure',
      passed: followupOk,
      detail: `closure_status=${followupDecision.status} quality_notes=${followupDecision.quality_notes?.length || 0}`,
    });

    // Case C: Integration_not_required path in graph state
    const { isValidTransition } = await import(join(SRC_DIR, 'task-graph-state.mjs'));
    const transitionChecks = [
      ['verified', 'accepted'],
      ['accepted', 'integration_not_required'],
      ['integration_not_required', 'closure_eligible'],
      ['closure_eligible', 'closed'],
    ];
    let allTransitionsValid = true;
    for (const [from, to] of transitionChecks) {
      if (!isValidTransition(from, to)) { allTransitionsValid = false; break; }
    }
    checks.push({
      check: 'readonly graph transitions valid',
      passed: allTransitionsValid,
      detail: `transitions: ${transitionChecks.map(([f, t]) => `${f}→${t}`).join(', ')}`,
    });

    const duration = Date.now() - started;
    const passed = checks.every(c => c.passed);
    return { name: 'readonly demo goal (verify → accepted → integration_not_required → closed)', passed, checks, duration_ms: duration };
  } catch (err) {
    return { name: 'readonly demo goal', passed: false, checks: [{ check: 'section', passed: false, detail: tail(err.message) }], duration_ms: Date.now() - started };
  }
}

/**
 * Section 3: Mutating demo goal — implement → verify → accepted → integrate → closed.
 *
 * A "code change" task goes through:
 *   verified → accepted → integration_required → integrated → deployment_checked → closure_eligible → closed
 */
async function sectionMutatingDemo() {
  const started = Date.now();
  const checks = [];

  try {
    const { decideTaskClosure } = await import(join(SRC_DIR, 'closure/task-closure-decider.mjs'));
    const { CLOSURE_STATUSES } = await import(join(SRC_DIR, 'closure/auto-progress-policy.mjs'));

    // Code change contract — requires integration
    const contract = {
      intent: { operation_kind: 'code_change', semantic_confidence: 'high', mutation_scope: 'repo' },
      requirements: { requires_commit: true, requires_integration: true, requires_deployment: false },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true, allow_completed_with_followups: true },
    };

    // Case A: Code change with successful integration
    const integratedResult = {
      status: 'completed',
      summary: 'Implemented feature X',
      changed_files: ['src/feature-x.mjs'],
      operation_kind: 'code_change',
      verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }] },
      commit: 'abc123def456',
      integration: { satisfied: true, merged: true, pr_url: 'https://github.com/org/repo/pull/1', status: 'merged' },
    };
    const integrationCv = { contract_valid: true, blocking_passed: true, acceptance_status: 'satisfied', completion_eligible: true, blockers: [], non_blocking_followups: [], quality_notes: [], state_assertions: { passed: true, failures: [] } };
    const integrationVer = { passed: true, findings: [], commands: [{ cmd: 'npm test', exit_code: 0 }] };

    const integratedDecision = decideTaskClosure({
      contract,
      contractVerification: integrationCv,
      verification: integrationVer,
      result: integratedResult,
      task: { id: 'task_mutating_demo_integrated', title: 'P0-C10b: mutating demo integrated' },
    });

    const integratedOk = integratedDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN || integratedDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS;
    checks.push({
      check: 'code change with integration closure',
      passed: integratedOk,
      detail: `closure_status=${integratedDecision.status} blocking_passed=${integratedDecision.blocking_passed} blockers=${integratedDecision.blockers.length}`,
    });

    // Case B: Code change with integration_not_required (contract says no integration needed)
    const noIntContract = {
      intent: { operation_kind: 'code_change', semantic_confidence: 'high', mutation_scope: 'repo' },
      requirements: { requires_commit: true, requires_integration: false, requires_deployment: false },
      completion_policy: { auto_complete_when_blocking_requirements_pass: true },
    };
    const noIntResult = {
      status: 'completed',
      summary: 'Docs update',
      changed_files: ['README.md'],
      operation_kind: 'code_change',
      verification: { passed: true, commands: [{ cmd: 'check', exit_code: 0 }] },
      commit: 'xyz789abc',
    };
    const noIntDecision = decideTaskClosure({
      contract: noIntContract,
      contractVerification: integrationCv,
      verification: integrationVer,
      result: noIntResult,
      task: { id: 'task_mutating_demo_no_integration', title: 'P0-C10b: mutating demo no-integration' },
    });
    checks.push({
      check: 'code change no-integration closure',
      passed: noIntDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_CLEAN || noIntDecision.status === CLOSURE_STATUSES.AUTO_COMPLETED_WITH_FOLLOWUPS,
      detail: `closure_status=${noIntDecision.status} blockers=${noIntDecision.blockers.length}`,
    });

    // Case C: Verify graph path transitions for mutating path
    const { isValidTransition } = await import(join(SRC_DIR, 'task-graph-state.mjs'));
    const transitionChecks = [
      ['verified', 'accepted'],
      ['accepted', 'integration_required'],
      ['integration_required', 'integrated'],
      ['integrated', 'deployment_checked'],
      ['deployment_checked', 'closure_eligible'],
      ['closure_eligible', 'closed'],
    ];
    let allTransitionsValid = true;
    for (const [from, to] of transitionChecks) {
      if (!isValidTransition(from, to)) { allTransitionsValid = false; break; }
    }
    checks.push({
      check: 'mutating graph transitions valid',
      passed: allTransitionsValid,
      detail: `transitions: ${transitionChecks.map(([f, t]) => `${f}→${t}`).join(', ')}`,
    });

    // Case D: validate auto-integration-completion exports
    try {
      const autoIntMod = await import(join(SRC_DIR, 'auto-integration-completion.mjs'));
      checks.push({
        check: 'auto-integration-completion exports',
        passed: typeof autoIntMod === 'object' && autoIntMod !== null,
        detail: `exports: ${Object.keys(autoIntMod).filter(k => k !== 'default').join(', ').slice(0, 100)}`,
      });
    } catch (err) {
      checks.push({ check: 'auto-integration-completion exports', passed: false, detail: err.message });
    }

    const duration = Date.now() - started;
    const passed = checks.every(c => c.passed);
    return { name: 'mutating demo goal (implement → verify → accepted → integrate → closed)', passed, checks, duration_ms: duration };
  } catch (err) {
    return { name: 'mutating demo goal', passed: false, checks: [{ check: 'section', passed: false, detail: tail(err.message) }], duration_ms: Date.now() - started };
  }
}

/**
 * Section 4: Queue auto-advance — dependent item advances after upstream terminal completion.
 *
 * Tests queue-policy's dependency resolution, acceptance gating, and
 * advancement checks through the real checkDependency, checkAcceptanceGate,
 * and buildAdvancementChecks functions with simulated state.
 */
async function sectionQueueAutoAdvance() {
  const started = Date.now();
  const checks = [];

  try {
    const {
      checkDependency,
      checkAcceptanceGate,
      checkRepoConcurrency,
      buildAdvancementChecks,
      allAdvancementChecksPass,
      resolveDependencyTarget,
      isTerminalCompleted,
      isNonCompletionTerminal,
    } = await import(join(SRC_DIR, 'queue-policy.mjs'));
    const { TASK_STATUSES } = await import(join(SRC_DIR, 'task-status-taxonomy.mjs'));

    // Scenario A: Dependency resolved (completed_only policy)
    // upstream task completed → dependent should be satisfied
    const stateCompleted = {
      tasks: [{ id: 'task_upstream', status: TASK_STATUSES.COMPLETED }],
      goals: [],
      goal_queue: [],
    };
    const itemDepOnTask = { depends_on_task_id: 'task_upstream', dependency_policy: 'completed_only' };
    const depResult = checkDependency(stateCompleted, itemDepOnTask);
    checks.push({
      check: 'dependency satisfied on completed task',
      passed: depResult.satisfied,
      detail: `satisfied=${depResult.satisfied} reason=${depResult.reason || 'none'}`,
    });

    // Scenario B: Dependency blocked (upstream not completed)
    const stateRunning = {
      tasks: [{ id: 'task_upstream', status: TASK_STATUSES.RUNNING }],
      goals: [],
      goal_queue: [],
    };
    const depBlocked = checkDependency(stateRunning, itemDepOnTask);
    checks.push({
      check: 'dependency blocked on running task',
      passed: !depBlocked.satisfied,
      detail: `satisfied=${depBlocked.satisfied} reason=${depBlocked.reason || 'none'}`,
    });

    // Scenario C: terminal_any policy allows successful completion on failed upstream
    const stateFailed = {
      tasks: [{ id: 'task_failed', status: TASK_STATUSES.FAILED }],
      goals: [],
      goal_queue: [],
    };
    const itemTerminalAny = { depends_on_task_id: 'task_failed', dependency_policy: 'terminal_any' };
    const depTerminalAny = checkDependency(stateFailed, itemTerminalAny);
    checks.push({
      check: 'terminal_any policy allows failed upstream',
      passed: depTerminalAny.satisfied,
      detail: `satisfied=${depTerminalAny.satisfied} reason=${depTerminalAny.reason || 'none'}`,
    });

    // Scenario D: Acceptance gate passes for completed task
    const gatePassed = checkAcceptanceGate(stateCompleted, itemDepOnTask);
    checks.push({
      check: 'acceptance gate passes on completed task',
      passed: gatePassed.passed,
      detail: `passed=${gatePassed.passed} reason=${gatePassed.reason || 'none'}`,
    });

    // Scenario E: Acceptance gate blocks for failed task
    const itemFailed = { depends_on_task_id: 'task_failed' };
    const gateBlocked = checkAcceptanceGate(stateFailed, itemFailed);
    checks.push({
      check: 'acceptance gate blocks on failed task',
      passed: !gateBlocked.passed,
      detail: `passed=${gateBlocked.passed} reason=${gateBlocked.reason || 'none'}`,
    });

    // Scenario F: Repo concurrency — two items same repo blocked
    const stateConcurrent = {
      goal_queue: [
        { queue_id: 'q1', status: 'running', repo_id: 'repo-A' },
      ],
    };
    const concBlocked = checkRepoConcurrency(stateConcurrent, 'repo-A', undefined);
    checks.push({
      check: 'repo concurrency blocks same repo',
      passed: concBlocked.blocked,
      detail: `blocked=${concBlocked.blocked} runningItem=${concBlocked.runningItem?.queue_id || 'none'}`,
    });

    // Scenario G: Repo concurrency — different repos allowed
    const concAllowed = checkRepoConcurrency(stateConcurrent, 'repo-B');
    checks.push({
      check: 'repo concurrency allows different repo',
      passed: !concAllowed.blocked,
      detail: `blocked=${concAllowed.blocked}`,
    });

    // Scenario H: resolveDependencyTarget for task dependency
    const resolved = resolveDependencyTarget(stateCompleted, itemDepOnTask);
    checks.push({
      check: 'resolveDependencyTarget finds task',
      passed: resolved.status === TASK_STATUSES.COMPLETED && resolved.kind === 'task',
      detail: `status=${resolved.status} kind=${resolved.kind} target_id=${resolved.target_id}`,
    });

    // Scenario I: resolveDependencyTarget with no dependency
    const noDep = resolveDependencyTarget(stateCompleted, {});
    checks.push({
      check: 'resolveDependencyTarget no dependency',
      passed: noDep.kind === 'none' && noDep.status === null,
      detail: `kind=${noDep.kind} status=${noDep.status}`,
    });

    // Scenario J: isTerminalCompleted utility
    checks.push({
      check: 'isTerminalCompleted works',
      passed: isTerminalCompleted(TASK_STATUSES.COMPLETED) === true && isTerminalCompleted(TASK_STATUSES.RUNNING) === false && isNonCompletionTerminal(TASK_STATUSES.FAILED) === true,
      detail: `completed=${isTerminalCompleted(TASK_STATUSES.COMPLETED)} running=${isTerminalCompleted(TASK_STATUSES.RUNNING)} failed_non_term=${isNonCompletionTerminal(TASK_STATUSES.FAILED)}`,
    });

    // Scenario K: allAdvancementChecksPass
    const allPass = allAdvancementChecksPass([
      { passed: true },
      { passed: true },
    ]);
    const someFail = allAdvancementChecksPass([
      { passed: true },
      { passed: false },
    ]);
    checks.push({
      check: 'allAdvancementChecksPass logic',
      passed: allPass === true && someFail === false,
      detail: `allPass=${allPass} someFail=${someFail}`,
    });

    const duration = Date.now() - started;
    const passed = checks.every(c => c.passed);
    return { name: 'queue auto-advance demo', passed, checks, duration_ms: duration };
  } catch (err) {
    return { name: 'queue auto-advance demo', passed: false, checks: [{ check: 'section', passed: false, detail: tail(err.message) }], duration_ms: Date.now() - started };
  }
}

/**
 * Section 5: Diagnostics — runtime, worker health, locks, repo, blockers, cleanup
 */
async function sectionDiagnostics() {
  const started = Date.now();
  const checks = [];
  const repo = repoInfo();

  // 1. Runtime env loaded
  const envFile = join(BACKEND_ROOT, '../.gptwork/runtime.env');
  const envExists = existsSync(envFile);
  let envVars = {};
  if (envExists) {
    try {
      const content = await readFile(envFile, 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        const [k, ...rest] = line.split('=');
        if (k && rest.length) envVars[k.trim()] = rest.join('=').trim();
      }
    } catch { /* ignore */ }
  }
  checks.push({
    check: 'runtime env loaded',
    passed: envExists,
    detail: envExists ? `path=${envFile} vars=${Object.keys(envVars).length}` : 'runtime.env not found (non-blocking for dev)',
  });

  // 2. Canonical repo clean
  checks.push({
    check: 'canonical repo clean',
    passed: !repo.dirty,
    detail: repo.dirty ? `dirty with ${repo.dirty_count} changes` : 'clean',
  });

  // 3. Active / stale locks check
  const lockDir = join(BACKEND_ROOT, '../.gptwork');
  let lockFiles = [];
  let staleLocks = 0;
  let activeLocks = 0;
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const entries = await readdir(lockDir).catch(() => []);
    for (const entry of entries) {
      if (entry.includes('lock') || entry.endsWith('.lock') || entry.startsWith('lock_')) {
        lockFiles.push(entry);
        try {
          const st = await stat(join(lockDir, entry));
          const ageHours = (Date.now() - st.mtimeMs) / (1000 * 3600);
          if (ageHours > 24) staleLocks++;
          else activeLocks++;
        } catch { lockFiles.push(entry); }
      }
    }
  } catch { /* ignore */ }
  checks.push({
    check: 'lock state',
    passed: staleLocks === 0,
    detail: `lock_files=${lockFiles.length} active=${activeLocks} stale=${staleLocks}`,
    advisory: staleLocks > 0 ? `stale lock files: ${lockFiles.filter(f => f.includes('lock')).join(', ')}` : null,
  });

  // 4. Retained worktrees / branches cleanup advisory
  const worktreeDir = join(BACKEND_ROOT, '../.gptwork/worktrees');
  let worktreeCount = 0;
  let worktreeDirExists = false;
  try {
    worktreeDirExists = existsSync(worktreeDir);
    if (worktreeDirExists) {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(worktreeDir);
      worktreeCount = entries.length;
    }
  } catch { /* ignore */ }

  // Check git worktree list for retained worktrees
  let gitWorktrees = [];
  try {
    const output = runGit(['worktree', 'list', '--porcelain'], repo.root);
    gitWorktrees = output ? output.split('\n\n').filter(Boolean) : [];
  } catch { /* ignore */ }

  checks.push({
    check: 'worktree cleanup status',
    passed: true,
    detail: `git_worktrees=${gitWorktrees.length} worktree_dir_entries=${worktreeCount}`,
    advisory: gitWorktrees.length > 2 ? `Found ${gitWorktrees.length} git worktrees. Retained worktrees are normal for active GPTWork development. Run 'git worktree prune' manually if cleanup is desired.` : null,
  });

  // 5. Worker health check
  let workerOk = false;
  try {
    const workerMod = await import(join(SRC_DIR, 'codex-worker-state.mjs'));
    workerOk = typeof workerMod === 'object' && workerMod !== null;
  } catch { /* not installed yet — non-blocking */ }
  checks.push({
    check: 'worker state module loadable',
    passed: workerOk,
    detail: workerOk ? 'codex-worker-state.mjs loaded' : 'worker state module not available (non-blocking for fresh install check)',
  });

  // 6. Current blockers count — scan for any real blockers
  let blockersCount = 0;
  try {
    const { readdir, readFile: rf } = await import('node:fs/promises');
    const blockersDir = join(BACKEND_ROOT, '../.gptwork/goals');
    const goalDirs = await readdir(blockersDir).catch(() => []);
    for (const gDir of goalDirs) {
      const resultPath = join(blockersDir, gDir, 'result.json');
      if (existsSync(resultPath)) {
        try {
          const content = await rf(resultPath, 'utf8');
          const result = JSON.parse(content);
          if (result.status === 'failed' || result.status === 'blocked') blockersCount++;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  checks.push({
    check: 'current blockers',
    passed: blockersCount === 0,
    detail: `failed/blocked results: ${blockersCount}`,
    advisory: blockersCount > 0 ? `found ${blockersCount} previous failed/blocked results` : null,
  });

  const duration = Date.now() - started;
  const passed = checks.every(c => c.passed);
  return { name: 'diagnostics', passed, checks, duration_ms: duration, repo };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const jsonReportPath = argValue('--json-report');
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();

  console.log(`\n==========================================================`);
  console.log(`  GPTWork Release Gate v${GATE_VERSION}`);
  console.log(`  P0-C10b: Fresh Install → Demo Goal → Auto Close`);
  console.log(`==========================================================\n`);

  const sections = [
    await sectionSelfTest(),
    await sectionReadonlyDemo(),
    await sectionMutatingDemo(),
    await sectionQueueAutoAdvance(),
    await sectionDiagnostics(),
  ];

  // Mandatory scenarios (sections 1-4), diagnostics (section 5) is advisory
  const mandatorySections = sections.slice(0, 4);
  const diagnosticSection = sections.slice(4);
  const totalChecks = sections.reduce((sum, s) => sum + s.checks.length, 0);
  const failedChecks = sections.reduce((sum, s) => sum + s.checks.filter(c => !c.passed).length, 0);
  const mandatoryFailedChecks = mandatorySections.reduce((sum, s) => sum + s.checks.filter(c => !c.passed).length, 0);
  const failedSections = sections.filter(s => !s.passed);
  const blockers = sections.flatMap(s => s.checks.filter(c => !c.passed));
  const advisories = sections.flatMap(s => s.checks.filter(c => c.advisory).map(c => ({ check: c.check, advisory: c.advisory })));

  // Build Go/No-Go report
  // GO requires all mandatory scenarios pass; diagnostics are advisory
  const goNoGo = mandatoryFailedChecks === 0 ? 'GO' : 'NO-GO';
  const durationMs = Date.now() - startedMs;

  console.log(`\n--- GATE REPORT ---`);
  console.log(`Gate version: ${GATE_VERSION}`);
  console.log(`Duration: ${formatDuration(durationMs)}`);
  console.log(`Sections: ${sections.length}`);
  console.log(`Checks: ${totalChecks} total, ${failedChecks} failed`);
  console.log(`Result: ${goNoGo}`);
  console.log('');
  console.log('  [Mandatory Scenarios]');
  for (const section of mandatorySections) {
    const icon = section.passed ? '✓' : '✗';
    console.log(`  ${icon} ${section.name} (${formatDuration(section.duration_ms)})`);
    for (const check of section.checks) {
      const cIcon = check.passed ? '  ✓' : '  ✗';
      console.log(`  ${cIcon} ${check.check}: ${check.detail || ''}`);
      if (check.advisory) console.log(`       advisory: ${check.advisory}`);
    }
  }
  console.log('');
  console.log('  [Diagnostics (informational)]');
  for (const section of diagnosticSection) {
    console.log(`  ${section.name} (${formatDuration(section.duration_ms)})`);
    for (const check of section.checks) {
      const cIcon = check.passed ? '  ✓' : '  ✗';
      console.log(`  ${cIcon} ${check.check}: ${check.detail || ''}`);
      if (check.advisory) console.log(`       advisory: ${check.advisory}`);
    }
  }

  if (failedSections.length > 0) {
    console.log(`\n--- BLOCKERS (${blockers.length}) ---`);
    for (const blocker of blockers) {
      console.log(`  ✗ ${blocker.check}: ${blocker.detail || 'no detail'}`);
    }
  }

  if (advisories.length > 0) {
    console.log(`\n--- ADVISORIES (${advisories.length}) ---`);
    for (const adv of advisories) {
      console.log(`  ~ ${adv.check}: ${adv.advisory}`);
    }
  }

  console.log(`\n=== ${goNoGo} ===`);

  // Write JSON report
  const report = {
    schema_version: 1,
    gate_version: GATE_VERSION,
    scenario: 'P0-C10b',
    passed: goNoGo === 'GO',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
    cwd: BACKEND_ROOT,
    go_no_go: goNoGo,
    sections: sections.map(s => ({
      name: s.name,
      passed: s.passed,
      duration_ms: s.duration_ms,
      checks: s.checks.map(c => ({
        check: c.check,
        passed: c.passed,
        detail: c.detail || null,
        advisory: c.advisory || null,
      })),
      repo: s.repo || null,
    })),
    summary: {
      total_sections: sections.length,
      passed_sections: sections.filter(s => s.passed).length,
      total_checks: totalChecks,
      passed_checks: totalChecks - failedChecks,
      failed_checks: failedChecks,
      blockers: blockers.length,
      advisories: advisories.length,
    },
    blockers: blockers.map(b => ({ check: b.check, detail: b.detail })),
    advisories: advisories.map(a => ({ check: a.check, advisory: a.advisory })),
  };

  if (jsonReportPath) {
    const absolutePath = resolve(jsonReportPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\njson report: ${jsonReportPath}`);
  }

  process.exit(goNoGo === 'GO' ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
