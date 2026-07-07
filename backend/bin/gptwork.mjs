#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildRuntimeConfig } from "../src/runtime-config.mjs";
import { StateStore } from "../src/state-store.mjs";
let _savedOnboardingInit = null;
import { collectWorkerQueueCounts } from "../src/worker-queue-counts.mjs";
import { handoffToAgent, readHandoff, handoffPaths } from "../src/handoff-service.mjs";
import { enqueueGoal, listGoalQueue, startNextQueuedGoal, cancelGoalQueueItem } from "../src/goal-queue.mjs";

const args = process.argv.slice(2);

function usage() {
  return `gptwork commands:
  setup
  init
  fix
  start
  connect [--local]
  status [--local]
  doctor [--local]
  self-test [--local]
  verify-delivery [--help]
  demo-multi-task [--help|--dry-run]
  settings show
  settings set KEY VALUE
  logs
  watch-handoff --dry-run [--agent <name>] [--command <cmd>]
  watch-handoff --once [--agent <name>] [--command <cmd>]

Tmp commands:
  tmp status
  tmp cleanup [--dry-run|--apply]

 Goals commands:
   goals storage-status
   goals cleanup [--dry-run|--apply]
   goals rotate-events [--keep-days <n>] [--dry-run|--apply]
 
 Retention commands:
   retention status
   retention cleanup [--dry-run|--apply] [--limit <n>] [--archive|--no-archive]
 
 Queue commands:
  queue list [--status <s>]
  queue start-next [--dry-run]
  queue enqueue <goal_id> [--depends-on-goal <gid>] [--depends-on-task <tid>]
  queue cancel <queue_id>`;

}

function printVerifyDeliveryHelp() {
  console.log("GPTWork verify-delivery");
  console.log("=".repeat(60));
  console.log("Checks: worktree-service, task acceptance verifier, failure retry, queue sync, worker cwd, verification.json, git diff --check, and multi-task demo coverage.");
  console.log("Runs: npm run check:syntax && npm run check:imports && npm test && npm run release:delivery-check");
}

function printDemoMultiTaskHelp() {
  console.log("GPTWork demo-multi-task");
  console.log("=".repeat(60));
  console.log("Demonstrates three ordinary builder tasks using isolated worktree + branch execution.");
  console.log("Output fields: worktree path, branch, task id, goal id, result path, verification path, review status.");
  console.log("Use --dry-run to print the scenario without mutating repositories.");
}

