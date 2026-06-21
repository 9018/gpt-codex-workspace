import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { buildAgentRunComment } from "../src/github-issue-formatters.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(TEST_DIR, "../bin/gptwork.mjs");

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p1-"));
  return {
    root,
    server: await createGptWorkServer({
      statePath: join(root, "state.json"),
      defaultWorkspaceRoot: join(root, "workspace"),
      tokens: ["test-token"],
      requireAuth: true,
    }),
  };
}

async function call(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, { authorization: "Bearer test-token" });
  assert.ifError(response.error);
  return response.result.structuredContent;
}

test("agent run tools create, list, append events, get, and complete runs", async () => {
  const { server } = await makeServer();
  const created = await call(server, "create_agent_run", {
    goal_id: "goal_1",
    task_id: "task_1",
    role: "implementer",
    agent: "codex",
    input_artifacts: ["plan.md"],
  });

  assert.match(created.agent_run.id, /^agent_run_/);
  assert.equal(created.agent_run.status, "queued");

  const evented = await call(server, "append_agent_event", {
    agent_run_id: created.agent_run.id,
    type: "progress",
    message: "started",
  });
  assert.equal(evented.agent_run.events[0].message, "started");

  const completed = await call(server, "complete_agent_run", {
    agent_run_id: created.agent_run.id,
    status: "completed",
    summary: "implemented",
    output_artifacts: ["result.json"],
  });
  assert.equal(completed.agent_run.status, "completed");
  assert.equal(completed.agent_run.summary, "implemented");

  const listed = await call(server, "list_agent_runs", { goal_id: "goal_1" });
  assert.equal(listed.agent_runs.length, 1);

  const fetched = await call(server, "get_agent_run", { agent_run_id: created.agent_run.id });
  assert.equal(fetched.agent_run.id, created.agent_run.id);
});

test("handoff_to_agent writes plan files and read_handoff returns them", async () => {
  const { server, root } = await makeServer();
  const handed = await call(server, "handoff_to_agent", {
    agent: "codex",
    plan: "# Plan\n\nImplement the next task.",
    goal_id: "goal_1",
    task_id: "task_1",
  });

  assert.equal(handed.handoff.agent, "codex");
  assert.ok(handed.handoff.plan_file.endsWith(".gptwork/handoff/current-plan.md"));
  assert.match(await readFile(handed.handoff.plan_file, "utf8"), /Implement the next task/);

  const read = await call(server, "read_handoff", {});
  assert.match(read.plan, /Implement the next task/);
  assert.equal(read.status.agent, "codex");
  assert.ok(read.paths.plan_file.startsWith(join(root, "workspace")));
});

test("show_changes returns compact git review summary", async () => {
  const repo = await mkdtemp(join(tmpdir(), "gptwork-changes-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "a.txt"), "one\ntwo\n", "utf8");

  const { server } = await makeServer();
  const changes = await call(server, "show_changes", { path: repo });

  assert.equal(changes.changed_files.length, 1);
  assert.equal(changes.changed_files[0].path, "a.txt");
  assert.ok(changes.summary.includes("1 changed file"));
  assert.ok(changes.diff_excerpt.includes("+two"));
});

test("gptwork watch-handoff supports dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-watch-"));
  const env = { ...process.env, GPTWORK_WORKSPACE_ROOT: root };
  const out = execFileSync("node", [CLI_BIN, "watch-handoff", "--agent", "codex", "--dry-run"], {
    env,
    encoding: "utf8",
  });

  assert.match(out, /GPTWork Handoff Watcher/);
  assert.match(out, /agent: codex/);
  assert.match(out, /dry_run: true/);
});

test("agent run GitHub comments show compact progress and result", () => {
  const progress = buildAgentRunComment({
    id: "agent_run_1",
    role: "tester",
    agent: "codex",
    status: "running",
    summary: "running checks",
    events: [{ type: "progress", message: "npm test started", created_at: "2026-06-22T00:00:00.000Z" }],
  });
  const result = buildAgentRunComment({
    id: "agent_run_1",
    role: "tester",
    agent: "codex",
    status: "completed",
    summary: "tests passed",
    output_artifacts: ["result.json"],
  });

  assert.match(progress, /Agent Run Progress/);
  assert.match(progress, /npm test started/);
  assert.match(result, /Agent Run Result/);
  assert.match(result, /tests passed/);
  assert.match(result, /result\.json/);
});
