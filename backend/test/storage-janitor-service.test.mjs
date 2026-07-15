import test from "node:test";
import assert from "node:assert/strict";
import { runStorageJanitor, startStorageJanitor } from "../src/storage-janitor-service.mjs";

test("runStorageJanitor performs aged cleanup and classifies inode pressure", async () => {
  let cleanupArgs = null;
  const result = await runStorageJanitor({
    getPressure: async () => ({ used_pct: "78%", used_inodes: 780, total_inodes: 1000 }),
    cleanup: async (args) => { cleanupArgs = args; return { deleted: 4, deleted_inodes: 120 }; },
    maxAgeMs: 1234,
  });
  assert.equal(result.ok, true);
  assert.equal(result.severity, "warning");
  assert.equal(result.pressure_pct, 78);
  assert.equal(result.deleted_entries, 4);
  assert.equal(cleanupArgs.dryRun, false);
  assert.equal(cleanupArgs.maxAgeMs, 1234);
});

test("runStorageJanitor reports critical pressure and treats failures as non-fatal", async () => {
  const result = await runStorageJanitor({
    getPressure: async () => ({ used_pct: "91%" }),
    cleanup: async () => { throw new Error("boom"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.severity, "critical");
  assert.match(result.error, /boom/);
});

test("startStorageJanitor runs immediately and installs an unref timer", async () => {
  let runs = 0;
  let intervalMs = null;
  let unrefCalled = false;
  const timer = { unref() { unrefCalled = true; } };
  const controller = startStorageJanitor({
    run: async () => { runs += 1; return { ok: true }; },
    intervalMs: 4567,
    setIntervalFn(fn, ms) { intervalMs = ms; return timer; },
    clearIntervalFn() {},
  });
  await controller.initialRun;
  assert.equal(runs, 1);
  assert.equal(intervalMs, 4567);
  assert.equal(unrefCalled, true);
  controller.stop();
});
