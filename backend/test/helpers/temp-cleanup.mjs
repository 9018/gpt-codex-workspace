/**
 * temp-cleanup.mjs — Unified test temp directory tracking and cleanup helper
 *
 * Helps tests that create temporary directories via mkdtemp / tmpdir to track
 * them and clean up reliably after each test.
 *
 * Usage:
 *   import { track, afterEachHook, cleanupTracked, getTracked } from "../helpers/temp-cleanup.mjs";
 *   import test from "node:test";
 *
 *   afterEachHook(test);
 *
 *   test("something", async () => {
 *     const dir = track(await mkdtemp(join(tmpdir(), "my-test-")));
 *     // ... test logic ...
 *   });
 *   // dir is auto-removed after each test via the registered afterEach hook.
 *
 * For manual cleanup (without afterEach), call cleanupTracked() directly.
 *
 * Design principle: cleanup failures are never silently swallowed.
 * Each failure is emitted via console.warn so test output visibility is maintained
 * without breaking a best-effort cleanup.
 */

import { rm } from "node:fs/promises";

/** Set of tracked temp directories */
const _tracked = new Set();

/**
 * Track a temp directory for automatic cleanup.
 * Returns the same path so it can be used in an expression:
 *   const dir = track(await mkdtemp(join(tmpdir(), "prefix-")));
 *
 * @param {string} dir - Absolute path to a temp directory
 * @returns {string} the same dir
 */
export function track(dir) {
  _tracked.add(dir);
  return dir;
}

/**
 * Register an afterEach hook on the given test context.
 * After every test in the file, all tracked temp dirs are cleaned.
 * Failures are reported via console.warn but do not fail the test.
 *
 * @param {import("node:test")} test - The node:test module
 */
export function afterEachHook(test) {
  test.afterEach(async () => {
    await cleanupTracked();
  });
}

/**
 * Manually remove all tracked temp directories.
 * Each removal failure is logged via console.warn.
 * After calling, the tracked set is cleared regardless of individual failures.
 */
export async function cleanupTracked() {
  for (const d of _tracked) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[temp-cleanup] failed to remove ${d}: ${err.message}`);
    }
  }
  _tracked.clear();
}

/**
 * Returns a copy of the currently tracked paths (for test inspection).
 */
export function getTracked() { return [..._tracked]; }