async function runVerifyDelivery(rest = []) {
  if (rest.includes("--help")) return printVerifyDeliveryHelp();
  const { spawnSync } = await import("node:child_process");
  const commands = [
    ["npm", ["run", "check:syntax"]],
    ["npm", ["run", "check:imports"]],
    ["npm", ["test"]],
    ["npm", ["run", "release:delivery-check"]],
  ];
  for (const [cmd, args] of commands) {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    const result = spawnSync(cmd, args, { cwd: resolve(dirname(new URL(import.meta.url).pathname), ".."), stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

async function runDemoMultiTask(rest = []) {
  if (rest.includes("--help")) return printDemoMultiTaskHelp();
  const dryRun = rest.includes("--dry-run");
  console.log("GPTWork demo-multi-task");
  console.log("=".repeat(60));
  console.log(dryRun ? "mode: dry-run" : "mode: inspect current workspace");
  console.log("task_1 -> branch=gptwork/task/task_1 worktree=worktrees/default/task_1 goal=goal_1 result=.gptwork/goals/goal_1/result.json verification=.gptwork/goals/goal_1/verification.json");
  console.log("task_2 -> branch=gptwork/task/task_2 worktree=worktrees/default/task_2 goal=goal_2 result=.gptwork/goals/goal_2/result.json verification=.gptwork/goals/goal_2/verification.json");
  console.log("task_3 -> branch=gptwork/task/task_3 worktree=worktrees/default/task_3 goal=goal_3 result=.gptwork/goals/goal_3/result.json verification=.gptwork/goals/goal_3/verification.json");
  console.log("review: verification.passed=false enters waiting_for_review or waiting_for_repair; completed requires verification.passed=true.");
}

async function getOnboardingInit() {
  if (!_savedOnboardingInit) {
    _savedOnboardingInit = await import("../src/onboarding-init.mjs");
  }
  return _savedOnboardingInit;
}

async function printInit(opts = {}) {
  const oi = await getOnboardingInit();
  const checks = await oi.runInit(opts.production ? { production: true } : {});
  console.log("");
  oi.printInitReport(checks, { showNextSteps: true, productionMode: !!opts.production });
}

async function printFix(opts = {}) {
  const oi = await getOnboardingInit();
  const result = await oi.runFix();
  console.log("");
  oi.printFixReport(result);
}

function workspaceRoot() {
  return process.env.GPTWORK_WORKSPACE_ROOT || resolve(process.cwd(), "data/workspaces/default");
}

function runtimeEnvPath() {
  const explicit = process.env.GPTWORK_RUNTIME_ENV_FILE;
  if (explicit) return resolve(explicit);
  return join(workspaceRoot(), ".gptwork/runtime.env");
}

function loadEnvLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n");
}

function envMapFromLines(lines) {
  const values = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    values.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return values;
}

function setRuntimeEnv(key, value) {
  const path = runtimeEnvPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = loadEnvLines(path);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(path, next.filter((line, idx, arr) => line !== "" || idx < arr.length - 1).join("\n") + "\n", "utf8");
  console.log(`Set ${key}=${value}`);
  console.log(`runtime env: ${path}`);
}

function showSettings() {
  const path = runtimeEnvPath();
  const values = envMapFromLines(loadEnvLines(path));
  const rc = buildRuntimeConfig(workspaceRoot(), path);
  const keys = [
    "GPTWORK_HOST",
    "GPTWORK_PORT",
    "GPTWORK_TOOL_MODE",
    "GPTWORK_WORKSPACE_ROOT",
    "GPTWORK_STATE_PATH",
    "GPTWORK_DEFAULT_REPO",
    "GPTWORK_GITHUB_ENABLED",
  ];
  const keyToConfig = {
    GPTWORK_HOST: "host",
    GPTWORK_PORT: "port",
    GPTWORK_TOOL_MODE: "toolMode",
    GPTWORK_WORKSPACE_ROOT: "workspaceRoot",
    GPTWORK_STATE_PATH: "statePath",
    GPTWORK_DEFAULT_REPO: "defaultRepo",
    GPTWORK_GITHUB_ENABLED: "githubEnabled",
  };
  console.log("GPTWork Settings");
  console.log(`runtime env: ${path}`);
  for (const key of keys) {
    const camel = keyToConfig[key];
    const value = values.get(key) ?? process.env[key] ?? rc.config[camel] ?? "";
    console.log(`${key}=${value}`);
  }
}

async function localStore() {
  const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
  const config = rc.config;
  const store = new StateStore({
    statePath: config.statePath,
    defaultWorkspaceRoot: config.workspaceRoot,
  });
  await store.load();
  return { store, config, envLoadResult: rc.envLoadResult, sources: rc.sources };
}

async function printStatus() {
  const { store, config } = await localStore();
  const state = await store.load();
  const queue = await collectWorkerQueueCounts(store);
  console.log("GPTWork Status");
  console.log(`server: http://${config.host}:${config.port}/mcp`);
  console.log(`state: ${config.statePath}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`repo: ${config.defaultRepo || "(not configured)"}`);
  console.log(`tool mode: ${config.toolMode}`);
  console.log(`codex exec timeout: ${config.codexExecTimeout}s`);
  console.log(`tasks: ${state.tasks.length}`);
  console.log(`goals: ${state.goals.length}`);
  console.log(`queue: assigned=${queue.assigned || 0} queued=${queue.queued || 0} running=${queue.running || 0} waiting=${queue.waiting_for_lock || 0}`);
  const githubStatus = config.githubEnabled ? "enabled" : "disabled";
  console.log(`github: ${githubStatus}${config.githubRepo ? " (" + config.githubRepo + ")" : ""}`);
  const barkVars = ["GPTWORK_BARK_ENABLED", "GPTWORK_BARK_URL", "GPTWORK_BARK_KEY"];
  const barkConfigured = barkVars.some(v => process.env[v] || (config.barkEnabled));
  console.log(`bark: ${barkConfigured ? "configured" : "not configured"}`);
}

async function printDoctor(opts = {}) {
  const { store, config, envLoadResult } = await localStore();
  const state = await store.load();
  // Resolve repo root directory
  let repoRoot = "(unknown)";
  try {
    const { resolveRepoDir } = await import("../src/diagnostics-service.mjs");
    const found = resolveRepoDir();
    if (found) repoRoot = found;
  } catch (e) {
    // fallback
  }

  console.log("GPTWork Doctor");
  console.log(`repo root: ${repoRoot}`);
  console.log(`workspace root: ${config.defaultWorkspaceRoot || config.workspaceRoot}`);
  console.log(`runtime env: ${envLoadResult.loadedPath || "missing"}`);
  console.log(`state: ${config.statePath}`);
  console.log(`tool mode: ${config.toolMode}`);
  console.log(`codex exec timeout: ${config.codexExecTimeout}s`);
  console.log(`codex concurrency: ${config.codexConcurrency}`);
  console.log(`tasks: ${state.tasks.length}`);
  console.log(`goals: ${state.goals.length}`);

  // GitHub status (redacted)
  const githubEnabled = config.githubEnabled;
  const githubRepo = config.githubRepo || "(not configured)";
  const githubTokenSet = !!config.githubToken;
  console.log(`github: ${githubEnabled ? "enabled" : "disabled"} repo=${githubRepo} token=${githubTokenSet ? "configured" : "not set"}`);

  // Bark status (redacted)
  const barkEnabled = !!config.barkEnabled;
  const barkUrlSet = !!config.barkUrl;
  const barkKeySet = !!config.barkKey;
  console.log(`bark: ${barkEnabled ? "enabled" : "disabled"} url=${barkUrlSet ? "set" : "not set"} key=${barkKeySet ? "set" : "not set"}`);

  // E2E script
  const e2ePath = join(resolve(dirname(new URL(import.meta.url).pathname), ".."), "test", "e2e-product-acceptance.test.mjs");
  console.log(`e2e acceptance script: ${existsSync(e2ePath) ? e2ePath : "missing"}`);

  // Config sources
  const envKeys = envLoadResult.keys.length > 0 ? envLoadResult.keys.join(", ") : "none";
  console.log(`runtime env keys loaded: ${envKeys}`);
  console.log(`tokens: ${config.tokens ? "configured" : "default"}`);

  // Next steps
  console.log("");
  console.log("-- Suggested Next Steps --");
  if (!githubEnabled) console.log("  * Configure GitHub: set GPTWORK_GITHUB_ENABLED=true in runtime.env");
  if (!barkEnabled) console.log("  * Configure Bark: set GPTWORK_BARK_ENABLED=true in runtime.env");
  console.log("  * Run `npm run test:e2e-acceptance` for full acceptance verification");
  // Add onboarding diagnostics
  try {
    const oi = await getOnboardingInit();
    const envCheck = oi.validateRuntimeEnvAgainstExample();
    const registryCheck = oi.checkRepoRegistry();
    const contextCheck = oi.checkProjectContext();
    const codexCheck = oi.checkCodexAvailability();
    const workerCheck = oi.checkWorkerStatus(config);
    const githubCheck = oi.checkGitHubConnectivity(config);

    console.log("");
    console.log("-- Enhanced Diagnostics --");
    console.log(`  ${envCheck.status === "pass" ? "OK" : envCheck.status === "warn" ? "WARN" : "FAIL"} env_vs_example: ${envCheck.detail.slice(0, 80)}`);
    console.log(`  ${registryCheck.status === "pass" ? "OK" : registryCheck.status === "warn" ? "WARN" : "FAIL"} repo_registry: ${registryCheck.detail.slice(0, 80)}`);
    console.log(`  ${contextCheck.status === "pass" ? "OK" : "FAIL"} project_context: ${contextCheck.detail.slice(0, 80)}`);
    console.log(`  ${codexCheck.status === "pass" ? "OK" : "WARN"} codex: ${codexCheck.detail.slice(0, 80)}`);
    console.log(`  ${workerCheck.status === "pass" ? "OK" : "WARN"} worker: ${workerCheck.detail.slice(0, 80)}`);
    console.log(`  ${githubCheck.status === "pass" ? "OK" : githubCheck.status === "skip" ? "--" : "WARN"} github: ${githubCheck.detail.slice(0, 80)}`);
    console.log("");
    console.log("  Run `gptwork init` for a full productized initialization report");
  } catch (e) {
    // Enhanced diagnostics are optional
  }

}

async function printSelfTest() {
  const { store, config, sources } = await localStore();

  // Reuse the same logic as the MCP tool
  const { createSelfTestToolsGroup } = await import("../src/tool-groups/self-test-tools-group.mjs");

  function fakeTool(desc) { return desc; }
  function fakeSchema() { return { type: "object", properties: {}, required: [] }; }

  const tools = createSelfTestToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config,
    bark: null,
    github: { enabled: config.githubEnabled },
    store,
    sources,
  });

  const result = await tools.gptwork_self_test.handler({}, {});

  console.log("GPTWork Self-Test");
  console.log("=".repeat(60));
  for (const r of result.results) {
    const icon = r.status === "PASS" ? "\u2714" : r.status === "WARN" ? "\u26A0" : "\u2718";
    console.log(`  ${icon} ${r.check}: ${r.detail}`);
  }
  console.log("=".repeat(60));
  console.log(`  Summary: ${result.summary}`);
  console.log(`  timestamp: ${result.timestamp}`);
  console.log(`  secrets_exposed: ${result.secrets_exposed}`);
}

async function printConnect() {
  const host = process.env.GPTWORK_HOST || "127.0.0.1";
  const port = process.env.GPTWORK_PORT || "8787";
  const defaultToken = "dev-token"; // placeholder only, not a real secret

  console.log("GPTWork Connect");
  console.log("=".repeat(60));
  console.log("");
  console.log("Local MCP URL:");
  console.log(`  http://${host}:${port}/mcp`);
  console.log(`  http://${host}:${port}/mcp/${defaultToken}`);
  console.log("");
  console.log("ChatGPT Connector URL (example — replace with your actual token):");
  console.log(`  https://your-domain.example.com/mcp/${defaultToken}`);
  console.log("");
  console.log("-- Connectivity Options --");
  console.log("");
  console.log("1. Local-only (LAN):");
  console.log("   The MCP server listens on localhost by default.");
  console.log("   ChatGPT cannot reach it directly without a public endpoint.");
  console.log("   Use this for Codex plugin only (codex on same LAN).");
  console.log("");
  console.log("2. Reverse proxy (recommended for ChatGPT):");
  console.log("   Set up a reverse proxy (nginx, Caddy, Cloudflare Tunnel)");
  console.log("   pointing to http://127.0.0.1:8787");
  console.log("   Update GPTWORK_HOST=0.0.0.0 in runtime.env");
  console.log("   Example ChatGPT Connector URL:");
  console.log("     https://mcp.your-domain.com/mcp/dev-token");
  console.log("");
  console.log("3. GitHub Issues fallback (no reverse proxy):");
  console.log("   Set GPTWORK_GITHUB_ENABLED=true and GPTWORK_GITHUB_REPO");
  console.log("   ChatGPT interacts via GitHub Issues instead of MCP.");
  console.log("   See README.md for details.");
  console.log("");
  console.log("-- Next Steps --");
  console.log("   gptwork doctor --local    # verify setup");
  console.log("   gptwork self-test --local  # run self checks");
  console.log("   npm run release:check      # full pre-release check");
}

function startServer() {
  const serverPath = resolve(dirname(new URL(import.meta.url).pathname), "../src/cli.mjs");
  const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function printSetup() {
  const path = runtimeEnvPath();
  const wsRoot = workspaceRoot();
  mkdirSync(dirname(path), { recursive: true });

  // Check if runtime.env already exists
  if (existsSync(path)) {
    const lines = loadEnvLines(path);
    const env = envMapFromLines(lines);
    console.log("GPTWork setup: runtime.env already exists");
    console.log(`  path: ${path}`);

    // Report existing values (redacted secrets)
    const hasToken = env.has("GPTWORK_TOKENS");
    const hasBarkKey = env.has("GPTWORK_BARK_KEY");
    const hasGithubToken = env.has("GPTWORK_GITHUB_TOKEN");
    console.log(`  tokens: ${hasToken ? "configured (not overwritten)" : "not set"}`);
    console.log(`  bark key: ${hasBarkKey ? "configured (not overwritten)" : "not set"}`);
    console.log(`  github token: ${hasGithubToken ? "configured (not overwritten)" : "not set"}`);

    // Output next command
    console.log("");
    console.log("-- Next Steps --");
    if (!hasToken) {
      console.log("  * Set GPTWORK_TOKENS=<comma-separated-tokens> in runtime.env");
    }
    if (!env.has("GPTWORK_TOOL_MODE")) {
      console.log("  * Set GPTWORK_TOOL_MODE=standard (or minimal, operator, codex, full)");
    }
    console.log("  * gptwork connect --local    # see connection options");
    console.log("  * gptwork start              # start the MCP server");
    return;
  }

  // Generate default runtime.env
  const defaultEnv = [
    "# GPTWork runtime configuration",
    "# Generated by gptwork setup",
    "# Replace values below (secrets are not committed to git)",
    "",
    "GPTWORK_HOST=127.0.0.1",
    "GPTWORK_PORT=8787",
    "GPTWORK_TOOL_MODE=standard",
    "GPTWORK_REQUIRE_AUTH=true",
    `GPTWORK_WORKSPACE_ROOT=${wsRoot}`,
    `GPTWORK_STATE_PATH=${wsRoot}/.gptwork/state.json`,
    `GPTWORK_RUNTIME_ENV_FILE=${path}`,
    "GPTWORK_CODEX_EXEC_TIMEOUT=3600",
    "",
    "# GitHub Issues sync (optional)",
    "# GPTWORK_GITHUB_ENABLED=true",
    "# GPTWORK_GITHUB_REPO=your-org/your-repo",
    "# GPTWORK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx",
    "",
    "# Bark notifications (optional)",
    "# GPTWORK_BARK_ENABLED=true",
    "# GPTWORK_BARK_URL=https://api.example.com/push",
    "# GPTWORK_BARK_KEY=your-bark-key",
  ];

  writeFileSync(path, defaultEnv.join("\n") + "\n", "utf8");
  console.log("GPTWork setup: runtime.env created");
  console.log(`  path: ${path}`);
  console.log("");
  console.log("-- Next Steps --");
  console.log("  1. Edit runtime.env with your configuration");
  console.log("  2. gptwork connect --local    # see connection options");
  console.log("  3. gptwork start              # start the MCP server");
  console.log("  4. gptwork doctor --local     # verify setup");
  console.log("  5. gptwork self-test --local  # run self checks");
  console.log("  6. npm run release:check      # full pre-release check");
}

async function handleWatchHandoff() {
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  const agentIdx = args.indexOf("--agent");
  const agent = agentIdx >= 0 ? args[agentIdx + 1] : "codex";
  const cmdIdx = args.indexOf("--command");
  const command = cmdIdx >= 0 ? args[cmdIdx + 1] : "";
  const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
  const config = rc.config;
  const paths = handoffPaths(config);
  const planFile = paths.plan_file;

  console.log("GPTWork Handoff Watcher");
  console.log(`agent: ${agent}`);
  console.log(`plan: ${planFile}`);
  console.log(`dry_run: ${dryRun ? "true" : "false"}`);
  console.log(`once: ${once ? "true" : "false"}`);
  console.log(`plan_exists: ${existsSync(planFile) ? "true" : "false"}`);

  if (command) {
    console.log(`command: ${command}`);
  }

  if (dryRun) {
    const handoff = await readHandoff(config);
    console.log(`status: ${handoff.status.status}`);
    if (handoff.plan) {
      console.log(`plan_preview: ${handoff.plan.slice(0, 300)}...`);
    }
    return;
  }

  if (once) {
    mkdirSync(dirname(paths.status_file), { recursive: true });
    console.log("Mode: once");
    const handoff = await readHandoff(config);
    console.log(`status: ${handoff.status.status}`);
    if (handoff.plan) {
      console.log(`plan_preview: ${handoff.plan.slice(0, 300)}...`);
    }

    // Write status update
    const statusUpdate = {
      agent,
      command: command || "",
      status: "processing",
      read_at: new Date().toISOString(),
    };
    const statusPath = paths.status_file;
    await writeFileSync(statusPath, JSON.stringify(statusUpdate, null, 2), "utf8");
    console.log(`status written: ${statusPath}`);

    // Append to execution log
    const logLine = JSON.stringify({ event: "handoff_processed", ...statusUpdate }) + "\n";
    await writeFileSync(paths.log_file, logLine, { flag: "a" });
    console.log(`log entry written: ${paths.log_file}`);

    console.log("Handoff processed (once mode). No external commands executed.");
  }
}
async function handleTmp() {
  const { store, config } = await localStore();
  const [ subcommand, ...rest ] = args.slice(1);
  if (subcommand === "status") {
    const { scanManagedTmp, scanSystemTmp, getInodePressure } = await import("../src/gptwork-tmp.mjs");
    const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
  const managed = await scanManagedTmp({ workspaceRoot });
  const systemTmp = await scanSystemTmp();
  const inodePressure = await getInodePressure();
  const gptworkFiles = managed.files.filter(f => f.gptwork_owned).length;
  const nonGptworkFiles = managed.fileCount - gptworkFiles;
  const filesOlder24h = managed.files.filter(f => f.ageMs >= 86400000).length;
  const topLargest = [...managed.files].sort((a, b) => b.size - a.size).slice(0, 5);
  
  console.log("GPTWork /tmp Status");
  console.log("=".repeat(60));
  console.log("Managed tmp (.gptwork/tmp/):");
  console.log("  files:", managed.fileCount, `(gptwork-owned: ${gptworkFiles}, other: ${nonGptworkFiles})`);
  console.log("  bytes:", managed.totalBytesH);
  if (managed.files.length > 0) {
    console.log("  oldest:", managed.files[managed.files.length - 1].name, `(${managed.files[managed.files.length - 1].ageH}h)`, managed.files[managed.files.length - 1].size_h);
    console.log("  newest:", managed.files[0].name, `(${managed.files[0].ageH}h)`, managed.files[0].size_h);
    if (filesOlder24h > 0) console.log("  older than 24h:", filesOlder24h);
    if (topLargest.length > 0) {
      console.log("  top 5 largest:");
      for (const f of topLargest) {
        console.log(`    ${f.name.padEnd(40)} ${f.size_h.padEnd(10)} ${f.ageH}h old`);
      }
    }
  }
  console.log("");
  console.log("System /tmp:");
  console.log("  files:", systemTmp.file_count);
  console.log("  bytes:", systemTmp.total_bytes_h);
  if (systemTmp.oldest) console.log("  oldest:", systemTmp.oldest.name, systemTmp.oldest.mtime);
  if (systemTmp.newest) console.log("  newest:", systemTmp.newest.name, systemTmp.newest.mtime);
  console.log("");
  if (inodePressure) {
    console.log("Inode pressure (tmpfs):");
    console.log("  used:", inodePressure.used_pct, `(${inodePressure.used_inodes}/${inodePressure.total_inodes})`);
    console.log("  free:", inodePressure.free_inodes);
    if (inodePressure.used_pct && parseInt(inodePressure.used_pct) > 80) {
      console.log("  WARNING: inode usage above 80%, consider cleanup");
    }
  }
  } else if (subcommand === "cleanup") {
    const dryRun = rest.includes("--dry-run") || !rest.includes("--apply");
    const { cleanupManagedTmp, cleanupSystemTmp } = await import("../src/gptwork-tmp.mjs");
    const maxAgeMs = (function(){ const i = rest.indexOf("--max-age-ms"); return i >= 0 ? Number(rest[i+1]) : undefined; })();
    const maxBytes = (function(){ const i = rest.indexOf("--max-bytes"); return i >= 0 ? Number(rest[i+1]) : undefined; })();
    const maxCount = (function(){ const i = rest.indexOf("--max-count"); return i >= 0 ? Number(rest[i+1]) : undefined; })();
    const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
    const managedResult = await cleanupManagedTmp({ workspaceRoot, dryRun, maxAgeMs, maxBytes, maxCount });
    const systemResult = await cleanupSystemTmp({ dryRun, maxAgeMs, maxBytes, maxCount });
    console.log("GPTWork /tmp Cleanup");
    console.log("=".repeat(60));
    console.log("  Mode:           " + (dryRun ? "dry-run (no changes)" : "applied"));
    console.log("  Managed tmp:    " + managedResult.deleted + " deleted, " + managedResult.skipped + " kept" + (managedResult.deletedBytes ? " (" + managedResult.deletedBytesH + " freed)" : ""));
    console.log("  System /tmp:    " + systemResult.deleted + " deleted, " + systemResult.skipped + " kept" + (systemResult.deleted_bytes ? " (" + systemResult.deleted_bytes_h + " freed)" : ""));
  } else {
    console.log("Usage: gptwork tmp status|cleanup [--dry-run|--apply]");
  }
}

async function handleGoals() {
  const { store, config } = await localStore();
  const [ subcommand, ...rest ] = args.slice(1);
  const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;

  if (subcommand === "storage-status") {
    const { scanGoals, scanEvents } = await import("../src/goal-storage-service.mjs");
    const gs = await scanGoals(workspaceRoot);
    const es = await scanEvents(workspaceRoot);
    const retCfg = { enabled: true, limit: Number(process.env.GPTWORK_RETENTION_LIMIT) || 50 };
    console.log("GPTWork Goal Storage");
    console.log("=".repeat(60));
    console.log("  Goal dirs:        " + gs.goal_dir_count);
    console.log("  Total files:      " + gs.total_files);
    console.log("  Total bytes:      " + gs.total_bytes_h);
    console.log("  Retention limit:  " + retCfg.limit + " terminal dirs");
    if (gs.oldest_goal) console.log("  Oldest:           " + gs.oldest_goal.name + " (" + gs.oldest_goal.age_days + " days)");
    if (gs.newest_goal) console.log("  Newest:           " + gs.newest_goal.name + " (" + gs.newest_goal.age_days + " days)");
    console.log("");
    console.log("  Status breakdown:");
    for (const [st, cnt] of Object.entries(gs.status_breakdown || {}).sort((a, b) => b[1] - a[1])) {
      console.log("    " + st.padEnd(20) + " " + cnt);
    }
    if (gs.top_largest && gs.top_largest.length > 0) {
      console.log("  Top largest (by bytes):");
      for (const g of gs.top_largest) {
        console.log("    " + g.name.padEnd(30) + " " + g.total_bytes_h.padEnd(10) + " " + g.status.padEnd(20) + " " + g.file_count + " files");
      }
    }
    if (gs.top_by_file_count && gs.top_by_file_count.length > 0) {
      console.log("  Top by file count:");
      for (const g of gs.top_by_file_count) {
        console.log("    " + g.name.padEnd(30) + " " + g.file_count + " files  " + g.total_bytes_h.padEnd(10) + " " + g.status);
      }
    }
    console.log("");
    console.log("Events:");
    console.log("  files: " + es.file_count + "  bytes: " + es.total_bytes_h);

  } else if (subcommand === "cleanup") {
    const dryRun = rest.includes("--dry-run") || !rest.includes("--apply");
    const { cleanupGoals } = await import("../src/goal-storage-service.mjs");
    const maxAgeDays = (function(){ const i = rest.indexOf("--max-age-days"); return i >= 0 ? Number(rest[i+1]) : null; })();
    const maxGoalDirs = (function(){ const i = rest.indexOf("--max-goal-dirs"); return i >= 0 ? Number(rest[i+1]) : null; })();
    const archive = !rest.includes("--no-archive");
    const opts = { workspaceRoot, dryRun, archive };
    if (maxAgeDays !== null) opts.maxAgeMs = maxAgeDays * 86400000;
    if (maxGoalDirs !== null) opts.maxGoalDirs = maxGoalDirs;
    const result = await cleanupGoals(opts);

    console.log("GPTWork Goal Cleanup");
    console.log("=".repeat(60));
    console.log("  Mode:           " + (dryRun ? "dry-run (no changes)" : "applied"));
    console.log("  Eligible:       " + result.eligible + " terminal goal(s)");
    console.log("  Skipped:        " + result.skipped + " goal(s) preserved");
    console.log("  Total:          " + result.total_goal_dirs + " goal dir(s)");
    console.log("  Files before:   " + result.total_files);
    console.log("  Freed:          " + result.freed_bytes_h);
    console.log("  Archived:       " + result.archived);
    if (result.details && result.details.length > 0) {
      console.log("");
      console.log("  Eligible goals:");
      for (const d of result.details) {
        console.log("    " + d.name.padEnd(30) + " " + d.status.padEnd(20) + " age=" + d.age_days + "d files=" + d.file_count + " " + d.total_bytes_h);
      }
    }
    console.log("");
    console.log("  " + result.message);

  } else if (subcommand === "rotate-events") {
    const keepDays = (function(){ const i = rest.indexOf("--keep-days"); return i >= 0 ? Number(rest[i+1]) : 7; })();
    const apply = rest.includes("--apply");
    if (apply) {
      const { rotateEvents } = await import("../src/goal-storage-service.mjs");
      const result = await rotateEvents(workspaceRoot, keepDays);
      console.log("GPTWork Event Rotation");
      console.log("=".repeat(60));
      console.log("  Deleted: " + result.deleted + " file(s)");
      console.log("  Kept:    " + result.kept + " file(s)");
      console.log("  " + result.message);
    } else {
      const { scanEvents } = await import("../src/goal-storage-service.mjs");
      const es = await scanEvents(workspaceRoot);
      console.log("GPTWork Event Rotation (dry-run)");
      console.log("=".repeat(60));
      console.log("  Current: " + es.file_count + " file(s), " + es.total_bytes_h);
      console.log("  Would keep: last " + keepDays + " day(s)");
      console.log("  Use --apply to rotate.");
    }

  } else {
    console.log("Usage:");
    console.log("  gptwork goals storage-status");
    console.log("  gptwork goals cleanup [--dry-run|--apply] [--max-age-days <n>] [--max-goal-dirs <n>] [--archive|--no-archive]");
    console.log("  gptwork goals rotate-events [--keep-days <n>] [--apply]");
  }
}


async function handleRetention() {
  const { store, config } = await localStore();
  const [ subcommand, ...rest ] = args.slice(1);
  const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
  const { retentionStatus, retentionCleanup, getRetentionConfig } = await import("../src/retention-service.mjs");
  const retCfg = getRetentionConfig();

  if (subcommand === "status") {
    const result = await retentionStatus({ config, store, workspaceRoot });
    const families = result.families || [];
    console.log("GPTWork Retention Status");
    console.log("=".repeat(60));
    console.log("  Retention:            " + (retCfg.enabled ? "enabled" : "disabled"));
    console.log("  Dry-run default:      " + retCfg.dryRunDefault);
    console.log("  Archive before delete: " + retCfg.archiveBeforeDelete);
    console.log("  Per-category limit:    " + retCfg.limit);
    console.log("  Families:             " + families.length);
    console.log("");

    const stateFamilies = families.filter((f) => f.type === "state" || !f.type);
    const fsFamilies = families.filter((f) => f.type === "filesystem");

    console.log("  State Record Families:");
    console.log("    " + "Name".padEnd(20) + " " + "Cnt".padEnd(5) + " " + "Act".padEnd(5) + " " + "Term".padEnd(6) + " " + "Action");
    console.log("    " + "-".repeat(20) + " " + "-".repeat(5) + " " + "-".repeat(5) + " " + "-".repeat(6) + " " + "-".repeat(28));
    for (const f of stateFamilies) {
      const proposedAction = f.proposed_action || f.proposedAction || "none";
      console.log("    " + f.name.padEnd(20) + " " + String(f.current_count).padEnd(5) + " " + String(f.active_count).padEnd(5) + " " + String(f.terminal_count).padEnd(6) + " " + proposedAction.slice(0, 28).padEnd(28));
    }

    if (fsFamilies.length > 0) {
      console.log("");
      console.log("  Filesystem Families:");
      console.log("    " + "Name".padEnd(20) + " " + "Cnt".padEnd(5) + " " + "Bytes".padEnd(10));
      for (const f of fsFamilies) {
        console.log("    " + f.name.padEnd(20) + " " + String(f.current_count).padEnd(5) + " " + (f.bytes_h || "0 B").padEnd(10) + "  " + (f.proposed_action || ""));
      }
    }

    console.log("");
    console.log("  Use  to preview cleanup.");

  } else if (subcommand === "cleanup") {
    const dryRun = rest.includes("--dry-run") || !rest.includes("--apply");
    const limit = (function(){ const i = rest.indexOf("--limit"); return i >= 0 ? Number(rest[i+1]) : 50; })();
    const archive = !rest.includes("--no-archive");

    const result = await retentionCleanup({
      config, store, workspaceRoot,
      limit, dryRun, archiveBeforeDelete: archive,
    });

    console.log("GPTWork Retention Cleanup");
    console.log("=".repeat(60));
    console.log("  Mode:           " + (dryRun ? "dry-run (no changes)" : "applied"));
    console.log("  Limit:          " + limit);
    console.log("  Archive:        " + (archive ? "yes" : "no"));
    console.log("  Changes:        " + result.changes_count);
    console.log("  Skipped:        " + result.skipped_count);
    console.log("");

    if (result.before) {
      console.log("  Before: tasks=" + result.before.tasks + " goals=" + result.before.goals);
    }
    if (result.after) {
      console.log("  After:  tasks=" + result.after.tasks + " goals=" + result.after.goals);
    }

    if (result.changes && result.changes.length > 0) {
      console.log("");
      console.log("  Changes:");
      for (const c of result.changes.slice(0, 30)) {
        console.log("    " + c.category.padEnd(20) + " " + c.action.padEnd(18) + " " + (c.description || "").slice(0, 60));
      }
      if (result.changes.length > 30) {
        console.log("    ... and " + (result.changes.length - 30) + " more");
      }
    }

    if (result.skipped && result.skipped.length > 0) {
      console.log("");
      console.log("  Skipped (preserved):");
      for (const s of result.skipped.slice(0, 15)) {
        console.log("    " + s.category.padEnd(20) + " " + s.reason.padEnd(18) + " " + (s.description || "").slice(0, 60));
      }
      if (result.skipped.length > 15) {
        console.log("    ... and " + (result.skipped.length - 15) + " more");
      }
    }

    console.log("");
    console.log("  Audit ID:       " + (result.audit_id || "none"));
    console.log("  Elapsed:        " + result.elapsed_ms + "ms");
    console.log("  " + result.message);

  } else {
    console.log("Usage:");
    console.log("  gptwork retention status");
    console.log("  gptwork retention cleanup [--dry-run|--apply] [--limit <n>] [--archive|--no-archive]");
  }
}

async function main() {
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "setup") return printSetup();
  if (command === "start") return startServer();
  if (command === "connect") return printConnect();
  if (command === "init") {
    const help = args.includes("--help");
    if (help) {
      console.log("gptwork init -- one-step initialization and diagnostics");
      console.log("  Use --production to enable production-specific checks");
      return;
    }
    return printInit({ production: args.includes("--production") });
  }
  if (command === "fix") {
    if (args.includes("--help")) {
      console.log("gptwork fix -- automated repair for common initialization issues");
      return;
    }
    return printFix();
  }

  if (command === "status") return printStatus();
  const doctorProduction = args.includes("--production");
  if (command === "doctor") return printDoctor({ production: doctorProduction });
  if (command === "self-test") return printSelfTest();
  if (command === "verify-delivery") return runVerifyDelivery([subcommand, ...rest].filter(Boolean));
  if (command === "demo-multi-task") return runDemoMultiTask([subcommand, ...rest].filter(Boolean));
  if (command === "settings" && subcommand === "show") return showSettings();
  if (command === "settings" && subcommand === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) throw new Error("Usage: gptwork settings set KEY VALUE");
    return setRuntimeEnv(key, value);
  }
  if (command === "logs") {
    const logPath = process.env.GPTWORK_LOG_PATH || "/tmp/gptwork-mcp.log";
    console.log(existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-8000) : `No log file at ${logPath}`);
    return;
  }
  
  if (command === 'queue') {
    const sub = subcommand;
    if (sub === 'list') {
      const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
      const config = rc.config;
      const store = new StateStore({
        statePath: config.statePath,
        defaultWorkspaceRoot: config.workspaceRoot,
      });
      await store.load();
      const opts = {};
      const idx_status = rest.indexOf('--status');
      if (idx_status >= 0 && rest[idx_status + 1]) opts.status = rest[idx_status + 1];
      const result = await listGoalQueue(store, opts);
      console.log('Goal Queue');
      console.log('='.repeat(60));
      if (result.items.length === 0) {
        console.log('  (empty)');
      } else {
        for (const item of result.items) {
          const status = String(item.status || '?').padEnd(10);
          const title = (item.goal_title || '').slice(0, 50);
          console.log('  ' + item.queue_id + '  [' + status + ']  pos=' + item.position + '  goal=' + item.goal_id + '  ' + title);
          if (item.task_id) console.log('         task=' + item.task_id);
          if (item.blocked_reason) console.log('         blocked: ' + item.blocked_reason);
          if (item.depends_on_goal_id) console.log('         depends_on_goal: ' + item.depends_on_goal_id);
          if (item.depends_on_task_id) console.log('         depends_on_task: ' + item.depends_on_task_id);
        }
      }
      console.log('');
      console.log('Total: ' + result.total + ' items');
      return;
    }
    if (sub === 'start-next') {
      const dryRun = rest.includes('--dry-run');
      const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
      const config = rc.config;
      const store = new StateStore({
        statePath: config.statePath,
        defaultWorkspaceRoot: config.workspaceRoot,
      });
      await store.load();
      const result = await startNextQueuedGoal(store, config, { dry_run: dryRun });
      console.log('GPTWork Queue: start-next');
      console.log('='.repeat(60));
      console.log('started: ' + result.started);
      console.log('reason: ' + result.reason);
      if (result.item) {
        console.log('queue_id: ' + result.item.queue_id);
        console.log('goal_id: ' + result.item.goal_id);
        console.log('status: ' + result.item.status);
      }
      if (result.task) {
        console.log('task_id: ' + result.task.id);
        console.log('task_status: ' + result.task.status);
      }
      console.log('');
      console.log('Checks:');
      for (const c of result.checks || []) {
        const icon = c.passed ? 'OK' : 'BLOCKED';
        console.log('  ' + icon + ' ' + c.check + ': ' + c.detail);
      }
      return;
    }
    if (sub === 'enqueue') {
      const goalId = rest[0];
      if (!goalId) throw new Error('Usage: gptwork queue enqueue <goal_id>');
      const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
      const config = rc.config;
      const store = new StateStore({
        statePath: config.statePath,
        defaultWorkspaceRoot: config.workspaceRoot,
      });
      await store.load();
      const idx_dep_goal = rest.indexOf('--depends-on-goal');
      const idx_dep_task = rest.indexOf('--depends-on-task');
      const opts = {};
      if (idx_dep_goal >= 0 && rest[idx_dep_goal + 1]) opts.depends_on_goal_id = rest[idx_dep_goal + 1];
      if (idx_dep_task >= 0 && rest[idx_dep_task + 1]) opts.depends_on_task_id = rest[idx_dep_task + 1];
      const result = await enqueueGoal(store, goalId, opts);
      console.log('GPTWork Queue: enqueue');
      console.log('='.repeat(60));
      if (result.ok) {
        console.log('Enqueued goal ' + goalId);
        console.log('queue_id: ' + result.item.queue_id);
        console.log('position: ' + result.item.position);
        console.log('status: ' + result.item.status);
      } else {
        console.log('Failed: ' + result.warnings.join(', '));
      }
      return;
    }
    if (sub === 'cancel') {
      const queueId = rest[0];
      if (!queueId) throw new Error('Usage: gptwork queue cancel <queue_id>');
      const rc = buildRuntimeConfig(workspaceRoot(), process.env.GPTWORK_RUNTIME_ENV_FILE);
      const config = rc.config;
      const store = new StateStore({
        statePath: config.statePath,
        defaultWorkspaceRoot: config.workspaceRoot,
      });
      await store.load();
      const result = await cancelGoalQueueItem(store, queueId);
      console.log('GPTWork Queue: cancel');
      console.log('='.repeat(60));
      if (result.ok) {
        console.log('Cancelled queue item ' + queueId);
      } else {
        console.log('Failed: ' + result.warnings.join(', '));
      }
      return;
    }
    throw new Error('Unknown queue subcommand: ' + sub + '. Usage: gptwork queue list|start-next|enqueue <goal_id>|cancel <queue_id>');
  }

  if (command === "watch-handoff") {
    return handleWatchHandoff();
  } else if (command === "tmp") {
    return handleTmp();
  } else if (command === "goals") {
    return handleGoals();
  } else if (command === "retention") {
    return handleRetention();
  }
  throw new Error(`Unknown command: ${command} ${subcommand}\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
