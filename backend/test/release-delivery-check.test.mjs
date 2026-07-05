import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("release-delivery-check --fast completes within the short gate window", { timeout: 45_000 }, async () => {
  const started = Date.now();
  const result = await execFileAsync(process.execPath, ["scripts/release-delivery-check.mjs", "--fast"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 1024 * 1024,
  });
  const elapsed = Date.now() - started;

  assert.match(result.stdout, /mode=fast/);
  assert.match(result.stdout, /fast syntax core files/);
  assert.match(result.stdout, /=== ALL PASS ===/);
  assert.ok(elapsed < 40_000, `fast release gate took ${elapsed}ms`);
});

test("release-delivery-check full profile gates G10 dual-mode E2E and compatibility coverage", async () => {
  const source = await readFile("scripts/release-delivery-check.mjs", "utf8");

  assert.match(source, /G10 no-GitHub delivery E2E/);
  assert.match(source, /G10 GitHub adapter delivery E2E/);
  assert.match(source, /G10 legacy compatibility tests/);
  assert.match(source, /test\/e2e-delivery\.test\.mjs/);
  assert.match(source, /test\/task-intake-fallback\.test\.mjs/);
  assert.match(source, /test\/delivery-contracts\.test\.mjs/);
});

test("root wrapper delegates to backend script and defaults to --full profile", async () => {
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");

  // Root script: ../../scripts/release-delivery-check.mjs relative to backend/test/
  const rootScript = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "release-delivery-check.mjs");

  // Verify root wrapper source references the backend script
  const rootSource = await readFile(rootScript, "utf8");
  assert.match(rootSource, /backend\/scripts\/release-delivery-check\.mjs/,
    "root wrapper should reference backend script");
  assert.match(rootSource, /--full/,
    "root wrapper should default to --full profile");
  assert.match(rootSource, /hasProfileFlag/,
    "root wrapper should detect profile flag presence");
});

test("root wrapper passes --fast through to backend and produces fast output", { timeout: 45_000 }, async () => {
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");

  const result = await execFileAsync(process.execPath, [
    "scripts/release-delivery-check.mjs", "--fast",
  ], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(result.stdout, /mode=fast/);
  assert.match(result.stdout, /=== ALL PASS ===/);
});

test("root wrapper defaults to --full when no profile flag given", { timeout: 300_000 }, async () => {
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");

  // Run without any flags — should default to --full by the wrapper
  const result = await execFileAsync(process.execPath, [
    "scripts/release-delivery-check.mjs",
  ], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    encoding: "utf8",
    timeout: 280_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  assert.match(result.stdout, /mode=full/);
  assert.match(result.stdout, /=== ALL PASS ===/);
});
