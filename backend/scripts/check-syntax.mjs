#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { cpus } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(cpus().length || 1, 8));
const STDERR_TAIL = 2000;

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tail(value, max = STDERR_TAIL) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}

function parseArgs(argv) {
  const out = { files: null, concurrency: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--files") {
      out.files = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--files=")) {
      out.files = arg.slice("--files=".length);
    } else if (arg === "--concurrency") {
      out.concurrency = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--concurrency=")) {
      out.concurrency = Number(arg.slice("--concurrency=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function normalizeExplicitFiles(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((file) => file.trim())
    .filter(Boolean);
}

async function discoverFiles(root) {
  const files = [];
  async function walk(dir, predicate) {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "coverage"].includes(entry.name)) continue;
        await walk(path, predicate);
      } else if (entry.isFile() && predicate(entry.name, path)) {
        files.push(path);
      }
    }
  }
  await walk(join(root, "src"), (name) => name.endsWith(".mjs"));
  await walk(join(root, "test"), (name) => name.endsWith(".test.mjs"));
  return files.sort();
}

function runNodeCheck(file) {
  return new Promise((resolveCheck) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      resolveCheck({ file, exit_code: 1, signal: null, duration_ms: Date.now() - started, stdout, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      resolveCheck({ file, exit_code: code ?? 1, signal, duration_ms: Date.now() - started, stdout, stderr });
    });
  });
}

async function runPool(files, concurrency) {
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const result = await runNodeCheck(file);
      if (result.exit_code !== 0 || result.signal) failures.push(result);
    }
  }
  const workerCount = Math.min(concurrency, Math.max(1, files.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return failures;
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const envConcurrency = Number(process.env.GPTWORK_CHECK_SYNTAX_CONCURRENCY);
  const concurrency = Math.max(1, Math.floor(args.concurrency || envConcurrency || DEFAULT_CONCURRENCY));
  const root = process.cwd();
  const files = args.files === null
    ? await discoverFiles(root)
    : normalizeExplicitFiles(args.files).map((file) => resolve(root, file));

  console.log(`[check-syntax] files=${files.length} concurrency=${concurrency}`);
  if (files.length === 0) {
    console.log(`[check-syntax] syntax ok: 0 file(s) duration=${formatDuration(Date.now() - started)}`);
    return;
  }

  const failures = await runPool(files, concurrency);
  const duration = Date.now() - started;
  if (failures.length === 0) {
    console.log(`[check-syntax] syntax ok: ${files.length} file(s) duration=${formatDuration(duration)}`);
    return;
  }

  console.error(`[check-syntax] syntax failed: ${failures.length}/${files.length} file(s) duration=${formatDuration(duration)}`);
  for (const failure of failures) {
    console.error(`\n[check-syntax] ${failure.file} exit=${failure.exit_code}${failure.signal ? ` signal=${failure.signal}` : ""} duration=${formatDuration(failure.duration_ms)}`);
    if (failure.stdout) console.error(`--- stdout tail ---\n${tail(failure.stdout)}`);
    if (failure.stderr) console.error(`--- stderr tail ---\n${tail(failure.stderr)}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[check-syntax] fatal: ${error?.message || String(error)}`);
  process.exit(1);
});
