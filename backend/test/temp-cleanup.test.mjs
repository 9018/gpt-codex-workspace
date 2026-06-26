/**
 * temp-cleanup.test.mjs — Tests for helpers/temp-cleanup.mjs
 *
 * Note: these tests share a singleton tracked-dir Set, so we clean up
 * at the start of each test to avoid cross-test contamination.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { track, afterEachHook, cleanupTracked, getTracked } from "./helpers/temp-cleanup.mjs";

test("track adds a path and getTracked returns a copy", async () => {
  await cleanupTracked();
  const n = getTracked().length;
  track("/tmp/_test-track-1");
  assert.equal(getTracked().length, n + 1);
  assert.ok(getTracked().includes("/tmp/_test-track-1"));
  // getTracked returns a copy, so mutations outside do not affect the internal set
  const arr = getTracked();
  arr.pop();
  assert.ok(getTracked().includes("/tmp/_test-track-1"));
  await cleanupTracked();
});

test("cleanupTracked removes tracked dirs and clears the set", async () => {
  await cleanupTracked();
  const d1 = join(tmpdir(), `_test-ct-1-${Date.now()}`);
  const d2 = join(tmpdir(), `_test-ct-2-${Date.now()}`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(d1, { recursive: true });
  await mkdir(d2, { recursive: true });

  track(d1);
  track(d2);

  assert.equal(getTracked().length, 2);
  await cleanupTracked();
  assert.equal(getTracked().length, 0);

  // Verify dirs are actually removed
  assert.equal(readdirSync(tmpdir()).filter(e => e.includes("_test-ct-")).length, 0);
});

test("cleanupTracked handles non-existent dirs without throwing", async () => {
  await cleanupTracked();
  const missing = join(tmpdir(), `_test-nonexist-${Date.now()}`);
  track(missing);
  // rm with force:true should not throw for non-existent paths
  await cleanupTracked();
  assert.equal(getTracked().length, 0);
});

test("track returns the same path for chaining", async () => {
  await cleanupTracked();
  const { mkdir } = await import("node:fs/promises");
  const dir = join(tmpdir(), `_test-chain-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const returned = track(dir);
  assert.equal(returned, dir);
  await cleanupTracked();
});

test("afterEachHook registers cleanup on node:test context (simulated)", async () => {
  await cleanupTracked();
  const d = join(tmpdir(), `_test-aftereach-${Date.now()}`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(d, { recursive: true });
  track(d);
  // Manually simulate what afterEach would do
  await cleanupTracked();
  assert.equal(getTracked().length, 0);
  assert.equal(readdirSync(tmpdir()).filter(e => e.includes("_test-aftereach-")).length, 0);
});

test("productization-p0-style temp dirs are properly handled via helper", async () => {
  await cleanupTracked();
  // Simulate the pattern from productization-p0.test.mjs
  const d = await mkdtemp(join(tmpdir(), "gptwork-p0-"));
  track(d);
  await writeFile(join(d, "test.txt"), "hello", "utf8");

  // Verify dir exists and has content
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(join(d, "test.txt"), "utf8");
  assert.equal(content, "hello");

  // Cleanup
  await cleanupTracked();

  // Verify dir is gone
  const { stat } = await import("node:fs/promises");
  await assert.rejects(() => stat(d), { code: "ENOENT" });
});
