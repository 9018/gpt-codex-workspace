import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
