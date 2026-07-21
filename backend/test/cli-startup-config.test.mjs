import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./helpers/env-isolation.mjs";
import { clearGptWorkVars } from "./helpers/env-isolation.mjs";

test("resolveCliStartupConfig drives startup settings from unified runtime config", async () => {
  clearGptWorkVars();
  const { resolveCliStartupConfig } = await import("../src/cli-startup-config.mjs");
  const root = await mkdtemp(join(tmpdir(), "gptwork-cli-startup-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "runtime.env");
  await writeFile(envFile, [
    "GPTWORK_HOST=0.0.0.0",
    "GPTWORK_PORT=9901",
    "GPTWORK_CODEX_WORKER=true",
    "GPTWORK_LOG_PATH=/tmp/gptwork-startup-from-runtime-env.log",
    "",
  ].join("\n"), "utf8");

  const resolved = resolveCliStartupConfig({
    cwd: root,
    env: { GPTWORK_RUNTIME_ENV_FILE: envFile },
  });

  assert.equal(resolved.config.host, "0.0.0.0");
  assert.equal(resolved.config.port, 9901);
  assert.equal(resolved.config.codexWorker, true);
  assert.equal(resolved.config.logPath, "/tmp/gptwork-startup-from-runtime-env.log");
  assert.equal(resolved.sources.host, "runtime.env");
  assert.equal(resolved.sources.port, "runtime.env");
  assert.equal(resolved.sources.codexWorker, "runtime.env");
  assert.equal(resolved.sources.logPath, "runtime.env");
});

test("resolveCliStartupConfig keeps process.env precedence over runtime.env", async () => {
  clearGptWorkVars();
  const { resolveCliStartupConfig } = await import("../src/cli-startup-config.mjs");
  const root = await mkdtemp(join(tmpdir(), "gptwork-cli-startup-precedence-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "runtime.env");
  await writeFile(envFile, "GPTWORK_PORT=9901\nGPTWORK_CODEX_WORKER=true\n", "utf8");

  const resolved = resolveCliStartupConfig({
    cwd: root,
    env: {
      GPTWORK_RUNTIME_ENV_FILE: envFile,
      GPTWORK_PORT: "9902",
      GPTWORK_CODEX_WORKER: "false",
    },
  });

  assert.equal(resolved.config.port, 9902);
  assert.equal(resolved.config.codexWorker, false);
  assert.equal(resolved.sources.port, "process.env");
  assert.equal(resolved.sources.codexWorker, "process.env");
});


test("resolveCliStartupConfig started from backend loads repository .gptwork/runtime.env", async () => {
  clearGptWorkVars();
  const { resolveCliStartupConfig } = await import("../src/cli-startup-config.mjs");
  const root = await mkdtemp(join(tmpdir(), "gptwork-cli-backend-cwd-"));
  await mkdir(join(root, "backend"), { recursive: true });
  await mkdir(join(root, ".gptwork"), { recursive: true });
  await writeFile(join(root, ".gptwork", "runtime.env"), [
    "GPTWORK_TOOL_MODE=full",
    "GPTWORK_RECOVERY_PLANE_ENABLED=true",
    "",
  ].join("\n"), "utf8");

  const resolved = resolveCliStartupConfig({
    cwd: join(root, "backend"),
    env: {},
  });

  assert.equal(resolved.config.toolMode, "full");
  assert.equal(resolved.config.recoveryPlaneEnabled, true);
  assert.equal(resolved.sources.toolMode, "runtime.env");
  assert.equal(resolved.sources.recoveryPlaneEnabled, "runtime.env");
  assert.equal(resolved.envLoadResult.loadedPath, join(root, ".gptwork", "runtime.env"));
});
