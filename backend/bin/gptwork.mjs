#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildRuntimeConfig } from "../src/runtime-config.mjs";
import { StateStore } from "../src/state-store.mjs";
import { collectWorkerQueueCounts } from "../src/worker-queue-counts.mjs";
import { handoffToAgent, readHandoff, handoffPaths } from "../src/handoff-service.mjs";
import { enqueueGoal, listGoalQueue, startNextQueuedGoal, cancelGoalQueueItem } from "../src/goal-queue.mjs";

const args = process.argv.slice(2);

function usage() {
  return `gptwork commands:
  setup
  start
  connect [--local]
  status [--local]
  doctor [--local]
  self-test [--local]
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

Queue commands:
  queue list [--status <s>]
  queue start-next [--dry-run]
  queue enqueue <goal_id> [--depends-on-goal <gid>] [--depends-on-task <tid>]
  queue cancel <queue_id>`;

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

async function printDoctor() {
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
    console.log("GPTWork /tmp Status");
    console.log("=".repeat(60));
    console.log("Managed tmp (.gptwork/tmp/):");
    console.log("  files:", managed.fileCount);
    console.log("  bytes:", managed.totalBytesH);
    console.log("System /tmp:");
    console.log("  files:", systemTmp.file_count);
    console.log("  bytes:", systemTmp.total_bytes_h);
    if (inodePressure) {
      console.log("Inode pressure:");
      console.log("  used:", inodePressure.used_pct);
      console.log("  free:", inodePressure.free_inodes);
    }
  } else if (subcommand === "cleanup") {
    const dryRun = rest.includes("--dry-run") || !rest.includes("--apply");
    const { cleanupManagedTmp, cleanupSystemTmp } = await import("../src/gptwork-tmp.mjs");
    const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
    const managedResult = await cleanupManagedTmp({ workspaceRoot, dryRun });
    const systemResult = await cleanupSystemTmp({ dryRun });
    console.log("GPTWork /tmp Cleanup");
    console.log("=".repeat(60));
    console.log(managedResult.dryRun ? "[dry-run]" : "[applied]");
    console.log("Managed tmp:", managedResult.deleted, "deleted,", managedResult.skipped, "skipped");
    console.log("System /tmp:", systemResult.deleted, "deleted,", systemResult.skipped, "skipped");
  } else {
    console.log("Usage: gptwork tmp status|cleanup [--dry-run|--apply]");
  }
}

async function handleGoals() {
  const { store, config } = await localStore();
  const [ subcommand, ...rest ] = args.slice(1);
  if (subcommand === "storage-status") {
    const { scanGoals, scanEvents } = await import("../src/goal-storage-service.mjs");
    const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
    const gs = await scanGoals(workspaceRoot);
    const es = await scanEvents(workspaceRoot);
    console.log("GPTWork Goal Storage");
    console.log("=".repeat(60));
    console.log("Goal dirs:", gs.goal_dir_count);
    console.log("Total files:", gs.total_files);
    console.log("Total bytes:", gs.total_bytes_h);
    if (gs.oldest_goal) console.log("Oldest:", gs.oldest_goal.name, gs.oldest_goal.age_days + " days");
    if (gs.newest_goal) console.log("Newest:", gs.newest_goal.name, gs.newest_goal.age_days + " days");
    console.log("Status:", JSON.stringify(gs.status_breakdown));
    console.log("");
    console.log("Events:");
    console.log("  files:", es.file_count, "bytes:", es.total_bytes_h);
  } else if (subcommand === "cleanup") {
    const dryRun = rest.includes("--dry-run") || !rest.includes("--apply");
    const { cleanupGoals } = await import("../src/goal-storage-service.mjs");
    const workspaceRoot = config.defaultWorkspaceRoot || config.workspaceRoot;
    const result = await cleanupGoals({ workspaceRoot, dryRun });
    console.log("GPTWork Goal Cleanup");
    console.log("=".repeat(60));
    console.log(dryRun ? "[dry-run]" : "[applied]");
    console.log("Eligible:", result.eligible);
    console.log("Skipped:", result.skipped);
    console.log("Freed:", result.freed_bytes_h);
    console.log(result.message);
  } else {
    console.log("Usage: gptwork goals storage-status|cleanup [--dry-run|--apply]");
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
  if (command === "status") return printStatus();
  if (command === "doctor") return printDoctor();
  if (command === "self-test") return printSelfTest();
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
  }
  throw new Error(`Unknown command: ${command} ${subcommand}\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
