import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

function handoffDir(config) {
  return join(config.defaultWorkspaceRoot, ".gptwork/handoff");
}

export function handoffPaths(config) {
  const dir = handoffDir(config);
  return {
    dir,
    plan_file: join(dir, "current-plan.md"),
    status_file: join(dir, "agent-status.json"),
    diff_file: join(dir, "implementation-diff.patch"),
    log_file: join(dir, "execution-log.jsonl"),
  };
}

export async function handoffToAgent(config, args = {}) {
  const paths = handoffPaths(config);
  await mkdir(paths.dir, { recursive: true });
  const status = {
    agent: args.agent || "codex",
    goal_id: args.goal_id || "",
    task_id: args.task_id || "",
    status: "ready",
    created_at: new Date().toISOString(),
  };
  const plan = args.plan || "";
  await writeFile(paths.plan_file, plan, "utf8");
  await writeFile(paths.status_file, JSON.stringify(status, null, 2), "utf8");
  await writeFile(paths.log_file, JSON.stringify({ event: "handoff_created", ...status }) + "\n", "utf8");
  return { handoff: { ...status, plan_file: paths.plan_file, status_file: paths.status_file, log_file: paths.log_file } };
}

export async function readHandoff(config) {
  const paths = handoffPaths(config);
  const plan = existsSync(paths.plan_file) ? readFileSync(paths.plan_file, "utf8") : "";
  let status = { agent: "", status: "missing" };
  try {
    status = JSON.parse(readFileSync(paths.status_file, "utf8"));
  } catch {}
  return { plan, status, paths };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export async function showChanges(args = {}, config = {}) {
  const repo = resolve(args.path || config.defaultRepoPath || process.cwd());
  const statusText = git(["status", "--short"], repo);
  const changedFiles = statusText.split("\n").filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3).trim(),
  }));
  const diff = git(["diff", "--", "."], repo);
  const excerptLimit = Number(args.max_diff_bytes) || 12000;
  const summary = `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`;
  return {
    repo,
    summary,
    changed_files: changedFiles,
    diff_excerpt: diff.slice(0, excerptLimit),
    diff_truncated: diff.length > excerptLimit,
  };
}
