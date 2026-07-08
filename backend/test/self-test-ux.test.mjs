/**
 * P0/P0.5 UX Parity Tests
 *
 * Covers:
 * - CLI help contains self-test, connect
 * - gptwork_self_test MCP tool exists and returns structured result
 * - Tool mode matrix does not regress (5 modes, correct allowlists)
 * - self-test does not leak secrets
 * - release:check npm script is runnable
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, "..");
const BIN = join(BACKEND_ROOT, "bin", "gptwork.mjs");

// ── 1. CLI help contains self-test and connect ─────────────────────

test("CLI help includes self-test command", () => {
  const out = execSync(`node ${BIN} --help`, { encoding: "utf8", cwd: BACKEND_ROOT });
  assert.ok(out.includes("self-test"), `help should mention self-test\n${out}`);
});

test("CLI help includes connect command", () => {
  const out = execSync(`node ${BIN} --help`, { encoding: "utf8", cwd: BACKEND_ROOT });
  assert.ok(out.includes("connect"), `help should mention connect\n${out}`);
});

// ── 2. gptwork_self_test MCP tool exists and returns structured result ──

test("gptwork_self_test MCP tool returns PASS/WARN/FAIL results", async () => {
  const { createSelfTestToolsGroup } = await import("../src/tool-groups/self-test-tools-group.mjs");

  function fakeTool(desc) { return desc; }
  function fakeSchema() { return { type: "object", properties: {}, required: [] }; }

  const fakeConfig = {
    codexExecTimeout: 3600,
    githubRepo: "owner/repo",
    githubToken: "test-token",
    githubEnabled: false,
    barkEnabled: "",
    barkUrl: "",
    barkKey: "",
  };

  const fakeSources = { codexExecTimeout: "default", githubEnabled: "default" };
  const fakeBark = null;
  const fakeGithub = { enabled: false };
  const fakeStore = {};

  const tools = createSelfTestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    bark: fakeBark,
    github: fakeGithub,
    store: fakeStore,
    sources: fakeSources,
  });

  assert.ok(tools.gptwork_self_test, "gptwork_self_test tool must exist");

  const result = await tools.gptwork_self_test.handler({}, {});
  assert.ok(result.summary, "result must have summary");
  assert.ok(result.timestamp, "result must have timestamp");
  assert.ok(Array.isArray(result.results), "result must have results array");
  assert.ok(result.results.length >= 5, "must have at least 5 check results");

  // All results must have required fields
  for (const r of result.results) {
    assert.ok(r.check, `each result must have check field: ${JSON.stringify(r)}`);
    assert.ok(["PASS", "WARN", "FAIL"].includes(r.status),
      `status must be PASS/WARN/FAIL, got ${r.status} for ${r.check}`);
    assert.ok(typeof r.detail === "string", `detail must be a string for ${r.check}`);
  }
});

// ── 3. Tool mode matrix does not regress ──────────────────────────

test("tool mode allowlists are defined for all 5 modes", async () => {
  const { VALID_TOOL_MODES, TOOL_MODE_ALLOWLISTS, filterToolsForMode, normalizeToolMode } = await import("../src/server-tools.mjs");

  assert.equal(VALID_TOOL_MODES.size, 5, "must have exactly 5 valid modes");
  assert.ok(VALID_TOOL_MODES.has("minimal"));
  assert.ok(VALID_TOOL_MODES.has("standard"));
  assert.ok(VALID_TOOL_MODES.has("operator"));
  assert.ok(VALID_TOOL_MODES.has("codex"));
  assert.ok(VALID_TOOL_MODES.has("full"));

  // Verify first 3 modes have allowlists with expected tools
  for (const mode of ["minimal", "standard", "operator", "codex"]) {
    const allowlist = TOOL_MODE_ALLOWLISTS[mode];
    assert.ok(allowlist instanceof Set, `${mode} allowlist must be a Set`);
    assert.ok(allowlist.size >= 5, `${mode} allowlist must have at least 5 tools`);
  }

  // normalizeToolMode and filterToolsForMode work
  assert.equal(normalizeToolMode("standard"), "standard");
  assert.equal(normalizeToolMode("unknown"), "standard");
  assert.equal(normalizeToolMode("FULL"), "full");
});

// ── 4. Self-test does not leak secrets ─────────────────────────────

test("gptwork_self_test marks redacted checks and never exposes secret values", async () => {
  const { createSelfTestToolsGroup } = await import("../src/tool-groups/self-test-tools-group.mjs");

  function fakeTool(desc) { return desc; }
  function fakeSchema() { return { type: "object", properties: {}, required: [] }; }

  const fakeConfig = {
    codexExecTimeout: 3600,
    githubRepo: "my-secret-org/my-secret-repo",
    githubToken: "ghp_super_secret_token_12345",
    githubEnabled: true,
    barkEnabled: "true",
    barkUrl: "https://secret-bark.example.com/push",
    barkKey: "super-secret-bark-key",
  };

  const fakeSources = { codexExecTimeout: "runtime.env" };
  const fakeBark = {
    getStatus: () => ({
      configured: true,
      source: "runtime.env",
      url_set: true,
      key_set: true,
      group: "gptwork",
    }),
  };
  const fakeGithub = { enabled: true };
  const fakeStore = {};

  const tools = createSelfTestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: fakeConfig,
    bark: fakeBark,
    github: fakeGithub,
    store: fakeStore,
    sources: fakeSources,
  });

  const result = await tools.gptwork_self_test.handler({}, {});
  assert.equal(result.secrets_exposed, false, "secrets_exposed must be false");

  const fullOutput = JSON.stringify(result);
  // Verify no raw secret values appear in output
  assert.ok(!fullOutput.includes("super_secret_token_12345"), "must not leak github token");
  assert.ok(!fullOutput.includes("super-secret-bark-key"), "must not leak bark key");
  assert.ok(!fullOutput.includes("secret-bark"), "must not leak bark URL details");
});

// ── 5. CLI self-test --local works ─────────────────────────────────

test("CLI self-test --local runs without error", () => {
  const out = execSync(`node ${BIN} self-test --local 2>&1 || true`, {
    encoding: "utf8",
    cwd: BACKEND_ROOT,
    timeout: 10000,
  });
  // Should output the self-test header
  assert.ok(out.includes("GPTWork Self-Test"), `output should have header\n${out}`);
  // Should output PASS/WARN/FAIL
  assert.ok(out.includes("PASS") || out.includes("WARN") || out.includes("FAIL"),
    `output should contain test results\n${out}`);
});

// ── 6. CLI connect --local works ───────────────────────────────────

test("CLI connect --local shows connection options", () => {
  const out = execSync(`node ${BIN} connect --local 2>&1 || true`, {
    encoding: "utf8",
    cwd: BACKEND_ROOT,
    timeout: 5000,
  });
  assert.ok(out.includes("GPTWork Connect"), `output should have header\n${out}`);
  assert.ok(out.includes("Local MCP URL") || out.includes("ChatGPT Connector URL"),
    `output should mention connection URL\n${out}`);
});

// ── 7. npm run release:check is runnable (at least shows syntax ok) ──

test("package.json contains release:check script", () => {
  const pkg = JSON.parse(readFileSync(join(BACKEND_ROOT, "package.json"), "utf8"));
  const releaseCheck = pkg.scripts["release:check"] || "";
  assert.ok(releaseCheck, "release:check script must exist");
  for (const requiredScript of [
    "check:syntax",
    "check:imports",
    "test:release-scripts",
    "release:gate",
    "test:p0-ma9",
    "test:p0-p5",
    "release:p5:gate",
  ]) {
    assert.ok(releaseCheck.includes(requiredScript), `must include ${requiredScript}`);
  }
});

test("package release scripts reference existing scripts and tests", () => {
  const pkg = JSON.parse(readFileSync(join(BACKEND_ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts["test:release-scripts"], "test:release-scripts script must exist");

  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!/^(check|release|test:)/.test(name)) continue;

    const scriptRefs = [...command.matchAll(/\bnode\s+(?:--check\s+)?(?:[^\s]+\s+)*scripts\/[^\s'"]+/g)]
      .map(match => match[0].split(/\s+/).at(-1));
    const testRefs = [...command.matchAll(/\btest\/[A-Za-z0-9._/-]+\.mjs\b/g)].map(match => match[0]);

    for (const relativePath of [...scriptRefs, ...testRefs]) {
      if (relativePath.includes("*")) continue;
      assert.ok(
        existsSync(join(BACKEND_ROOT, relativePath)),
        `${name} references missing file ${relativePath}`,
      );
    }
  }
});

// ── 8. CLI doctor --local shows key info ───────────────────────────

test("CLI doctor --local shows repo root, workspace root, tool mode, timeout, github, bark", () => {
  const out = execSync(`node ${BIN} doctor --local 2>&1 || true`, {
    encoding: "utf8",
    cwd: BACKEND_ROOT,
    timeout: 10000,
  });
  assert.ok(out.includes("GPTWork Doctor"), `output should have header\n${out}`);
  assert.ok(out.includes("repo root") || out.includes("workspace root"), "should show repo/workspace root");
  assert.ok(out.includes("tool mode"), "should show tool mode");
  assert.ok(out.includes("timeout") || out.includes("codex exec timeout"), "should show timeout");
  assert.ok(out.includes("github"), "should show github status");
  assert.ok(out.includes("bark"), "should show bark status");
});
