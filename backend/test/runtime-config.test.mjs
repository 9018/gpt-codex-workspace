import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRuntimeConfig, loadRuntimeEnv } from "../src/runtime-config.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import "./helpers/env-isolation.mjs";
import { clearGptWorkVars } from "./helpers/env-isolation.mjs";

// ================================================================
// Helper: create a temporary runtime.env file
// ================================================================
async function makeEnvFile(content) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rc-"));
  const envDir = join(root, ".gptwork");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "runtime.env");
  await writeFile(envFile, content, "utf8");
  return { root, envFile };
}

// ================================================================
// Tests: buildRuntimeConfig defaults
// ================================================================

test("buildRuntimeConfig defaults codexExecTimeout to 3600", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.codexExecTimeout, 3600);
  assert.equal(sources.codexExecTimeout, "default");
});

test("buildRuntimeConfig defaults shellTimeout to 60", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.shellTimeout, 60);
  assert.equal(sources.shellTimeout, "default");
});

test("buildRuntimeConfig defaults defaultBranch to main", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.defaultBranch, "main");
  assert.equal(sources.defaultBranch, "default");
});

test("buildRuntimeConfig defaults defaultRemote to origin", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.defaultRemote, "origin");
  assert.equal(sources.defaultRemote, "default");
});

test("buildRuntimeConfig defaults defaultRepo to empty string", () => {
  clearGptWorkVars();
  const { config } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.defaultRepo, "");
});

test("buildRuntimeConfig defaults defaultRepoPath to empty string", () => {
  clearGptWorkVars();
  const { config } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.defaultRepoPath, "");
});

test("buildRuntimeConfig defaults delivery result recovery commands to empty list", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.deepEqual(config.deliveryResultRecoveryCommands, []);
  assert.equal(sources.deliveryResultRecoveryCommands, "default");
});

test("buildRuntimeConfig defaults agent backend to codex_exec", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.agentBackend, "codex_exec");
  assert.deepEqual(config.agentRoleBackends, {});
  assert.deepEqual(config.agentRoleCommands, {});
  assert.equal(config.agentLocalCommand, "");
  assert.equal(sources.agentBackend, "default");
});

test("buildRuntimeConfig parses agent backend settings from runtime.env", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_AGENT_BACKEND=local_command\n" +
    "GPTWORK_AGENT_ROLE_BACKENDS=builder=codex_exec,reviewer=null,verifier=local_command\n" +
    "GPTWORK_AGENT_LOCAL_COMMAND=node scripts/agent.mjs\n" +
    "GPTWORK_AGENT_ROLE_COMMANDS=reviewer=node review.mjs||verifier=npm test\n" +
    "GPTWORK_AGENT_COMMAND_TIMEOUT=90\n"
  );
  const { config, sources } = buildRuntimeConfig(root);
  assert.equal(config.agentBackend, "local_command");
  assert.deepEqual(config.agentRoleBackends, {
    builder: "codex_exec",
    reviewer: "null",
    verifier: "local_command",
  });
  assert.equal(config.agentLocalCommand, "node scripts/agent.mjs");
  assert.deepEqual(config.agentRoleCommands, {
    reviewer: "node review.mjs",
    verifier: "npm test",
  });
  assert.equal(config.agentCommandTimeout, 90);
  assert.equal(sources.agentRoleBackends, "runtime.env");
  assert.equal(sources.agentRoleCommands, "runtime.env");
});

test("buildRuntimeConfig parses delivery result recovery commands from runtime.env", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS=npm --prefix backend run check:syntax||git diff --check\n" +
    "GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT=120\n"
  );
  const { config, sources } = buildRuntimeConfig(root);
  assert.deepEqual(config.deliveryResultRecoveryCommands, [
    "npm --prefix backend run check:syntax",
    "git diff --check",
  ]);
  assert.equal(config.resultRecoveryCommandTimeout, 120);
  assert.equal(sources.deliveryResultRecoveryCommands, "runtime.env");
});



