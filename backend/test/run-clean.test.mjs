import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runFixture(source) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "run-clean-fixture-"));
  const fixture = join(fixtureRoot, "fixture.test.mjs");
  const marker = join(fixtureRoot, "marker.txt");
  await writeFile(fixture, source.replaceAll("__MARKER__", JSON.stringify(marker)));
  const child = spawn(process.execPath, ["test/helpers/run-clean.mjs", fixture], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  let tempPath = null;
  try { tempPath = await readFile(marker, "utf8"); } catch {}
  return { code, fixtureRoot, tempPath, stdout, stderr };
}

test("run-clean removes its isolated TMPDIR after a passing child", async () => {
  const result = await runFixture(`
    import test from 'node:test';
    import { writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    test('fixture', async () => { await writeFile(__MARKER__, tmpdir()); });
  `);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.ok(result.tempPath, result.stderr || result.stdout);
  await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(result.tempPath)), { code: "ENOENT" });
  await rm(result.fixtureRoot, { recursive: true, force: true });
});

test("run-clean removes its isolated TMPDIR after a failing child", async () => {
  const result = await runFixture(`
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    test('fixture', async () => { await writeFile(__MARKER__, tmpdir()); assert.fail('expected'); });
  `);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.ok(result.tempPath, result.stderr || result.stdout);
  await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(result.tempPath)), { code: "ENOENT" });
  await rm(result.fixtureRoot, { recursive: true, force: true });
});
