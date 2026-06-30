#!/usr/bin/env node
/**
 * release-delivery-check.mjs — Release gate for delivery system.
 * ESM module. Runs from backend/ root.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 180_000;
const FAST_TIMEOUT_MS = 180_000;

function tail(value, max = 2000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const { execFileSync } = await import("node:child_process");
  const fast = process.argv.includes('--fast');

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
  const steps = fast ? fastSteps : fullSteps;

  const failures = [];
  console.log(`[release-delivery-check] mode=${fast ? 'fast' : 'full'} steps=${steps.length}`);
  for (const step of steps) {
    const timeout = step.timeout || (fast ? FAST_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    console.log(`[RUN] ${step.name} timeout=${formatDuration(timeout)}`);
    try {
      const stdout = execFileSync(step.cmd, step.args, { cwd: backendRoot, stdio: "pipe", timeout, encoding: "utf8" });
      console.log(`[PASS] ${step.name} duration=${formatDuration(Date.now() - started)}`);
      if (stdout.trim()) console.log(tail(stdout, 1200));
    } catch (err) {
      const failure = {
        name: step.name,
        exit_code: typeof err.status === 'number' ? err.status : (typeof err.code === 'number' ? err.code : 1),
        signal: err.signal || null,
        duration_ms: Date.now() - started,
        stdout_tail: tail(err.stdout),
        stderr_tail: tail(err.stderr || err.message),
      };
      failures.push(failure);
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
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