test("buildRuntimeConfig exposes codex TUI productization settings", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_CODEX_TUI_ENABLED=true\n" +
    "GPTWORK_CODEX_TUI_COMMAND=codex-tui-custom\n" +
    "GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS=4321\n" +
    "GPTWORK_CODEX_TUI_SESSION_ROOT=/tmp/gptwork-tui-sessions\n" +
    "GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=false\n"
  );
  const { config, sources } = buildRuntimeConfig(root);
  assert.equal(config.codexTuiEnabled, true);
  assert.equal(config.codexTuiCommand, "codex-tui-custom");
  assert.equal(config.codexTuiEvidenceWaitMs, 4321);
  assert.equal(config.codexTuiSessionRoot, "/tmp/gptwork-tui-sessions");
  assert.equal(config.requireSuperpowersForTui, false);
  assert.equal(sources.codexTuiCommand, "runtime.env");
  assert.equal(sources.codexTuiEvidenceWaitMs, "runtime.env");
  assert.equal(sources.codexTuiSessionRoot, "runtime.env");
  assert.equal(sources.requireSuperpowersForTui, "runtime.env");
});

test("buildRuntimeConfig defaults bark config", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.barkGroup, "gptwork");
  assert.equal(config.barkKey, "");
  assert.equal(config.barkUrl, "");
  assert.equal(sources.barkKey, "default");
  assert.equal(sources.barkUrl, "default");
});

test("buildRuntimeConfig defaults github config", () => {
  clearGptWorkVars();
  const { config, sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.githubEnabled, false);
  assert.equal(config.githubRepo, "");
  assert.equal(config.githubToken, "");
  assert.equal(sources.githubRepo, "default");
});

test("buildRuntimeConfig defaults requireAuth to true", () => {
  clearGptWorkVars();
  const { config } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.requireAuth, true);
});

// ================================================================
// Tests: buildRuntimeConfig with runtime.env
// ================================================================

test("buildRuntimeConfig loads values from runtime.env", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_CODEX_EXEC_TIMEOUT=1800\n" +
    "GPTWORK_DEFAULT_BRANCH=develop\n"
  );
  const { config, sources, envLoadResult } = buildRuntimeConfig(root);
  assert.equal(config.codexExecTimeout, 1800);
  assert.equal(sources.codexExecTimeout, "runtime.env");
  assert.equal(config.defaultBranch, "develop");
  assert.equal(sources.defaultBranch, "runtime.env");
  assert.ok(envLoadResult.keys.includes("GPTWORK_CODEX_EXEC_TIMEOUT"));
  assert.ok(envLoadResult.keys.includes("GPTWORK_DEFAULT_BRANCH"));
});

test("buildRuntimeConfig runtime.env does not override process.env", async () => {
  clearGptWorkVars();
  process.env.GPTWORK_CODEX_EXEC_TIMEOUT = "9999";
  const { root } = await makeEnvFile("GPTWORK_CODEX_EXEC_TIMEOUT=1800\n");
  const { config, sources } = buildRuntimeConfig(root);
  assert.equal(config.codexExecTimeout, 9999);
  assert.equal(sources.codexExecTimeout, "process.env");
  delete process.env.GPTWORK_CODEX_EXEC_TIMEOUT;
});

test("buildRuntimeConfig process.env wins over runtime.env, runtime.env wins over default", async () => {
  clearGptWorkVars();
  // First test without process.env
  const { root } = await makeEnvFile("GPTWORK_CODEX_EXEC_TIMEOUT=1800\n");
  const r1 = buildRuntimeConfig(root);
  assert.equal(r1.config.codexExecTimeout, 1800);
  assert.equal(r1.sources.codexExecTimeout, "runtime.env");

  // Now with process.env
  process.env.GPTWORK_CODEX_EXEC_TIMEOUT = "5000";
  const r2 = buildRuntimeConfig(root);
  assert.equal(r2.config.codexExecTimeout, 5000);
  assert.equal(r2.sources.codexExecTimeout, "process.env");
  delete process.env.GPTWORK_CODEX_EXEC_TIMEOUT;

  // No runtime env file
  const r3 = buildRuntimeConfig("/tmp/nonexistent");
  assert.equal(r3.config.codexExecTimeout, 3600);
  assert.equal(r3.sources.codexExecTimeout, "default");
});

test("buildRuntimeConfig process.env wins over runtime.env for pre-existing env vars", async () => {
  clearGptWorkVars();
  process.env.GPTWORK_DEFAULT_BRANCH = "pre-existing";
  const { root } = await makeEnvFile("GPTWORK_DEFAULT_BRANCH=from-file\n");
  const { config, sources } = buildRuntimeConfig(root);
  // process.env was already set, so runtime.env should NOT override
  assert.equal(config.defaultBranch, "pre-existing");
  assert.equal(sources.defaultBranch, "process.env");
  delete process.env.GPTWORK_DEFAULT_BRANCH;
});

// ================================================================
// Tests: config source tracking
// ================================================================

