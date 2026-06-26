import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
afterEachHook(test);

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(TEST_DIR, "../bin/gptwork.mjs");


async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p0-"));
  track(root);
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
  });
}

test("open_project_context returns bounded first-step project context", async () => {
  const server = await makeServer();
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "open_project_context", arguments: {} },
  }, { authorization: "Bearer test-token" });

  const context = response.result.structuredContent;
  assert.equal(context.ok, true);
  // Use includes (not endsWith) to support git worktree environments
  // where the repo root is a worktree path containing the canonical repo name
  assert.ok(context.repo.root.includes("gpt-codex-workspace"));
  assert.equal(typeof context.repo.dirty, "boolean");
  assert.ok(context.config.tool_mode);
  assert.ok(context.project_files.some((file) => file.name === "README.md"));
  assert.ok(Array.isArray(context.file_tree));
  assert.ok(context.file_tree.length <= 80);
  assert.ok(context.recommended_next_tools.includes("create_encoded_goal"));
  assert.match(response.result.content[0].text, /Project Context/);
});

test("gptwork CLI settings show/set edits runtime env file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-cli-settings-"));
  track(root);
  const envFile = join(root, "runtime.env");
  await writeFile(envFile, "GPTWORK_PORT=8787\n", "utf8");

  execFileSync("node", [CLI_BIN, "settings", "set", "GPTWORK_TOOL_MODE", "minimal"], {
    env: { ...process.env, GPTWORK_RUNTIME_ENV_FILE: envFile },
    encoding: "utf8",
  });
  const show = execFileSync("node", [CLI_BIN, "settings", "show"], {
    env: { ...process.env, GPTWORK_RUNTIME_ENV_FILE: envFile },
    encoding: "utf8",
  });
  const file = await readFile(envFile, "utf8");

  assert.match(show, /GPTWORK_TOOL_MODE=minimal/);
  assert.match(file, /GPTWORK_TOOL_MODE=minimal/);
});

test("gptwork CLI doctor and status print compact local summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-cli-status-"));
  track(root);
  const statePath = join(root, "state.json");
  const env = {
    ...process.env,
    GPTWORK_STATE_PATH: statePath,
    GPTWORK_WORKSPACE_ROOT: join(root, "workspace"),
    GPTWORK_REQUIRE_AUTH: "false",
  };
  await chmod(CLI_BIN, 0o755).catch(() => {});

  const doctor = execFileSync("node", [CLI_BIN, "doctor", "--local"], { env, encoding: "utf8" });
  const status = execFileSync("node", [CLI_BIN, "status", "--local"], { env, encoding: "utf8" });

  assert.match(doctor, /GPTWork Doctor/);
  assert.match(doctor, /runtime env:/);
  assert.doesNotMatch(doctor, /payload_base64/);
  assert.match(status, /GPTWork Status/);
  assert.match(status, /queue:/);
  assert.ok(status.split("\n").length < 30);
});

test("gptwork CLI help only advertises implemented commands", () => {
  const help = execFileSync("node", [CLI_BIN, "--help"], { encoding: "utf8" });

  assert.match(help, /setup/);
  assert.match(help, /start/);
  assert.match(help, /status \[--local\]/);
  assert.match(help, /doctor \[--local\]/);
  assert.match(help, /settings show/);
  assert.match(help, /settings set KEY VALUE/);
  assert.match(help, /logs/);
  assert.match(help, /watch-handoff --dry-run/);
  assert.doesNotMatch(help, /goal create/);
  assert.doesNotMatch(help, /codex run/);
  assert.doesNotMatch(help, /github sync/);
});

test("repository root does not include extracted productization goal bundle", () => {
  const repoRoot = resolve(TEST_DIR, "../..");
  const files = execFileSync("git", ["ls-files", "gptwork_p0_p1_p2_goal"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  assert.equal(files, "");
});
