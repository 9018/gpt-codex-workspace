#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildRuntimeConfig } from "../src/runtime-config.mjs";
import { StateStore } from "../src/state-store.mjs";
import { collectWorkerQueueCounts } from "../src/worker-queue-counts.mjs";

const args = process.argv.slice(2);

function usage() {
  return `gptwork commands:
  setup
  start
  status [--local]
  doctor [--local]
  settings show
  settings set KEY VALUE
  logs
  goal create --assign --title <title> --prompt <prompt>
  codex run --limit <n>
  github sync
  watch-handoff --dry-run [--agent <name>] [--command <cmd>]`;
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
  return { store, config, envLoadResult: rc.envLoadResult };
}

async function printStatus() {
  const { store, config } = await localStore();
  const state = await store.load();
  const queue = await collectWorkerQueueCounts(store);
  console.log("GPTWork Status");
  console.log(`state: ${config.statePath}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`tool mode: ${config.toolMode}`);
  console.log(`tasks: ${state.tasks.length}`);
  console.log(`goals: ${state.goals.length}`);
  console.log(`queue: assigned=${queue.assigned || 0} queued=${queue.queued || 0} running=${queue.running || 0} waiting=${queue.waiting_for_lock || 0}`);
  console.log(`github: ${config.githubEnabled ? "enabled" : "disabled"}`);
}

async function printDoctor() {
  const { store, config, envLoadResult } = await localStore();
  const state = await store.load();
  console.log("GPTWork Doctor");
  console.log(`runtime env: ${envLoadResult.loadedPath || "missing"}`);
  console.log(`state: ${config.statePath}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`tool mode: ${config.toolMode}`);
  console.log(`tasks: ${state.tasks.length}`);
  console.log(`goals: ${state.goals.length}`);
  console.log(`github: ${config.githubEnabled ? "enabled" : "disabled"}`);
  console.log(`tokens: ${config.tokens ? "configured" : "default"}`);
}

function startServer() {
  const serverPath = resolve(dirname(new URL(import.meta.url).pathname), "../src/cli.mjs");
  const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function main() {
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "setup") {
    const path = runtimeEnvPath();
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "GPTWORK_TOOL_MODE=standard\nGPTWORK_PORT=8787\n", "utf8");
    console.log("GPTWork setup");
    console.log(`runtime env: ${path}`);
    return;
  }
  if (command === "start") return startServer();
  if (command === "status") return printStatus();
  if (command === "doctor") return printDoctor();
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
  if (command === "goal" && subcommand === "create") {
    console.log("Use the MCP create_encoded_goal tool for structured goal creation. CLI HTTP creation will be added on top of this stable command surface.");
    return;
  }
  if (command === "codex" && subcommand === "run") {
    console.log("Use run_assigned_codex_tasks through MCP or enable GPTWORK_CODEX_WORKER=true with gptwork start.");
    return;
  }
  if (command === "github" && subcommand === "sync") {
    console.log("Use sync_from_github/sync_to_github through MCP; this CLI command reserves the stable product entrypoint.");
    return;
  }
  if (command === "watch-handoff") {
    const dryRun = args.includes("--dry-run");
    const agentIdx = args.indexOf("--agent");
    const agent = agentIdx >= 0 ? args[agentIdx + 1] : "codex";
    const planFile = join(workspaceRoot(), ".gptwork/handoff/current-plan.md");
    console.log("GPTWork Handoff Watcher");
    console.log(`agent: ${agent}`);
    console.log(`plan: ${planFile}`);
    console.log(`dry_run: ${dryRun ? "true" : "false"}`);
    console.log(`plan_exists: ${existsSync(planFile) ? "true" : "false"}`);
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
