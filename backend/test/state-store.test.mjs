import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StateStore } from "../src/state-store.mjs";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

function withoutGptWorkStatePath(fn) {
  return async (...args) => {
    const prev = process.env.GPTWORK_STATE_PATH;
    delete process.env.GPTWORK_STATE_PATH;
    try {
      await fn(...args);
    } finally {
      if (prev !== undefined) process.env.GPTWORK_STATE_PATH = prev;
      else delete process.env.GPTWORK_STATE_PATH;
    }
  };
}

// -----------------------------------------------------------------------
// State path default resolution
// -----------------------------------------------------------------------

test("default state path resolves under workspace root when GPTWORK_STATE_PATH is absent", withoutGptWorkStatePath(async () => {
  const root = await mkdtemp(join(tmpdir(), "state-path-"));
  const workspaceRoot = join(root, "workspace");

  const server = await createGptWorkServer({
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true
  });

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_status", arguments: {} }
  }, { authorization: "Bearer test-token" });

  const status = response.result.structuredContent;
  assert.ok(status.state_path.includes(".gptwork/state.json"),
    `Expected .gptwork/state.json in state_path, got: ${status.state_path}`);
  assert.equal(status.defaultWorkspaceRoot, workspaceRoot);
}));

test("default state path with explicit defaultWorkspaceRoot creates correct path", withoutGptWorkStatePath(async () => {
  const root = await mkdtemp(join(tmpdir(), "state-custom-root-"));
  const workspaceRoot = join(root, "my-workspace");

  const server = await createGptWorkServer({
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true
  });

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_status", arguments: {} }
  }, { authorization: "Bearer test-token" });

  const status = response.result.structuredContent;
  assert.ok(status.state_path.startsWith(workspaceRoot),
    `Expected state_path to start with ${workspaceRoot}, got: ${status.state_path}`);
  assert.ok(status.state_path.includes(".gptwork/state.json"));
}));

// -----------------------------------------------------------------------
// Migration from old default path
// -----------------------------------------------------------------------

test("old data/state.json migrates to workspace .gptwork/state.json when new file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-migrate-"));
  const workspaceRoot = join(root, "workspace");
  const oldStateDir = await mkdtemp(join(tmpdir(), "old-state-data-"));
  const oldStatePath = join(oldStateDir, "state.json");

  const oldState = { users: [{ id: "user_migrated", name: "Migrated User" }], teams: [], projects: [], workspaces: [], goals: [], conversations: [], memories: [], tasks: [], chatgpt_requests: [], activities: [], audit: [] };
  await mkdir(oldStateDir, { recursive: true });
  await writeFile(oldStatePath, JSON.stringify(oldState), "utf8");

  const store = new StateStore({
    statePath: join(workspaceRoot, ".gptwork/state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    oldDefaultStatePath: oldStatePath
  });

  await store.load();

  assert.equal(store.migrationSource, oldStatePath);
  const loaded = await store.load();
  assert.equal(loaded.users[0].id, "user_migrated");
});

test("migration does not occur when new state file already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-no-migrate-"));
  const workspaceRoot = join(root, "workspace");
  const newStatePath = join(workspaceRoot, ".gptwork/state.json");

  const newState = { users: [{ id: "user_new", name: "New User" }], teams: [], projects: [], workspaces: [], goals: [], conversations: [], memories: [], tasks: [], chatgpt_requests: [], activities: [], audit: [] };
  await mkdir(join(workspaceRoot, ".gptwork"), { recursive: true });
  await writeFile(newStatePath, JSON.stringify(newState), "utf8");

  const oldStateDir = await mkdtemp(join(tmpdir(), "old-state-data-"));
  const oldStatePath = join(oldStateDir, "state.json");
  const oldState = { users: [{ id: "user_old", name: "Old User" }], teams: [], projects: [], workspaces: [], goals: [], conversations: [], memories: [], tasks: [], chatgpt_requests: [], activities: [], audit: [] };
  await writeFile(oldStatePath, JSON.stringify(oldState), "utf8");

  const store = new StateStore({
    statePath: newStatePath,
    defaultWorkspaceRoot: workspaceRoot,
    oldDefaultStatePath: oldStatePath
  });

  await store.load();
  assert.equal(store.migrationSource, null);
  const loaded = await store.load();
  assert.equal(loaded.users[0].id, "user_new");
});

// -----------------------------------------------------------------------
// Explicit GPTWORK_STATE_PATH still wins
// -----------------------------------------------------------------------

test("explicit GPTWORK_STATE_PATH still wins over default", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-explicit-"));
  const explicitPath = join(root, "custom-state.json");
  const workspaceRoot = join(root, "workspace");

  const prev = process.env.GPTWORK_STATE_PATH;
  process.env.GPTWORK_STATE_PATH = explicitPath;

  try {
    const server = await createGptWorkServer({
      defaultWorkspaceRoot: workspaceRoot,
      tokens: ["test-token"],
      requireAuth: true
    });

    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runtime_status", arguments: {} }
    }, { authorization: "Bearer test-token" });

    const status = response.result.structuredContent;
    assert.equal(status.state_path, explicitPath);
    assert.ok(!status.state_path.includes(".gptwork/state.json"),
      `Expected state_path to be ${explicitPath}, got: ${status.state_path}`);
  } finally {
    if (prev !== undefined) {
      process.env.GPTWORK_STATE_PATH = prev;
    } else {
      delete process.env.GPTWORK_STATE_PATH;
    }
  }
});