test("buildRuntimeConfig sources show runtime.env for file-loaded values", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_DEFAULT_REPO=9018/gpt-codex-workspace\n" +
    "GPTWORK_DEFAULT_BRANCH=develop\n" +
    "GPTWORK_DEFAULT_REMOTE=upstream\n"
  );
  const { sources } = buildRuntimeConfig(root);
  assert.equal(sources.defaultRepo, "runtime.env");
  assert.equal(sources.defaultBranch, "runtime.env");
  assert.equal(sources.defaultRemote, "runtime.env");
});

test("buildRuntimeConfig sources show process.env for system-set values", () => {
  clearGptWorkVars();
  process.env.GPTWORK_SHELL_TIMEOUT = "120";
  process.env.GPTWORK_MAX_OUTPUT_BYTES = "500000";
  const { sources } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(sources.shellTimeout, "process.env");
  assert.equal(sources.maxOutputBytes, "process.env");
  delete process.env.GPTWORK_SHELL_TIMEOUT;
  delete process.env.GPTWORK_MAX_OUTPUT_BYTES;
});

// ================================================================
// Tests: parsing dotenv-style files
// ================================================================

test("loadRuntimeEnv parses comments and blank lines", async () => {
  clearGptWorkVars();
  const { root, envFile } = await makeEnvFile(
    "# This is a comment\n" +
    "   # Indented comment\n" +
    "\n" +
    "   \n" +
    "GPTWORK_CODEX_EXEC_TIMEOUT=3600\n" +
    "# Another comment\n" +
    "GPTWORK_DEFAULT_BRANCH=feature\n"
  );
  const result = loadRuntimeEnv(root, envFile);
  assert.ok(result.keys.includes("GPTWORK_CODEX_EXEC_TIMEOUT"));
  assert.ok(result.keys.includes("GPTWORK_DEFAULT_BRANCH"));
  assert.equal(result.keys.length, 2);
});

test("loadRuntimeEnv handles quoted values", async () => {
  clearGptWorkVars();
  const { root, envFile } = await makeEnvFile(
    'GPTWORK_BARK_GROUP="my group"\n' +
    "GPTWORK_CODEX_EXEC_ARGS='--yolo --verbose'\n"
  );
  const result = loadRuntimeEnv(root, envFile);
  assert.ok(result.keys.includes("GPTWORK_BARK_GROUP"));
  assert.ok(result.keys.includes("GPTWORK_CODEX_EXEC_ARGS"));
  // Quotes are preserved as-is by the simple parser
  assert.equal(process.env.GPTWORK_BARK_GROUP, '"my group"');
  assert.equal(process.env.GPTWORK_CODEX_EXEC_ARGS, "'--yolo --verbose'");
  delete process.env.GPTWORK_BARK_GROUP;
  delete process.env.GPTWORK_CODEX_EXEC_ARGS;
});

test("loadRuntimeEnv skips lines without =", async () => {
  clearGptWorkVars();
  const { root, envFile } = await makeEnvFile(
    "GPTWORK_BARK_GROUP=test-group\n" +
    "just a line without equals\n" +
    "=nokey\n"
  );
  const result = loadRuntimeEnv(root, envFile);
  assert.ok(result.keys.includes("GPTWORK_BARK_GROUP"));
  assert.equal(result.keys.length, 1);
  delete process.env.GPTWORK_BARK_GROUP;
});

// ================================================================
// Tests: runtime_status enhanced source reporting and secret masking
// ================================================================

async function makeServer(customConfig = {}) {
  clearGptWorkVars();
  const root = await mkdtemp(join(tmpdir(), "gptwork-rc-test-"));
  const workspaceRoot = root + "/workspace";
  // Write runtime.env to workspace root so loadRuntimeEnv finds it
  const envDir = join(workspaceRoot, ".gptwork");
  await mkdir(envDir, { recursive: true });
  // Default runtime.env - sets values for keys not already in process.env
  // After clearGptWorkVars, all GPTWORK_* vars are empty, so these load
  await writeFile(join(envDir, "runtime.env"),
    "GPTWORK_CODEX_EXEC_TIMEOUT=3000\n" +
    "GPTWORK_DEFAULT_REPO=test-owner/test-repo\n" +
    "GPTWORK_DEFAULT_BRANCH=develop\n",
    "utf8"
  );
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
    ...customConfig
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

test("runtime_status includes config_sources with per-key routing", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.ok(status.config_sources, "should have config_sources");
  // codexExecTimeout and defaults loaded from runtime.env created in makeServer
  assert.equal(status.config_sources.codex_exec_timeout, "runtime.env");
  // default_repo loads from runtime.env created in makeServer
  assert.equal(status.config_sources.default_repo, "runtime.env");
  assert.equal(status.config_sources.default_branch, "runtime.env");
  // state_path was set via options in makeServer, so source is "options"
  assert.equal(status.config_sources.state_path, "options");
  // max_read_bytes is never set in env, so should be default
  assert.equal(status.config_sources.max_read_bytes, "default");
});

