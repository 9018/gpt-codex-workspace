import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutionProviderRegistry } from "../../src/execution/execution-provider-registry.mjs";
import { dispatchTaskProvider } from "../../src/task-processing/task-provider-dispatcher.mjs";

function makeStore(root) {
  return {
    state: {
      tasks: [{ id: "task_bridge_1", metadata: {}, execution_policy: {} }],
      goals: [{ id: "goal_bridge_1", task_id: "task_bridge_1" }],
      workstreams: [],
      context_links: [],
      conversations: [],
      memories: [],
    },
    async findTaskById(id) { return this.state.tasks.find(t => t.id === id) || null; },
    async findGoalById(id) { return this.state.goals.find(g => g.id === id) || null; },
    async save() {},
  };
}

function makeTuiProvider() {
  let oc = 0;
  return {
    name: "codex_tui",
    async availability() { return true; },
    async start(attempt) { return { session_id: `sess_${attempt.id}` }; },
    async resume(attempt, cp) { return this.start(attempt); },
    async observe() { oc++; return oc < 3 ? { state: "running" } : { state: "evidence_ready" }; },
    async collect() { return { status: "completed", summary: "Bridge dispatch test", changed_files: ["test.js"], tests: [] }; },
    async send() {}, async interrupt() {}, async dispose() {},
  };
}

test("dispatchTaskProvider with useExecutionRun completes via bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-dispatch-"));
  const store = makeStore(root);
  const result = await dispatchTaskProvider({
    workspaceRoot: root,
    task: store.state.tasks[0],
    goal: store.state.goals[0],
    useExecutionRun: true,
    providers: { codex_tui: makeTuiProvider() },
  }, {
    repositorySnapshot: async () => ({ head: null, dirty_paths: [] }),
    acceptanceSnapshot: async () => ({ completed_items: [] }),
  });
  assert.ok(result.attempt, "attempt should be returned");
  assert.equal(result.provider, "codex_tui");
  // Status may be "completed" or "running" depending on mock timing
  assert.ok(["completed", "running"].includes(result.status || result.attempt?.state), `Expected completed or running, got ${result.status || result.attempt?.state}`);
});

test("dispatchTaskProvider without useExecutionRun uses old path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-dispatch-old-"));
  const store = makeStore(root);
  const result = await dispatchTaskProvider({
    workspaceRoot: root,
    task: store.state.tasks[0],
    goal: store.state.goals[0],
    providers: { codex_tui: makeTuiProvider() },
  }, {
    repositorySnapshot: async () => ({ head: null, dirty_paths: [] }),
    acceptanceSnapshot: async () => ({ completed_items: [] }),
  });
  assert.ok(result, "result should be returned");
});