test("options.statePath wins over everything", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-options-"));
  const optsPath = join(root, "options-state.json");
  const envPath = join(root, "env-state.json");
  const workspaceRoot = join(root, "workspace");

  const prev = process.env.GPTWORK_STATE_PATH;
  process.env.GPTWORK_STATE_PATH = envPath;

  try {
    const server = await createGptWorkServer({
      statePath: optsPath,
      defaultWorkspaceRoot: workspaceRoot,
      tokens: ["test-token"],
      requireAuth: true
    });

    const response = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runtime_status", arguments: {} }
    }, { authorization: "Bearer test-token" });

    const status = response.result.structuredContent;
    assert.equal(status.state_path, optsPath);
  } finally {
    if (prev !== undefined) {
      process.env.GPTWORK_STATE_PATH = prev;
    } else {
      delete process.env.GPTWORK_STATE_PATH;
    }
  }
});

// -----------------------------------------------------------------------
// runtime_status reports state_path_inside_repo
// -----------------------------------------------------------------------

test("runtime_status reports state_path_inside_repo for temp workspace (outside repo)", withoutGptWorkStatePath(async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-status-"));
  const workspaceRoot = join(root, "workspace");

  const server = await createGptWorkServer({
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true
  });

  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_status", arguments: {} }
  }, { authorization: "Bearer test-token" });

  const status = response.result.structuredContent;
  assert.equal(status.state_path_inside_repo, false);
  assert.ok(status.state_path);
}));

// -----------------------------------------------------------------------
// Normal task operations use new state path (not data/state.json)
// -----------------------------------------------------------------------

test("normal task creation/completion does not touch data/state.json", withoutGptWorkStatePath(async () => {
  const root = await mkdtemp(join(tmpdir(), "task-no-dirty-"));
  const workspaceRoot = join(root, "workspace");

  const server = await createGptWorkServer({
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true
  });

  const taskResponse = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "create_task",
      arguments: { title: "Test task", description: "Do work" }
    }
  }, { authorization: "Bearer test-token" });
  assert.equal(taskResponse.error, undefined);

  const completeResponse = await server.handleRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "complete_task",
      arguments: { task_id: taskResponse.result.structuredContent.task.id, summary: "Done" }
    }
  }, { authorization: "Bearer test-token" });
  assert.equal(completeResponse.error, undefined);

  const statusResponse = await server.handleRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "runtime_status", arguments: {} }
  }, { authorization: "Bearer test-token" });

  const status = statusResponse.result.structuredContent;
  assert.ok(status.state_path.includes(".gptwork/state.json"),
    `Expected .gptwork/state.json, got: ${status.state_path}`);
  assert.ok(!status.state_path.includes("data/state.json"),
    `Should not point to old data/state.json, got: ${status.state_path}`);
}));

// -----------------------------------------------------------------------
// Store defaultState creates correct structure
// -----------------------------------------------------------------------

test("StateStore defaultState creates correct structure", async () => {
  const root = await mkdtemp(join(tmpdir(), "default-state-"));
  const store = new StateStore({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace")
  });

  const state = store.defaultState();
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].id, "user_default");
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, "default");
  assert.equal(state.workspaces[0].root, join(root, "workspace"));
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.goals, []);
  assert.deepEqual(state.conversations, []);
  assert.deepEqual(state.memories, []);
});

// -----------------------------------------------------------------------
// P0-2: Concurrent save is serialized and uses atomic write
// -----------------------------------------------------------------------

test("StateStore concurrent saves are serialized and use atomic write", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-concurrent-"));
  const statePath = join(root, "state.json");

  const store = new StateStore({
    statePath,
    defaultWorkspaceRoot: join(root, "workspace")
  });

  const state = await store.load();
  assert.ok(state, "state should load");

  // Trigger multiple concurrent saves
  const savePromises = [];
  for (let i = 0; i < 10; i++) {
    state.tasks.push({ id: "task_" + i, title: "Task " + i });
    savePromises.push(store.save());
    state.tasks.push({ id: "task_extra_" + i, title: "Extra " + i });
    savePromises.push(store.save());
  }

  // Wait for all saves to complete
  await Promise.all(savePromises);

  // After all saves, the file should be valid JSON
  const content = await readFile(statePath, "utf8");
  const parsed = JSON.parse(content);
  assert.ok(parsed, "state file should contain valid JSON after concurrent saves");

  // Temp files should be cleaned up (no .tmp files left)
  const dir = await readdir(dirname(statePath));
  const tmpFiles = dir.filter((f) => f.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0, "no temp files should remain after save: " + JSON.stringify(tmpFiles));
});
