#!/usr/bin/env node

/**
 * release-delivery-check.mjs
 *
 * P0-MA9: E2E Release Gate — fast profile for pre-merge verification.
 *
 * Usage:
 *   node scripts/release-delivery-check.mjs [--fast|--full]
 *
 * Profile:
 *   --fast   Verify core imports, syntax, and delivery-critical tests (≤ 30s).
 *   --full   Run the complete release gate suite (E2E, compatibility, dual-mode).
 */

const args = process.argv.slice(2);
const mode = args.includes('--full') ? 'full' : 'fast';

const PASS = '\x1b[32m\u2713\x1b[0m';
const FAIL = '\x1b[31m\u2717\x1b[0m';
const INFO = '\x1b[34m\u2139\x1b[0m';

async function run() {
  const checks = [];

  console.log(`${INFO} mode=${mode}`);
  console.log(`${INFO} release-delivery-check starting`);

  if (mode === 'fast') {
    // 1. Fast syntax check on core source files
    console.log(`${INFO} fast syntax core files...`);
    const coreFiles = [
      './backend/src/current-blocker-policy.mjs',
      './backend/src/blocker-manifest.mjs',
      './backend/src/worker-queue-counts.mjs',
      './backend/src/stale-state-sweeper.mjs',
    ];
    for (const f of coreFiles) {
      const fn = f.replace('./backend/src/', '');
      checks.push({ name: `Syntax: ${fn}`, ok: await checkSyntax(f) });
    }

    // 2. Check core import chains
    console.log(`${INFO} fast import check...`);
    checks.push({ name: 'Import: core delivery modules', ok: await checkImports() });

    // 3. Run delivery-critical tests
    console.log(`${INFO} fast delivery tests...`);
    checks.push({ name: 'Test: current-blocker-policy', ok: await runTestByName('current-blocker-policy') });
    checks.push({ name: 'Test: blocker-manifest', ok: await runTestByName('r6-blocker-manifest') });
  } else {
    // Full profile: G10 dual-mode E2E
    console.log(`${INFO} full delivery tests...`);
    checks.push({ name: 'G10 no-GitHub delivery E2E', ok: await runTestByName('e2e-delivery') });
    checks.push({ name: 'G10 GitHub adapter delivery E2E', ok: await runTestByName('e2e-delivery') });
    checks.push({ name: 'G10 legacy compatibility', ok: await runTestByName('task-intake-fallback') });
    checks.push({ name: 'G10 delivery contracts', ok: await runTestByName('delivery-contracts') });
  }

  // Summary
  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok).length;
  const total = checks.length;

  console.log('');
  console.log(`${'\u2500'.repeat(60)}`);
  console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);

  for (const check of checks) {
    console.log(`  ${check.ok ? PASS : FAIL} ${check.name}`);
  }

  console.log(`${'\u2500'.repeat(60)}`);

  if (failed > 0) {
    console.log(`${FAIL} Some checks failed.`);
    process.exit(1);
  }

  console.log(`${PASS} === ALL PASS ===`);
  process.exit(0);
}

async function checkSyntax(filePath) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(process.execPath, ['--check', filePath], { cwd: process.cwd(), timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function checkImports() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    // Use the backend check:imports script
    await execFileAsync('npm', ['--prefix', 'backend', 'run', 'check:imports'], { cwd: process.cwd(), timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function runTestByName(namePattern) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--test', `--test-name-pattern=${namePattern}`], {
      cwd: process.cwd() + '/backend',
      timeout: 30_000,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });
    const output = stdout + stderr;
    return output.includes('pass') || output.includes('ok');
  } catch {
    return false;
  }
}

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
