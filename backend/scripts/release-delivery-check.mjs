#!/usr/bin/env node
/**
 * release-delivery-check.mjs — Release gate for delivery system.
 * ESM module. Runs from backend/ root.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

async function main() {
  const { execFileSync } = await import("node:child_process");

  // Run from backend/ root, NOT from scripts/ directory
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const backendRoot = join(scriptsDir, '..');

  const steps = [
    { name: "check:syntax", cmd: "npm", args: ["run", "check:syntax"] },
    { name: "check:imports", cmd: "npm", args: ["run", "check:imports"] },
    { name: "delivery-contracts test", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/delivery-contracts.test.mjs",
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
    ]},
    { name: "E2E delivery test", cmd: "node", args: [
      "--test", "--test-reporter=dot",
      "test/e2e-delivery.test.mjs",
    ]},
  ];

  let allPassed = true;
  for (const step of steps) {
    process.stdout.write(`[RUN] ${step.name}... `);
    try {
      execFileSync(step.cmd, step.args, { cwd: backendRoot, stdio: "pipe", timeout: 120000 });
      console.log("PASS");
    } catch (err) {
      console.log("FAIL");
      console.error(err.stderr?.toString().slice(0, 500) || err.message);
      allPassed = false;
    }
  }

  console.log(`\n=== ${allPassed ? "ALL PASS" : "SOME FAILED"} ===`);
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
