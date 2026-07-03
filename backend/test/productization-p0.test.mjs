import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
afterEachHook(test);

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(TEST_DIR, "../bin/gptwork.mjs");


async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p0-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "test workspace\n", "utf8");
  track(root);
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
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
  assert.equal(context.repo.root, context.config.workspace_root);
  assert.equal(typeof context.repo.dirty, "boolean");
  assert.ok(context.config.tool_mode);
  assert.ok(context.project_files.some((file) => file.name === "README.md"));
  assert.ok(Array.isArray(context.file_tree));
  assert.ok(context.file_tree.length <= 80);
  assert.ok(context.recommended_next_tools.includes("create_encoded_goal"));
  assert.match(response.result.content[0].text, /Project Context/);
});

test("open_project_context reports current blockers separately from raw legacy history", async () => {
  const server = await makeServer();
  const store = server.getStoreForTests();
  store.state.tasks = [
    {
      id: "task_legacy_zvec",
      title: "Legacy failed zvec repair",
      status: "waiting_for_review",
      assignee: "codex",
      updated_at: "2026-01-01T00:00:00Z",
      result: { resolved_by_task_id: "task_successor_zvec", superseded_by_task_id: "task_successor_zvec" },
    },
    {
      id: "task_successor_zvec",
      title: "Completed zvec delivery",
      status: "completed",
      assignee: "codex",
      updated_at: "2026-01-02T00:00:00Z",
      result: { verification: { passed: true }, commit: "4ad576495f4101e39955ea7e4028da3c3d15b4d4" },
    },
  ];
  store.state.goals = [
    { id: "goal_legacy_zvec", task_id: "task_legacy_zvec", title: "Legacy zvec", status: "completed" },
  ];
  await store.save();

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "open_project_context", arguments: {} },
  }, { authorization: "Bearer test-token" });

  const context = response.result.structuredContent;
  assert.equal(context.current_blockers.waiting_for_review, 0);
  assert.equal(context.current_blockers.actionable_review, 0);
  assert.equal(context.raw_history.resolved_legacy_review, 1);
  const legacyTask = context.state_summary.recent_tasks.find((task) => task.id === "task_legacy_zvec");
  assert.equal(legacyTask.legacy_resolution.resolved, true);
  assert.equal(legacyTask.legacy_resolution.resolved_by_task_id, "task_successor_zvec");
});

test("open_project_context uses queue-derived actionable review counts", async () => {
  const server = await makeServer();
  const store = server.getStoreForTests();
  store.state.tasks = [
    {
      id: "task_legacy_review_indexed",
      title: "Legacy review already handled",
      status: "waiting_for_review",
      assignee: "codex",
      updated_at: "2026-01-01T00:00:00Z",
      result: { resolved_by_task_id: "task_successor_indexed" },
    },
    {
      id: "task_active_review_indexed",
      title: "Active review still pending",
      status: "waiting_for_review",
      assignee: "codex",
      updated_at: "2026-01-02T00:00:00Z",
      result: {},
    },
    {
      id: "task_successor_indexed",
      title: "Completed successor",
      status: "completed",
      assignee: "codex",
      updated_at: "2026-01-03T00:00:00Z",
      result: { verification: { passed: true } },
    },
  ];
  const originalGetCodexTaskQueue = store.getCodexTaskQueue.bind(store);
  store.getCodexTaskQueue = () => ({
    ...originalGetCodexTaskQueue(),
    counts: {
      ...originalGetCodexTaskQueue().counts,
      waiting_for_review: 1,
    },
  });
  await store.save();

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "open_project_context", arguments: {} },
  }, { authorization: "Bearer test-token" });

  const context = response.result.structuredContent;
  assert.equal(context.worker.queue.actionable_review, 0);
  assert.equal(context.current_blockers.actionable_review, 0);
  assert.equal(context.current_blockers.waiting_for_review, 0);
  assert.equal(context.raw_history.waiting_for_review_total, 2);
  assert.equal(context.raw_history.resolved_legacy_review, 1);
});

