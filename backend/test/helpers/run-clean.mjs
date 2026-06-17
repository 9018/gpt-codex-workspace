#!/usr/bin/env node
/**
 * Run the backend test suite with a clean environment.
 *
 * Clears all GPTWORK_* environment variables before spawning node --test,
 * preventing inherited production/development values from affecting tests.
 *
 * Usage:
 *   node test/helpers/run-clean.mjs
 *
 * (Called from npm run test:clean)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Clear all GPTWORK_* vars from the current process environment
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GPTWORK_")) {
    delete process.env[key];
  }
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(dirname, "..", "..");

const testProcess = spawn(
  "node",
  ["--test", "test/**/*.test.mjs"],
  {
    stdio: "inherit",
    cwd: backendRoot,
    env: process.env,
  }
);

testProcess.on("exit", (code) => {
  process.exit(code ?? 1);
});
