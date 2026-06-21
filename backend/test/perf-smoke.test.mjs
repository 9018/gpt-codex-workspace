import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Perf smoke tests (P2.3).
 *
 * These tests verify basic performance characteristics of hot-path operations.
 * They are NOT benchmark tests — they check that operations complete within
 * reasonable bounds and don't regress.
 */

const PERF_WARN_MS = 2000;  // 2s max for most operations
const PERF_BULK_MS = 5000;   // 5s max for bulk operations

describe("perf-smoke", { concurrency: 1 }, () => {
  let store = null;
  let config = null;

  before(async () => {
    // Create a minimal test store
    const { StateStore } = await import("../src/state-store.mjs");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-perf-test-"));
    const statePath = join(tmpDir, "state.json");
    
    // Create initial state with no tasks
    const initialState = {
      users: [{ id: "user_default", name: "Default User" }],
      teams: [{ id: "team_default", name: "Default Team" }],
      projects: [{ id: "default", team_id: "team_default", name: "Default Project", description: "Default", default_workspace_id: "hosted-default", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      workspaces: [{ id: "hosted-default", project_id: "default", name: "Default", type: "hosted", root: tmpDir, default: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      goals: [],
      conversations: [],
      memories: [],
      tasks: [],
      chatgpt_requests: [],
      activities: [],
      audit: []
    };
    await writeFile(statePath, JSON.stringify(initialState, null, 2));

    store = new StateStore({ statePath, defaultWorkspaceRoot: tmpDir });
    config = { defaultWorkspaceRoot: tmpDir };
    await store.load();
  });

  it("collectWorkerQueueCounts with many tasks", async () => {
    const state = await store.load();
    const { randomUUID } = await import("node:crypto");
    const now = new Date().toISOString();
    
    // Add 1000 codex-assigned tasks with various statuses
    for (let i = 0; i < 1000; i++) {
      const statuses = ["assigned", "queued", "running", "waiting_for_lock", "completed", "failed"];
      state.tasks.push({
        id: `task_perf_${randomUUID()}`,
        project_id: "default",
        workspace_id: "hosted-default",
        title: `Perf task ${i}`,
        assignee: "codex",
        status: statuses[i % statuses.length],
        logs: [],
        artifacts: [],
        result: null,
        created_at: now,
        updated_at: now
      });
    }
    await store.save();

    // Measure collectWorkerQueueCounts
    const { collectWorkerQueueCounts } = await import("../src/worker-queue-counts.mjs");
    const startTime = Date.now();
    const counts = await collectWorkerQueueCounts(store);
    const elapsed = Date.now() - startTime;

    console.log(`  collectWorkerQueueCounts(1000 tasks): ${elapsed}ms`);
    assert.ok(elapsed < PERF_BULK_MS, `collectWorkerQueueCounts too slow: ${elapsed}ms`);
    assert.equal(typeof counts.assigned, "number");
    assert.ok(counts.assigned > 0 || counts.queued > 0 || counts.completed > 0, "should have some counts");
  });

  it("indexed lookups with many tasks", async () => {
    const state = await store.load();
    const { randomUUID } = await import("node:crypto");
    
    // Measures performance of indexed vs array-based lookups
    const startTime = Date.now();
    const lookupId = state.tasks.length > 500 ? state.tasks[500].id : state.tasks[0].id;
    
    // Indexed lookup (O(1))
    const indexedResult = await store.findTaskById(lookupId);
    const indexedElapsed = Date.now() - startTime;

    // Array-based lookup (O(n))
    const arrayStart = Date.now();
    const arrayResult = state.tasks.find(t => t.id === lookupId);
    const arrayElapsed = Date.now() - arrayStart;

    console.log(`  indexed lookup: ${indexedElapsed}ms, array lookup: ${arrayElapsed}ms`);
    assert.ok(indexedResult, "indexed lookup should find task");
    assert.equal(indexedResult?.id, lookupId);
    assert.equal(arrayResult?.id, lookupId);
    
    // Indexed lookup should not be catastrophically slower (allow 500ms for cold cache)
    assert.ok(indexedElapsed < 500, `indexed lookup too slow: ${indexedElapsed}ms`);
  });

  it("state load with large state", async () => {
    // Add 500 more tasks to stress test
    const state = await store.load();
    const { randomUUID } = await import("node:crypto");
    const now = new Date().toISOString();
    
    for (let i = 0; i < 500; i++) {
      state.tasks.push({
        id: `task_perf_large_${randomUUID()}`,
        project_id: "default",
        workspace_id: "hosted-default",
        title: `Large state task ${i}`,
        assignee: "codex",
        status: i % 2 === 0 ? "assigned" : "completed",
        logs: [],
        artifacts: [],
        result: null,
        created_at: now,
        updated_at: now
      });
    }
    await store.save();

    // Reload and measure
    const startTime = Date.now();
    const { StateStore } = await import("../src/state-store.mjs");
    
    // Create fresh store to force disk load
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir2 = await mkdtemp(join(tmpdir(), "gptwork-perf-load-"));
    const statePath2 = join(tmpDir2, "state.json");
    
    // Copy current state to new location
    await writeFile(statePath2, JSON.stringify(state, null, 2));
    
    const store2 = new StateStore({ statePath: statePath2, defaultWorkspaceRoot: tmpDir2 });
    await store2.load();
    const loadElapsed = Date.now() - startTime;
    
    console.log(`  state load with ${state.tasks.length} tasks: ${loadElapsed}ms`);
    assert.ok(loadElapsed < PERF_BULK_MS, `state load too slow: ${loadElapsed}ms`);
    assert.ok(store2.state.tasks.length >= 1500, "should have loaded all tasks");
  });

  it("findTaskById with indexed store", { timeout: 10000 }, async () => {
    // Reload the main store to rebuild indexes
    await store.load();
    const state = store.state;
    const totalTasks = state.tasks.length;
    
    // Measure find by id (indexed)
    const startTime = Date.now();
    let found = 0;
    for (const task of state.tasks) {
      const t = await store.findTaskById(task.id);
      if (t) found++;
    }
    const elapsed = Date.now() - startTime;
    
    console.log(`  findTaskById x${totalTasks} (indexed): ${elapsed}ms, found ${found}/${totalTasks}`);
    assert.equal(found, totalTasks, "should find all tasks by id");
  });

  after(async () => {
    // Clean up temp files
    const { rm } = await import("node:fs/promises");
    if (store?.statePath) {
      try { await rm(store.statePath, { force: true }); } catch {}
    }
  });
});
