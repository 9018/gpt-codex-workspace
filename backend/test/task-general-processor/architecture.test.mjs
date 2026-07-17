import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const backendRoot = new URL("../..", import.meta.url);

test("legacy task-general-processor path is a thin compatibility facade", async () => {
  const source = await readFile(new URL("src/task-general-processor.mjs", backendRoot), "utf8");
  const lines = source.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
  assert.ok(lines.length <= 10, `compatibility facade has ${lines.length} non-comment lines`);
  assert.match(source, /task-processing\/task-general-processor\.mjs/);
  assert.doesNotMatch(source, /function processGeneralTaskWithDeps/);
});

test("task-processing low-level modules do not import final writeback or queue modules", async () => {
  const dir = new URL("src/task-processing/", backendRoot);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".mjs"));
  const violations = [];
  for (const file of files) {
    if (["task-general-processor.mjs", "task-processing-pipeline.mjs", "task-execution-runner.mjs"].includes(file)) continue;
    const source = await readFile(new URL(file, dir), "utf8");
    if (/task-final-writeback|goal-queue|integration-queue/.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});

test("task-processing exposes the planned module boundaries", async () => {
  const dir = new URL("src/task-processing/", backendRoot);
  const files = new Set(await readdir(dir));
  for (const expected of [
    "task-general-processor.mjs",
    "task-processing-pipeline.mjs",
    "task-execution-context.mjs",
    "task-worktree-verifier.mjs",
    "task-provider-dispatcher.mjs",
    "task-execution-runner.mjs",
    "task-result-normalizer.mjs",
    "task-delivery-recovery.mjs",
    "task-healing-controller.mjs",
    "task-repair-context.mjs",
    "task-processing-errors.mjs",
    "task-processing-types.mjs",
  ]) {
    assert.ok(files.has(expected), `missing task-processing/${expected}`);
  }
});

test("task-processing pipeline is a compact explicit-stage orchestrator", async () => {
  const source = await readFile(new URL("src/task-processing/task-processing-pipeline.mjs", backendRoot), "utf8");
  const lines = source.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
  assert.ok(lines.length <= 300, `task-processing pipeline has ${lines.length} non-comment lines`);
  for (const stage of ["prepareTaskExecution", "dispatchAndRun", "collectAndNormalizeResult", "verifyDelivery", "recoverOrRepair", "finalizeProcessing"]) {
    assert.match(source, new RegExp(`\\b${stage}\\b`), `missing explicit stage ${stage}`);
  }
});