test("P0 integrated context and cards keep raw history out of current blockers", async () => {
  const server = await makeServer();
  const store = server.getStoreForTests();
  store.state.tasks = [
    {
      id: "task_raw_review_history",
      title: "Raw review history already resolved",
      status: "waiting_for_review",
      assignee: "codex",
      result: { resolved_by_task_id: "task_successor_done" },
    },
    {
      id: "task_raw_failed_history",
      title: "Historical failure already integrated",
      status: "failed",
      assignee: "codex",
      goal_id: "goal_main",
      result: { tests: "old failed run" },
    },
    {
      id: "task_successor_done",
      title: "Integrated successor",
      status: "completed",
      assignee: "codex",
      goal_id: "goal_main",
      result: { verification: { passed: true }, commit: "4666957538bb5ff62602ff22bfff5d183eb24b9b" },
    },
    {
      id: "task_waiting_repair",
      title: "Repair is pending",
      status: "waiting_for_repair",
      assignee: "codex",
      result: { summary: "Needs repair" },
    },
  ];
  await store.save();

  const contextResponse = await server.handleRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "open_project_context", arguments: {} },
  }, { authorization: "Bearer test-token" });
  const context = contextResponse.result.structuredContent;

  assert.equal(context.current_blockers.actionable_review, 0);
  assert.equal(context.current_blockers.failed, 0);
  assert.equal(context.current_blockers.waiting_for_repair, 1);
  assert.equal(context.worker.queue.actionable_review, 0);
  assert.equal(context.worker.queue.failed, 0);
  assert.equal(context.worker.queue.policy_counts.waiting_for_repair, 1);
  assert.equal(context.worker.queue.raw_counts.waiting_for_repair, 1);
  assert.equal(context.raw_history.waiting_for_review_total, 1);
  assert.equal(context.raw_history.resolved_legacy_review, 1);
  assert.equal(context.worktree_retention.ok, true);
  assert.equal(typeof context.worktree_retention.cleanup_candidates_count, "number");

  const workerResponse = await server.handleRpc({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "worker_status", arguments: {} },
  }, { authorization: "Bearer test-token" });
  const workerText = workerResponse.result.content[0].text;
  assert.match(workerText, /waiting_for_repair/);
  assert.match(JSON.stringify(workerResponse.result.structuredContent.queue), /waiting_for_repair/);
  assert.match(JSON.stringify(workerResponse.result.structuredContent.card || {}), /waiting_for_repair/);
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

test("MA10 production init script validates required files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-init-"));
  track(root);
  const backendRoot = resolve(TEST_DIR, "..");
  const projectRoot = resolve(backendRoot, "..");

  // Run init script in check-only mode from project root
  const result = execFileSync("node", ["scripts/init-production.mjs", "--check-only"], {
    cwd: backendRoot,
    encoding: "utf8",
    timeout: 15_000,
  });

  assert.match(result, /package\.json/);
  assert.match(result, /CLI entry/);
  assert.match(result, /systemd unit/);
  assert.match(result, /runtime env template/);
  assert.match(result, /Production baseline is ready/);
});

test("MA10 launch initialization document exists and has required sections", async () => {
  const repoRoot = resolve(TEST_DIR, "../..");
  const doc = await readFile(join(repoRoot, "docs", "launch-initialization.md"), "utf8");

  assert.match(doc, /Productization Baseline/);
  assert.match(doc, /Startup \/ Default Configuration/);
  assert.match(doc, /One-Shot Production Initialization/);
  assert.match(doc, /3502bc99c93abf83805761dfdb0f3793cd4d0a81/);
  assert.ok(doc.length > 2000, "Document should be substantial");
});

test("MA10 closure acceptance documentation exists and has required sections", async () => {
  const repoRoot = resolve(TEST_DIR, "../..");
  const doc = await readFile(join(repoRoot, "docs", "closure-acceptance.md"), "utf8");

  assert.match(doc, /MA1-MA9 Release-Gate Evidence/);
  assert.match(doc, /Remaining Non-Security Risks/);
  assert.match(doc, /Operator-Facing Acceptance Procedure/);
  assert.match(doc, /Closure Criteria/);
  assert.match(doc, /3502bc99c93abf83805761dfdb0f3793cd4d0a81/);
  assert.ok(doc.length > 2000, "Document should be substantial");
});

test("MA10 no further MA task was started", () => {
  // Verify the scope boundary: no MA11 task directory or reference exists
  const repoRoot = resolve(TEST_DIR, "../..");
  const lsFiles = execFileSync("git", ["ls-files", "--", "docs/ma11*", "docs/MA11*", "backend/scripts/ma11*"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(lsFiles, "", "No MA11 files should exist");
});