test("runtime_status includes shell_timeout and max_read_bytes values", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(typeof status.shell_timeout, "number");
  assert.equal(typeof status.max_read_bytes, "number");
  assert.equal(typeof status.max_shell_output_bytes, "number");
});

test("runtime_status exposes agent backend routing without command text", async () => {
  clearGptWorkVars();
  process.env.GPTWORK_AGENT_BACKEND = "local_command";
  process.env.GPTWORK_AGENT_ROLE_BACKENDS = "builder=codex_exec,reviewer=null";
  process.env.GPTWORK_AGENT_LOCAL_COMMAND = "echo secret-command-text";
  process.env.GPTWORK_AGENT_ROLE_COMMANDS = "reviewer=node review.mjs";
  const root = await mkdtemp(join(tmpdir(), "gptwork-rc-agent-status-"));
  const workspaceRoot = root + "/workspace";
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
  });
  const status = await callTool(server, "runtime_status");
  assert.equal(status.agent_backend, "local_command");
  assert.deepEqual(status.agent_role_backends, { builder: "codex_exec", reviewer: "null" });
  assert.equal(status.agent_local_command_configured, true);
  assert.deepEqual(status.agent_role_commands, { reviewer: true });
  assert.equal(status.config_sources.agent_backend, "process.env");
  assert.ok(!JSON.stringify(status).includes("secret-command-text"));
  delete process.env.GPTWORK_AGENT_BACKEND;
  delete process.env.GPTWORK_AGENT_ROLE_BACKENDS;
  delete process.env.GPTWORK_AGENT_LOCAL_COMMAND;
  delete process.env.GPTWORK_AGENT_ROLE_COMMANDS;
});

test("runtime_status includes default_repo, default_branch, default_repo_path, default_remote", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(status.default_repo, "test-owner/test-repo");
  assert.equal(status.default_branch, "develop");
  assert.equal(typeof status.default_repo_path, "string");
  assert.equal(typeof status.default_remote, "string");
});

test("runtime_status does not expose secrets in bark/github fields", async () => {
  const server = await makeServer({ barkKey: "super-secret-key-12345" });
  const status = await callTool(server, "runtime_status");
  const str = JSON.stringify(status);
  assert.ok(!str.includes("super-secret-key-12345"), "should not leak bark key");
  assert.ok(!str.includes("barkUrl"), "should not contain barkUrl field");
  assert.ok(!str.includes("barkKey"), "should not contain barkKey field");
  assert.ok(status.bark !== undefined, "should have bark block");
  assert.equal(typeof status.bark.enabled, "boolean");
  assert.equal(typeof status.bark.configured, "boolean");
  assert.equal(typeof status.bark.source, "string");
});

test("runtime_status shows github sync status safely", async () => {
  clearGptWorkVars();
  // Set env vars BEFORE server creation so config captures them
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_ENABLED = "true";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret_12345";
  const root = await mkdtemp(join(tmpdir(), "gptwork-rc-test-"));
  const workspaceRoot = root + "/workspace";
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
  });
  const status = await callTool(server, "runtime_status");
  const str = JSON.stringify(status);
  assert.ok(!str.includes("ghp_secret_12345"), "should not leak github token");
  assert.equal(status.github.api_repo_set, true);
  assert.equal(status.github.api_token_set, true);
  assert.equal(status.github.api_sync_enabled, true);
  assert.equal(typeof status.github.source, "string");
  delete process.env.GPTWORK_GITHUB_ENABLED;
  delete process.env.GPTWORK_GITHUB_REPO;
  delete process.env.GPTWORK_GITHUB_TOKEN;
});

test("runtime_status bark block reflects config source", async () => {
  const server = await makeServer({ barkKey: "test-key", barkUrl: "https://push.example.com" });
  const status = await callTool(server, "runtime_status");
  assert.equal(status.bark.configured, true);
  assert.equal(status.bark.url_set, true);
  assert.equal(status.bark.key_set, true);
  assert.equal(status.bark.source, "options");
});

