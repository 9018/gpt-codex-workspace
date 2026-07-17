import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const finalWritebackPath = resolve(__dirname, "../../src/task-final-writeback.mjs");

test("task-final-writeback remains a re-export facade", async () => {
  const source = await readFile(finalWritebackPath, "utf8");
  const meaningfulLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));

  assert.deepEqual(meaningfulLines, [
    'export { finalizeCodexTaskRun } from "./task-finalization/task-final-writeback-runner.mjs";',
  ]);
});
