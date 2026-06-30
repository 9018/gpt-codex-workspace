import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("scripts/check-syntax.mjs");

async function runCheck(args = [], options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...(options.env || {}) },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
  }
}

test("check-syntax exits zero for an empty explicit file set", async () => {
  const result = await runCheck(["--files", ""]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /syntax ok: 0 file\(s\)/);
  assert.match(result.stdout, /duration=/);
});

test("check-syntax exits zero for normal explicit files", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-syntax-ok-")));
  const file = join(root, "ok.mjs");
  await writeFile(file, "export const ok = true;\n", "utf8");

  const result = await runCheck(["--files", file], { env: { GPTWORK_CHECK_SYNTAX_CONCURRENCY: "1" } });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /syntax ok: 1 file\(s\)/);
});

test("check-syntax reports syntax error file, exit code, and stderr tail", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-syntax-bad-")));
  const file = join(root, "bad.mjs");
  await writeFile(file, "export const broken = ;\n", "utf8");

  const result = await runCheck(["--files", file], { env: { GPTWORK_CHECK_SYNTAX_CONCURRENCY: "1" } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bad\.mjs/);
  assert.match(result.stderr, /exit=/);
  assert.match(result.stderr, /stderr tail/);
});

test("check-syntax discovers src mjs and test test.mjs files", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-syntax-discover-")));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src", "covered.mjs"), "export const src = 1;\n", "utf8");
  await writeFile(join(root, "test", "covered.test.mjs"), "import test from 'node:test';\ntest('ok', () => {});\n", "utf8");
  await writeFile(join(root, "test", "not-covered.mjs"), "export const ignored = ;\n", "utf8");

  const result = await runCheck([], { cwd: root, env: { GPTWORK_CHECK_SYNTAX_CONCURRENCY: "2" } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /syntax ok: 2 file\(s\)/);
}
);