test("runtime_status bark block shows disabled when not configured", async () => {
  const server = await makeServer({});
  const status = await callTool(server, "runtime_status");
  assert.equal(status.bark.enabled, false);
  assert.equal(status.bark.configured, false);
});

// ================================================================
// Tests: runtime.env example file shape
// ================================================================

test("runtime.env.example exists and documents expected keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const examplePath = path.resolve(import.meta.dirname, "../../.gptwork/runtime.env.example");
  assert.ok(fs.existsSync(examplePath), "runtime.env.example should exist");
  const content = fs.readFileSync(examplePath, "utf8");
  assert.ok(content.includes("GPTWORK_CODEX_EXEC_TIMEOUT"));
  assert.ok(content.includes("GPTWORK_DEFAULT_REPO"));
  assert.ok(content.includes("GPTWORK_DEFAULT_BRANCH"));
  assert.ok(content.includes("GPTWORK_DEFAULT_REMOTE"));
  assert.ok(content.includes("GPTWORK_BARK_KEY"));
  assert.ok(content.includes("GPTWORK_BARK_URL"));
  assert.ok(content.includes("GPTWORK_GITHUB_REPO"));
  assert.ok(content.includes("GPTWORK_GITHUB_TOKEN"));
  assert.ok(content.includes("GPTWORK_SHELL_TIMEOUT"));
  assert.ok(content.includes("GPTWORK_RUNTIME_ENV_FILE"));
  // api.day.app is the public Bark server endpoint, not a secret value
  assert.ok(!content.includes("your_bark_key"), "should not contain real Bark key");
});

// ================================================================
// Tests: envLoadResult tracking
// ================================================================

test("buildRuntimeConfig returns envLoadResult with loadedPath and keys", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile(
    "GPTWORK_CODEX_EXEC_TIMEOUT=3600\n" +
    "GPTWORK_DEFAULT_BRANCH=staging\n"
  );
  const { envLoadResult } = buildRuntimeConfig(root);
  assert.ok(envLoadResult.loadedPath, "loadedPath should be set");
  assert.ok(envLoadResult.loadedPath.endsWith(".gptwork/runtime.env"));
  assert.ok(envLoadResult.keys.includes("GPTWORK_CODEX_EXEC_TIMEOUT"));
  assert.ok(envLoadResult.keys.includes("GPTWORK_DEFAULT_BRANCH"));
  assert.equal(envLoadResult.keys.length, 2);
});

test("buildRuntimeConfig envLoadResult shows empty when no file", () => {
  clearGptWorkVars();
  const { envLoadResult } = buildRuntimeConfig("/tmp/nonexistent-path-xyz");
  assert.equal(envLoadResult.loadedPath, null);
  assert.deepEqual(envLoadResult.keys, []);
});

// ================================================================
// Tests: runtime_status specific source fields
// ================================================================

test("runtime_status shows bark block with source field", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status");
  assert.equal(typeof status.bark.source, "string");
  assert.ok(["process.env", "runtime.env", "default", "disabled", "options", "none"].includes(status.bark.source) ||
    status.bark.source.startsWith("workspace-"), "valid source label");
});

// ================================================================
// Tests: runtime.env setting GPTWORK_WORKSPACE_ROOT / GPTWORK_STATE_PATH
// ================================================================

test("runtime.env GPTWORK_WORKSPACE_ROOT controls effective workspace root", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile("GPTWORK_WORKSPACE_ROOT=/custom/workspace/root\n");
  const rc = buildRuntimeConfig(root);
  assert.equal(rc.config.workspaceRoot, "/custom/workspace/root");
  assert.equal(rc.sources.workspaceRoot, "runtime.env");
});

test("runtime.env GPTWORK_STATE_PATH controls effective state path", async () => {
  clearGptWorkVars();
  const { root } = await makeEnvFile("GPTWORK_STATE_PATH=/custom/state/path.json\n");
  const rc = buildRuntimeConfig(root);
  assert.equal(rc.config.statePath, "/custom/state/path.json");
  assert.equal(rc.sources.statePath, "runtime.env");
});

