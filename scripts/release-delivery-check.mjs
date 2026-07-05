#!/usr/bin/env node

/**
 * release-delivery-check.mjs — Root-level wrapper.
 *
 * Delegates to backend/scripts/release-delivery-check.mjs.
 * Defaults to --full profile for release verification.
 *
 * Usage:
 *   node scripts/release-delivery-check.mjs [--fast|--full]
 *   node scripts/release-delivery-check.mjs --profile <fast|full|changed>
 *   node scripts/release-delivery-check.mjs [options...]
 *
 * Profiles (default: full):
 *   --fast         Fast pre-merge smoke check (syntax + imports + core tests)
 *   --full         Complete release gate (E2E, compatibility, dual-mode)
 *   --profile <p>  Explicit profile: fast, full, or changed
 *
 * All other arguments are forwarded to the backend script.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const backendScript = join(rootDir, 'backend', 'scripts', 'release-delivery-check.mjs');

const args = process.argv.slice(2);

// Default to --full if no profile flag is present
const hasProfileFlag = args.some(a => a === '--fast' || a === '--full' || a === '--profile' || a === '--changed');
if (!hasProfileFlag) {
  args.unshift('--full');
}

const child = spawn(process.execPath, [backendScript, ...args], {
  cwd: rootDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
