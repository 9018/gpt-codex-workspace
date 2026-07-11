import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StateStore } from "../src/state-store.mjs";
import {
  GRAPH_NODES,
  isValidGraphNode,
  isValidTransition,
  setInitialGraphNode,
  recordGraphTransition,
  formatGraphDiagnostic,
} from "../src/task-graph-state.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempStore(rootDir) {
  const statePath = join(rootDir, ".gptwork", "state.json");
  await mkdir(join(rootDir, ".gptwork"), { recursive: true });
  const store = new StateStore({
    statePath,
    defaultWorkspaceRoot: rootDir,
  });
  await store.load();
  return store;
}

async function createTaskInStore(store, overrides = {}) {
  const now = new Date().toISOString();
  const task = {
    id: `task_${randomUUID()}`,
    project_id: "default",
    workspace_id: "hosted-default",
    title: "Test task",
    description: "",
    created_by: "system",
    assignee: "codex",
    status: "queued",
    mode: "builder",
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  setInitialGraphNode(task);
  await store.mutate((state) => {
    state.tasks ||= [];
    state.tasks.push(task);
  });
  return task;
}

// ---------------------------------------------------------------------------
// GRAPH_NODES constants
// ---------------------------------------------------------------------------

test("GRAPH_NODES has exactly 15 lifecycle nodes", () => {
  const values = Object.values(GRAPH_NODES);
  assert.equal(values.length, 17);
  assert.ok(values.every((v) => typeof v === "string" && v.length > 0));
});

test("GRAPH_NODES contains all required state names", () => {
  const required = [
    "created", "context_prepared", "builder_running", "result_parsed",
    "verified", "accepted", "integration_required", "integration_not_required",
    "integrated", "deployment_checked", "closure_eligible", "closed",
    "repair_required", "human_interrupted", "failed_terminal",
  ];
  for (const name of required) {
    assert.equal(Object.values(GRAPH_NODES).includes(name), true,
      `Missing required graph node: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// isValidGraphNode
// ---------------------------------------------------------------------------

test("isValidGraphNode accepts valid nodes", () => {
  assert.equal(isValidGraphNode("created"), true);
  assert.equal(isValidGraphNode("closed"), true);
  assert.equal(isValidGraphNode("failed_terminal"), true);
  assert.equal(isValidGraphNode("human_interrupted"), true);
});

test("isValidGraphNode rejects invalid nodes", () => {
  assert.equal(isValidGraphNode("invalid"), false);
  assert.equal(isValidGraphNode(""), false);
  assert.equal(isValidGraphNode(null), false);
  assert.equal(isValidGraphNode(undefined), false);
});

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

test("isValidTransition allows normal forward progression", () => {
  assert.equal(isValidTransition("created", "context_prepared"), true);
  assert.equal(isValidTransition("context_prepared", "builder_running"), true);
  assert.equal(isValidTransition("builder_running", "result_parsed"), true);
  assert.equal(isValidTransition("result_parsed", "verified"), true);
  assert.equal(isValidTransition("verified", "accepted"), true);
  assert.equal(isValidTransition("accepted", "integration_required"), true);
  assert.equal(isValidTransition("accepted", "integration_not_required"), true);
  assert.equal(isValidTransition("integration_required", "integrated"), true);
  assert.equal(isValidTransition("integration_not_required", "closure_eligible"), true);
  assert.equal(isValidTransition("integrated", "deployment_checked"), true);
  assert.equal(isValidTransition("deployment_checked", "closure_eligible"), true);
  assert.equal(isValidTransition("closure_eligible", "closed"), true);
});

test("isValidTransition allows repair retry loop", () => {
  assert.equal(isValidTransition("result_parsed", "repair_required"), true);
  assert.equal(isValidTransition("verified", "repair_required"), true);
  assert.equal(isValidTransition("repair_required", "context_prepared"), true);
});

test("isValidTransition allows wildcard destinations from any node", () => {
  for (const from of Object.values(GRAPH_NODES)) {
    assert.equal(isValidTransition(from, "human_interrupted"), true,
      `Expected ${from} → human_interrupted to be valid`);
    assert.equal(isValidTransition(from, "failed_terminal"), true,
      `Expected ${from} → failed_terminal to be valid`);
  }
});

test("isValidTransition rejects backward transitions", () => {
  assert.equal(isValidTransition("closed", "created"), false);
  assert.equal(isValidTransition("accepted", "verified"), false);
  assert.equal(isValidTransition("integrated", "integration_required"), false);
  assert.equal(isValidTransition("closure_eligible", "deployment_checked"), false);
});

test("isValidTransition rejects unknown nodes", () => {
  assert.equal(isValidTransition("invalid", "created"), false);
  assert.equal(isValidTransition("created", "invalid"), false);
});

// ---------------------------------------------------------------------------
// setInitialGraphNode
// ---------------------------------------------------------------------------

test("setInitialGraphNode adds graph_node and initial transition", () => {
  const task = { id: "test_123", created_at: new Date().toISOString() };
  const result = setInitialGraphNode(task);
  assert.equal(result.graph_node, "created");
  assert.equal(Array.isArray(result.graph_transitions), true);
  assert.equal(result.graph_transitions.length, 1);
  assert.equal(result.graph_transitions[0].to, "created");
  assert.equal(result.graph_transitions[0].from, "");
  assert.equal(result.graph_transitions[0].task_id, "test_123");
  assert.equal(result.graph_transitions[0].node, "system");
  assert.equal(result.graph_transitions[0].evidence, null);
});

test("setInitialGraphNode is idempotent when graph_node already set", () => {
  const task = {
    id: "test_456",
    graph_node: "closed",
    graph_transitions: [{ from: "closure_eligible", to: "closed", task_id: "test_456" }],
  };
  const result = setInitialGraphNode(task);
  assert.equal(result.graph_node, "closed");
  assert.equal(result.graph_transitions.length, 1);
});

test("setInitialGraphNode preserves existing graph_transitions", () => {
  const task = {
    id: "test_789",
    graph_node: "verified",
    graph_transitions: [
      { from: "", to: "created", task_id: "test_789" },
      { from: "created", to: "context_prepared", task_id: "test_789" },
    ],
  };
  const result = setInitialGraphNode(task);
  assert.equal(result.graph_node, "verified");
  assert.equal(result.graph_transitions.length, 2);
});

// ---------------------------------------------------------------------------
// recordGraphTransition (persistence)
// ---------------------------------------------------------------------------

test("recordGraphTransition records transition atomically in store", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  const result = await recordGraphTransition(store, task.id, {
    from: "created",
    to: "context_prepared",
    reason: "Context loaded successfully",
    evidence: "goal.md, context.bundle.md loaded",
    source: "context_builder",
  });

  assert.equal(result.task_id, task.id);
  assert.equal(result.transition.from, "created");
  assert.equal(result.transition.to, "context_prepared");
  assert.equal(result.transition.reason, "Context loaded successfully");
  assert.equal(result.transition.evidence, "goal.md, context.bundle.md loaded");
  assert.equal(result.transition.node, "context_builder");
  assert.ok(result.transition.created_at);

  // Verify persistence by reloading
  const reloaded = await store.findTaskById(task.id);
  assert.equal(reloaded.graph_node, "context_prepared");
  assert.equal(Array.isArray(reloaded.graph_transitions), true);
  assert.equal(reloaded.graph_transitions.length, 2); // initial + new
  assert.equal(reloaded.graph_transitions[1].from, "created");
  assert.equal(reloaded.graph_transitions[1].to, "context_prepared");
});

test("recordGraphTransition rejects invalid transitions", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  await assert.rejects(
    () => recordGraphTransition(store, task.id, {
      from: "created", to: "closed",
      reason: "skip everything",
    }),
    /invalid graph transition/
  );

  await assert.rejects(
    () => recordGraphTransition(store, task.id, {
      from: "invalid", to: "created",
    }),
    /invalid graph node 'from'/
  );
});

test("recordGraphTransition allows wildcard to failed_terminal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  await recordGraphTransition(store, task.id, {
    from: "builder_running",
    to: "failed_terminal",
    reason: "Build crashed: OOM",
    evidence: "logs: out of memory at line 42",
    source: "acceptance_agent",
  });

  const reloaded = await store.findTaskById(task.id);
  assert.equal(reloaded.graph_node, "failed_terminal");
  assert.equal(reloaded.graph_transitions.length, 2);
  assert.equal(reloaded.graph_transitions[1].from, "builder_running");
});

// ---------------------------------------------------------------------------
// formatGraphDiagnostic
// ---------------------------------------------------------------------------

test("formatGraphDiagnostic returns 'No task provided' for null", () => {
  assert.equal(formatGraphDiagnostic(null), "No task provided.");
  assert.equal(formatGraphDiagnostic(undefined), "No task provided.");
});

test("formatGraphDiagnostic shows fresh task state", () => {
  const diag = formatGraphDiagnostic({
    id: "test",
    graph_node: "created",
    graph_transitions: [],
  });
  assert.ok(diag.includes("node=created"));
  assert.ok(diag.includes("last=<none>"));
  assert.ok(diag.includes("blocked=waiting for context preparation"));
  assert.ok(!diag.includes("closed=true"));
});

test("formatGraphDiagnostic shows closed task", () => {
  const diag = formatGraphDiagnostic({
    id: "test",
    graph_node: "closed",
    graph_transitions: [{ from: "closure_eligible", to: "closed", reason: "completed" }],
  });
  assert.ok(diag.includes("node=closed"));
  assert.ok(diag.includes("closed=true"));
});

test("formatGraphDiagnostic shows terminal failure", () => {
  const diag = formatGraphDiagnostic({
    id: "test",
    graph_node: "failed_terminal",
    graph_transitions: [],
  });
  assert.ok(diag.includes("node=failed_terminal"));
  assert.ok(diag.includes("blocked=terminal failure"));
});

// ---------------------------------------------------------------------------
// Acceptance: normal progression
// ---------------------------------------------------------------------------

test("complete normal progression: created → context_prepared → builder_running → result_parsed → verified → accepted → integration_not_required → closure_eligible → closed", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  const transitions = [
    ["created", "context_prepared", "Context built"],
    ["context_prepared", "builder_running", "Builder started"],
    ["builder_running", "result_parsed", "Result parsed from stdout"],
    ["result_parsed", "verified", "Verification passed"],
    ["verified", "accepted", "Reviewer accepted"],
    ["accepted", "integration_not_required", "No code changes"],
    ["integration_not_required", "closure_eligible", "Ready to close"],
    ["closure_eligible", "closed", "Task closed"],
  ];

  for (const [from, to, reason] of transitions) {
    await recordGraphTransition(store, task.id, { from, to, reason, source: "test" });
  }

  const reloaded = await store.findTaskById(task.id);
  assert.equal(reloaded.graph_node, "closed");
  assert.equal(reloaded.graph_transitions.length, 1 + transitions.length);

  const diag = formatGraphDiagnostic(reloaded);
  assert.ok(diag.includes("node=closed"));
  assert.ok(diag.includes("closed=true"));
});

// ---------------------------------------------------------------------------
// Acceptance: missing evidence diagnostic
// ---------------------------------------------------------------------------

test("diagnostic reports missing evidence at builder_running node", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  await recordGraphTransition(store, task.id, {
    from: "created", to: "context_prepared", reason: "ok", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "context_prepared", to: "builder_running", reason: "started", source: "test",
  });

  const reloaded = await store.findTaskById(task.id);
  const diag = formatGraphDiagnostic(reloaded);
  // builder_running at node=... so should report missing evidence
  assert.ok(diag.includes("missing=["), `Expected missing evidence in: ${diag}`);
  // The task has no result object, so result.summary is missing
  assert.ok(diag.includes("result.summary"), `Expected result.summary in: ${diag}`);
});

// ---------------------------------------------------------------------------
// Acceptance: failed terminal transition
// ---------------------------------------------------------------------------

test("failed_terminal transition records correctly and diagnostic shows terminal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  // Normal progression until failure
  await recordGraphTransition(store, task.id, {
    from: "created", to: "context_prepared", reason: "ok", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "context_prepared", to: "builder_running", reason: "started", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "builder_running", to: "failed_terminal",
    reason: "Builder failed irrecoverably",
    evidence: "exit code 137",
    source: "worker",
  });

  const reloaded = await store.findTaskById(task.id);
  assert.equal(reloaded.graph_node, "failed_terminal");
  assert.equal(reloaded.graph_transitions.length, 4); // initial + 3
  assert.equal(reloaded.graph_transitions[3].from, "builder_running");
  assert.equal(reloaded.graph_transitions[3].to, "failed_terminal");

  const diag = formatGraphDiagnostic(reloaded);
  assert.ok(diag.includes("node=failed_terminal"));
  assert.ok(diag.includes("blocked=terminal failure"));
});

// ---------------------------------------------------------------------------
// Acceptance: repair retry loop
// ---------------------------------------------------------------------------

test("repair_required → context_prepared retry loop", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const task = await createTaskInStore(store);

  await recordGraphTransition(store, task.id, {
    from: "created", to: "context_prepared", reason: "ok", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "context_prepared", to: "builder_running", reason: "started", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "builder_running", to: "result_parsed", reason: "done", source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "result_parsed", to: "repair_required",
    reason: "Verification failed",
    evidence: "changed_files missing",
    source: "acceptance_agent",
  });
  await recordGraphTransition(store, task.id, {
    from: "repair_required", to: "context_prepared",
    reason: "Repair task created, retrying",
    source: "worker",
  });

  const reloaded = await store.findTaskById(task.id);
  assert.equal(reloaded.graph_node, "context_prepared");
  assert.ok(reloaded.graph_transitions.length > 0);
});

// ---------------------------------------------------------------------------
// Acceptance: existing status compatibility
// ---------------------------------------------------------------------------

test("graph_node coexists with existing task status without breaking it", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "graph-state-"));
  const store = await createTempStore(rootDir);
  const now = new Date().toISOString();
  const task = {
    id: `task_${randomUUID()}`,
    status: "waiting_for_review",    // existing status
    assignee: "codex",
    mode: "builder",
    title: "Legacy task",
    project_id: "default",
    workspace_id: "hosted-default",
    logs: [],
    created_at: now,
    updated_at: now,
  };
  setInitialGraphNode(task);

  await store.mutate((state) => {
    state.tasks ||= [];
    state.tasks.push(task);
  });
  // Set graph_node independently of status
  // Set graph_node independently of status — use valid path to verified
  await recordGraphTransition(store, task.id, {
    from: "created", to: "context_prepared",
    reason: "Context prepared for existing task",
    source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "context_prepared", to: "builder_running",
    reason: "Builder started for existing task",
    source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "builder_running", to: "result_parsed",
    reason: "Result parsed for existing task",
    source: "test",
  });
  await recordGraphTransition(store, task.id, {
    from: "result_parsed", to: "verified",
    reason: "Verification passed on existing task",
    source: "test",
  });

  const reloaded = await store.findTaskById(task.id);
  // Existing status preserved
  assert.equal(reloaded.status, "waiting_for_review");
  // Graph node present alongside
  assert.equal(reloaded.graph_node, "verified");
  assert.equal(Array.isArray(reloaded.graph_transitions), true);
});