test("options source tracking shows options for passed bark defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rc-opt-"));
  const workspaceRoot = root + "/workspace";
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
    barkKey: "opt-injected-key",
    barkUrl: "https://opt.example.com",
    defaultRepo: "opt-owner/opt-repo",
    defaultBranch: "develop",
  });
  const status = await callTool(server, "runtime_status");
  // bark keys passed via options
  assert.equal(status.config_sources.bark_key, "options");
  assert.equal(status.config_sources.bark_url, "options");
  // git defaults passed via options
  assert.equal(status.config_sources.default_repo, "options");
  assert.equal(status.config_sources.default_branch, "options");
  // state_path passed via options
  assert.equal(status.config_sources.state_path, "options");
});

// ================================================================
// Tests: Preloaded keys parameter for buildRuntimeConfig
// ================================================================

test("buildRuntimeConfig accepts preloadedKeys for correct source tracking", async () => {
  clearGptWorkVars();
  const { root, envFile } = await makeEnvFile("GPTWORK_CODEX_EXEC_TIMEOUT=1234\n");
  // Load env early (as gptwork-server now does)
  const earlyResult = loadRuntimeEnv(root, envFile);
  assert.ok(earlyResult.keys.includes("GPTWORK_CODEX_EXEC_TIMEOUT"));
  // Now call buildRuntimeConfig with preloaded keys - source should still be "runtime.env"
  const rc = buildRuntimeConfig(root, envFile, earlyResult.keys);
  assert.equal(rc.config.codexExecTimeout, 1234);
  assert.equal(rc.sources.codexExecTimeout, "runtime.env");
});

// ================================================================
// Tests: GPTWORK_GITHUB_ENABLED=false disables API sync even with repo/token
// ================================================================

test("buildRuntimeConfig GPTWORK_GITHUB_ENABLED=false disables even with repo/token", async () => {
  clearGptWorkVars();
  process.env.GPTWORK_GITHUB_ENABLED = "false";
  process.env.GPTWORK_GITHUB_REPO = "owner/repo";
  process.env.GPTWORK_GITHUB_TOKEN = "ghp_secret";
  const { config } = buildRuntimeConfig("/tmp/test-root");
  assert.equal(config.githubEnabled, false, "githubEnabled should be false when GPTWORK_GITHUB_ENABLED=false");
  assert.equal(config.githubRepo, "owner/repo");
  assert.equal(config.githubToken, "ghp_secret");
  // Also verify createGithubSync respects this
  const { createGithubSync } = await import("../src/github-adapter.mjs");
  const sync = createGithubSync(config);
  assert.equal(sync.enabled, false, "github sync should be disabled when GPTWORK_GITHUB_ENABLED=false");
  delete process.env.GPTWORK_GITHUB_ENABLED;
  delete process.env.GPTWORK_GITHUB_REPO;
  delete process.env.GPTWORK_GITHUB_TOKEN;
});

test("buildRuntimeConfig supports Codex contentful progress timeout env keys", async () => {
  clearGptWorkVars();
  const defaults = buildRuntimeConfig("/tmp/test-root");
  assert.equal(defaults.config.codexContentFirstOutputTimeout, 0);
  assert.equal(defaults.config.codexNoProgressTimeout, 0);
  assert.equal(defaults.sources.codexContentFirstOutputTimeout, "default");
  assert.equal(defaults.sources.codexNoProgressTimeout, "default");

  const { root } = await makeEnvFile(
    "GPTWORK_CODEX_CONTENT_FIRST_OUTPUT_TIMEOUT=300\n" +
    "GPTWORK_CODEX_NO_PROGRESS_TIMEOUT=900\n"
  );
  const loaded = buildRuntimeConfig(root);
  assert.equal(loaded.config.codexContentFirstOutputTimeout, 300);
  assert.equal(loaded.config.codexNoProgressTimeout, 900);
  assert.equal(loaded.sources.codexContentFirstOutputTimeout, "runtime.env");
  assert.equal(loaded.sources.codexNoProgressTimeout, "runtime.env");

  process.env.GPTWORK_CODEX_CONTENT_FIRST_OUTPUT_TIMEOUT = "111";
  process.env.GPTWORK_CODEX_NO_PROGRESS_TIMEOUT = "222";
  const overridden = buildRuntimeConfig(root);
  assert.equal(overridden.config.codexContentFirstOutputTimeout, 111);
  assert.equal(overridden.config.codexNoProgressTimeout, 222);
  assert.equal(overridden.sources.codexContentFirstOutputTimeout, "process.env");
  assert.equal(overridden.sources.codexNoProgressTimeout, "process.env");
  delete process.env.GPTWORK_CODEX_CONTENT_FIRST_OUTPUT_TIMEOUT;
  delete process.env.GPTWORK_CODEX_NO_PROGRESS_TIMEOUT;
});
