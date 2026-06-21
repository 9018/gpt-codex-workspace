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

async function makeServer(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p1-"));
  return {
    root,
    server: await createGptWorkServer({
      statePath: join(root, "state.json"),
      defaultWorkspaceRoot: join(root, "workspace"),
      tokens: ["test-token"],
      requireAuth: true,
      ...extra,
    }),
  };
}

async function makeGitRepo(prefix = "gptwork-repo-") {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return repo;
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
  const repo = await makeGitRepo("gptwork-changes-");
  await writeFile(join(repo, "a.txt"), "one\ntwo\n", "utf8");

  const { server } = await makeServer();
  const changes = await call(server, "show_changes", { path: repo });

  assert.equal(changes.changed_files.length, 1);
  assert.equal(changes.changed_files[0].path, "a.txt");
  assert.ok(changes.summary.includes("1 changed file"));
  assert.ok(changes.diff_excerpt.includes("+two"));
});

test("show_changes defaults to configured defaultRepoPath", async () => {
  const repo = await makeGitRepo("gptwork-default-changes-");
  await writeFile(join(repo, "a.txt"), "one\ndefault path\n", "utf8");
  const root = await mkdtemp(join(tmpdir(), "gptwork-p1-default-"));
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    defaultRepoPath: repo,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "codex",
  });

  const changes = await call(server, "show_changes", {});

  assert.equal(changes.repo, repo);
  assert.equal(changes.changed_files.length, 1);
  assert.ok(changes.diff_excerpt.includes("+default path"));
});

test("open_project_context prefers the registered canonical repository", async () => {
  const repo = await makeGitRepo("gptwork-context-repo-");
  const { server } = await makeServer({ toolMode: "full" });

  await call(server, "register_repository", {
    remote_url: "https://github.com/example/context-repo.git",
    canonical_path: repo,
  });
  const context = await call(server, "open_project_context", {});

  assert.equal(context.repo.root, repo);
  assert.ok(context.file_tree.includes("a.txt"));
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

test("append_agent_event writes to event log and hook bus", async () => {
  const { server, root } = await makeServer();
  const created = await call(server, "create_agent_run", { role: "implementer" });

  const evented = await call(server, "append_agent_event", {
    agent_run_id: created.agent_run.id,
    type: "progress",
    message: "started work",
  });
  assert.equal(evented.agent_run.events[0].message, "started work");
  assert.equal(evented.event.message, "started work");
});

test("cancel_agent_run marks agent run cancelled with reason and event", async () => {
  const { server } = await makeServer();
  const created = await call(server, "create_agent_run", { role: "implementer" });

  const cancelled = await call(server, "cancel_agent_run", {
    agent_run_id: created.agent_run.id,
    reason: "scope changed",
  });
  assert.equal(cancelled.agent_run.status, "cancelled");
  assert.equal(cancelled.agent_run.summary, "scope changed");
  assert.equal(cancelled.agent_run.events[0].type, "cancelled");
});

test("run_agent_pipeline returns pipeline plan and event log entry", async () => {
  const { server } = await makeServer();
  const result = await call(server, "run_agent_pipeline", {
    goal_id: "goal_pipeline_test",
    roles: ["planner", "implementer"],
  });

  assert.ok(result.pipeline, "should have pipeline object");
  assert.ok(result.pipeline.id.startsWith("pipeline_"), "pipeline should have id");
  assert.equal(result.pipeline.goal_id, "goal_pipeline_test");
  assert.equal(result.pipeline.review_gate_after, "reviewer");
  assert.deepEqual(result.pipeline.roles, ["planner", "implementer"]);
  assert.equal(result.count, 2);
  assert.equal(result.agent_runs.length, 2);
  assert.equal(result.agent_runs[0].status, "queued");
});

test("run_agent_pipeline with custom review gate and execution order", async () => {
  const { server } = await makeServer();
  const result = await call(server, "run_agent_pipeline", {
    goal_id: "goal_custom",
    roles: ["tester", "reviewer"],
    review_gate_after: "tester",
    execution_order: ["tester", "reviewer"],
  });

  assert.ok(result.pipeline);
  assert.equal(result.pipeline.review_gate_after, "tester");
  assert.deepEqual(result.pipeline.execution_order, ["tester", "reviewer"]);
  assert.equal(result.count, 2);
});

test("show_changes returns staged and unstaged counts", async () => {
  const repo = await makeGitRepo("gptwork-changes2-");

  // Create a staged change
  await writeFile(join(repo, "b.txt"), "staged\n", "utf8");
  execFileSync("git", ["add", "b.txt"], { cwd: repo, stdio: "ignore" });
  // Create an unstaged change
  await writeFile(join(repo, "a.txt"), "one\nunstaged\n", "utf8");

  const { server } = await makeServer();
  const changes = await call(server, "show_changes", { path: repo });

  assert.equal(changes.changed_files.length, 2, "should see both files");
  assert.ok("staged_count" in changes, "should have staged_count");
  assert.ok("unstaged_count" in changes, "should have unstaged_count");
  assert.ok("artifact_path" in changes, "should have artifact_path");
  assert.ok(changes.artifact_path.endsWith(".gptwork/handoff"), "artifact path should point to handoff dir");
});

test("gptwork watch-handoff supports --once and --command", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-watch-once-"));
  const env = { ...process.env, GPTWORK_WORKSPACE_ROOT: root };
  const out = execFileSync("node", [CLI_BIN, "watch-handoff", "--once", "--agent", "tester", "--command", "npm test"], {
    env,
    encoding: "utf8",
  });

  assert.match(out, /GPTWork Handoff Watcher/);
  assert.match(out, /agent: tester/);
  assert.match(out, /once: true/);
  assert.match(out, /Mode: once/);
});

test("agent_run events reflect pipeline lifecycle events via event log", async () => {
  const { server, root } = await makeServer();
  const created = await call(server, "create_agent_run", { role: "planner" });

  await call(server, "append_agent_event", {
    agent_run_id: created.agent_run.id,
    type: "progress",
    message: "gathering requirements",
  });

  const completed = await call(server, "complete_agent_run", {
    agent_run_id: created.agent_run.id,
    summary: "plan created",
  });
  assert.equal(completed.agent_run.status, "completed");

  // Verify agent run events are preserved
  const fetched = await call(server, "get_agent_run", { agent_run_id: created.agent_run.id });
  assert.equal(fetched.agent_run.events.length, 2);
  assert.equal(fetched.agent_run.events[0].message, "gathering requirements");
});
