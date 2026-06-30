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

test("runLocalShell records warning when stream log setup fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptwork-run-shell-warning-"));
  try {
    const result = await runLocalShell(
      "node -e \"process.stdout.write('out')\"",
      dir,
      5,
      10000,
      null,
      { streamStdoutPath: dir }
    );

    assert.equal(result.returncode, 0);
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.some((warning) => warning.code === "stream_log_setup_failed" && warning.stream === "stdout"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLocalShell records contentful output metrics when classifier matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptwork-contentful-shell-"));
  try {
    const seen = [];
    const result = await runLocalShell(
      "node -e \"process.stderr.write('banner\\n'); setTimeout(() => process.stderr.write('assistant started\\n'), 20)\"",
      dir,
      5,
      10000,
      null,
      {
        contentFirstOutputTimeoutSeconds: 2,
        noProgressTimeoutSeconds: 2,
        isContentfulOutput: ({ chunk }) => chunk.includes("assistant"),
        onOutput: (event) => seen.push(event),
      }
    );

    assert.equal(result.returncode, 0);
    assert.equal(result.no_content_first_output_timeout, false);
    assert.ok(result.content_first_output_at, "content first output timestamp should be set");
    assert.ok(result.content_first_output_delay_ms >= 0, "content delay should be numeric");
    assert.ok(result.last_content_progress_at, "last content progress should be set");
    assert.ok(seen.some((event) => event.content_first_output_at), "onOutput should receive content metrics");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLocalShell can time out when no contentful output appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptwork-content-timeout-shell-"));
  try {
    const result = await runLocalShell(
      "node -e \"process.stderr.write('banner\\n'); setTimeout(() => {}, 2000)\"",
      dir,
      5,
      10000,
      null,
      {
        contentFirstOutputTimeoutSeconds: 1,
        isContentfulOutput: ({ chunk }) => chunk.includes("assistant"),
      }
    );

    assert.equal(result.timed_out, true);
    assert.equal(result.no_content_first_output_timeout, true);
    assert.equal(result.no_first_output_timeout, false);
    assert.equal(result.content_first_output_at, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
