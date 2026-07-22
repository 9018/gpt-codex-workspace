#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCleanTestEnvironment } from "./run-clean-environment.mjs";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testArgs = process.argv.slice(2);
const nodeArgs = testArgs.length > 0 ? ["--test", ...testArgs] : ["--test", "test/**/*.test.mjs"];
const runTmpRoot = await mkdtemp(join(tmpdir(), "gptwork-test-run-"));
const childEnv = buildCleanTestEnvironment(runTmpRoot);
await mkdir(childEnv.HOME, { recursive: true });
let child = null;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await rm(runTmpRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child?.kill(signal);
  });
}

try {
  child = spawn(process.execPath, nodeArgs, {
    stdio: "inherit",
    cwd: backendRoot,
    env: childEnv,
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveExit(signal ? 1 : (exitCode ?? 1)));
  });
  await cleanup();
  process.exit(code);
} catch (error) {
  await cleanup();
  console.error(error);
  process.exit(1);
}
