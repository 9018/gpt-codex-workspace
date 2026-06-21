import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLocalShell } from "../src/workspace-service.mjs";

test("runLocalShell streams stdout and stderr to log files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptwork-run-shell-"));
  try {
    const stdoutPath = join(dir, "logs", "stdout.log");
    const stderrPath = join(dir, "logs", "stderr.log");
    const result = await runLocalShell(
      "node -e \"process.stdout.write('out'); process.stderr.write('err')\"",
      dir,
      5,
      10000,
      null,
      { streamStdoutPath: stdoutPath, streamStderrPath: stderrPath }
    );

    assert.equal(result.returncode, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(await readFile(stdoutPath, "utf8"), "out");
    assert.equal(await readFile(stderrPath, "utf8"), "err");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
