/**
 * workflow-tools-group.test.mjs
 *
 * Tests for GPTWork one-click workflow advance tools.
 * Each test uses a unique workspace root under /tmp to avoid
 * state file collisions from previous runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeFingerprint,
  findExistingProposal,
  findExistingResult,
  generateProposal,
  loadWorkflowState,
  storeManualResult,
  storeProposal,
} from "../src/workflow-state-service.mjs";
import { collectWorkerQueueCounts } from "../src/worker-queue-counts.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique per-import temp root */
let _seq = 0;
function uniqueRoot() {
  _seq++;
  return join(tmpdir(), `gptwork-test-${process.pid}-${_seq}`);
}

function fakeTool(desc, inputSchema, handler) {
  if (desc && typeof desc === "object" && !Array.isArray(desc)) {
    return { description: desc.description, inputSchema: desc.inputSchema, handler: desc.handler };
  }
  return { description: desc, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

const fakeWorkerState = {
  enabled: false, running: false, last_tick_finished_at: null,
  interval_ms: 5000, last_error: null,
};

const fakeCollectWorkerQueueCounts = async () => ({
  assigned: 0, queued: 0, running: 0,
  waiting_for_lock: 0, waiting_for_review: 0,
  completed: 0, failed: 0,
});

function makeDiagnostics(overrides = {}) {
  return {
    workflow_id: "default",
    latest_task: null,
    runtime: { running_commit: "abc123", repo_head: "abc123", remote_head: "abc123" },
    worktree: { dirty: false, dirty_paths: [] },
    repo_locks: { active: 0, stale: 0, details: [] },
    worker: { enabled: true, running: false, health: { phase: "idle" } },
    queue: { assigned: 0, queued: 0, running: 0, waiting_for_lock: 0, waiting_for_review: 0, completed: 0, failed: 0 },
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: "Test task",
    status: "completed",
    assignee: "codex",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T01:00:00Z",
    mode: "builder",
    result: { kind: "codex_executed", summary: "Done", commit: "abc123", tests: "pass", changed_files: ["src/file.js"], completed_at: "2026-01-01T01:00:00Z" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint idempotency
// ---------------------------------------------------------------------------

test("fingerprint: same inputs produce same output", () => {
  const fp1 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "passed", manualNote: "Looks good", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "create_fix_task" });
  const fp2 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "passed", manualNote: "Looks good", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "create_fix_task" });
  assert.equal(fp1, fp2);
});

test("fingerprint: different verdicts produce different output", () => {
  const fp1 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "passed", manualNote: "", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "needs_gptchat_decision" });
  const fp2 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "failed", manualNote: "", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "create_fix_task" });
  assert.notEqual(fp1, fp2);
});

test("fingerprint: different notes produce different output", () => {
  const fp1 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "partial", manualNote: "Almost there", runningCommit: "def456", taskResultCommit: "abc123", nextActionType: "create_fix_task" });
  const fp2 = computeFingerprint({ workflowId: "test", taskId: "task_abc", manualVerdict: "partial", manualNote: "Different note", runningCommit: "def456", taskResultCommit: "abc123", nextActionType: "create_fix_task" });
  assert.notEqual(fp1, fp2);
});

test("fingerprint: different workflow IDs produce different output", () => {
  const fp1 = computeFingerprint({ workflowId: "wf-a", taskId: "task_abc", manualVerdict: "passed", manualNote: "", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "needs_gptchat_decision" });
  const fp2 = computeFingerprint({ workflowId: "wf-b", taskId: "task_abc", manualVerdict: "passed", manualNote: "", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "needs_gptchat_decision" });
  assert.notEqual(fp1, fp2);
});

test("fingerprint: starts with wf_ prefix", () => {
  const fp = computeFingerprint({ workflowId: "default", taskId: "task_abc", manualVerdict: "passed", manualNote: "", runningCommit: "abc123", taskResultCommit: "abc123", nextActionType: "needs_gptchat_decision" });
  assert.ok(fp.startsWith("wf_"));
});

// ---------------------------------------------------------------------------
// generateProposal — decision rules
// ---------------------------------------------------------------------------

test("proposal: completed + passed + no next goal → needs_gptchat_decision", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "completed" }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "needs_gptchat_decision");
  assert.equal(p.needs_gptchat_decision, true);
  assert.equal(p.proposed_next_task, null);
});

test("proposal: completed + failed → create_fix_task", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "completed" }), manualVerdict: "failed", manualNote: "Login breaks" });
  assert.equal(p.next_action, "create_fix_task");
  assert.equal(p.needs_gptchat_decision, false);
  assert.ok(p.proposed_next_task !== null);
  assert.ok(p.proposed_next_task.title.includes("Fix"));
});

test("proposal: completed + partial → create_fix_task (converge)", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "completed" }), manualVerdict: "partial", manualNote: "Edge cases" });
  assert.equal(p.next_action, "create_fix_task");
  assert.equal(p.needs_gptchat_decision, false);
  assert.ok(p.proposed_next_task !== null);
  assert.ok(p.proposed_next_task.title.toLowerCase().includes("converge") || p.proposed_next_task.title.toLowerCase().includes("收敛"));
});

test("proposal: failed task → create_fix_task", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "failed", result: { kind: "codex_failed", summary: "Error" } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "create_fix_task");
  assert.equal(p.needs_gptchat_decision, false);
  assert.ok(p.proposed_next_task !== null);
});

test("proposal: worker running → blocked", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics({ worker: { enabled: true, running: true, health: { phase: "running" } } }), task: makeTask({ status: "completed" }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "blocked");
  assert.equal(p.needs_gptchat_decision, true);
  assert.equal(p.proposed_next_task, null);
});

test("proposal: repo locked → blocked", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics({ repo_locks: { active: 1, stale: 0, details: [{ task_id: "blocker" }] } }), task: makeTask({ status: "completed" }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "blocked");
  assert.equal(p.needs_gptchat_decision, true);
});

test("proposal: dirty worktree → blocked", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics({ worktree: { dirty: true, dirty_paths: ["src/x.js"] } }), task: makeTask({ status: "completed" }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "blocked");
  assert.equal(p.needs_gptchat_decision, true);
});

test("proposal: no task → needs_gptchat_decision", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: null, manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "needs_gptchat_decision");
  assert.equal(p.needs_gptchat_decision, true);
  assert.equal(p.proposed_next_task, null);
});

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

test("loadWorkflowState: returns empty state when file does not exist", () => {
  const s = loadWorkflowState("/__nonexistent__/" + Date.now(), "test-wf");
  assert.equal(s.workflow_id, "test-wf");
  assert.equal(s.current_phase, "task_execution");
  assert.deepEqual(s.manual_results, []);
  assert.deepEqual(s.proposals, []);
});

test("store and find manual result", () => {
  const state = { workflow_id: "test", manual_results: [], proposals: [], created_task_ids: [] };
  storeManualResult(state, { taskId: "task_abc", verdict: "passed", note: "Good", fingerprint: "wf_fp_001" });
  assert.equal(state.manual_results.length, 1);
  const found = findExistingResult(state, "wf_fp_001");
  assert.ok(found !== null);
  assert.equal(found.verdict, "passed");
  assert.equal(findExistingResult(state, "wf_nonexist"), null);
});

test("store and find proposal", () => {
  const state = { workflow_id: "test", manual_results: [], proposals: [], created_task_ids: [] };
  storeProposal(state, { fingerprint: "wf_prop_001", next_action: "create_fix_task", proposed_next_task: { title: "Fix" }, needs_gptchat_decision: false });
  assert.equal(state.proposals.length, 1);
  const found = findExistingProposal(state, "wf_prop_001");
  assert.ok(found !== null);
  assert.equal(found.next_action, "create_fix_task");
  assert.equal(findExistingProposal(state, "wf_nonexist"), null);
});

// ---------------------------------------------------------------------------
// Tool factory / metadata
// ---------------------------------------------------------------------------

test("tool factory exposes correct tool names", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store: { load: async () => ({ tasks: [] }) }, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  assert.deepEqual(Object.keys(tools).sort(), ["workflow_advance", "workflow_apply_proposal", "workflow_record_result", "workflow_status"]);
});

test("tool descriptions are populated", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store: { load: async () => ({ tasks: [] }) }, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  assert.ok(tools.workflow_status.description.length > 10);
  assert.ok(tools.workflow_record_result.description.length > 10);
  assert.ok(tools.workflow_advance.description.length > 10);
  assert.ok(tools.workflow_apply_proposal.description.length > 10);
});

// ---------------------------------------------------------------------------
// workflow_status — read-only
// ---------------------------------------------------------------------------

test("workflow_status returns state without mutation", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  let loadCount = 0;
  const store = { load: async () => { loadCount++; return { tasks: [{ id: "task_exist", title: "Existing", status: "completed", assignee: "codex", created_at: "2026-01-01", updated_at: "2026-01-01", result: { summary: "Done", commit: "abc123" } }] }; } };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_status.handler({ task_id: "latest" });
  assert.ok(result.workflow_id);
  assert.ok(result.latest_task);
  assert.ok(result.status_checks);
});

// ---------------------------------------------------------------------------
// workflow_record_result
// ---------------------------------------------------------------------------

test("workflow_record_result stores and reads back verdict", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const root = uniqueRoot();
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: root }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_record_result.handler({ task_id: taskState.id, verdict: "partial", note: "Mostly works" });
  assert.equal(result.recorded.verdict, "partial");
  assert.equal(result.recorded.note, "Mostly works");
  assert.ok(result.fingerprint.startsWith("wf_"));

  // Verify persistence by reloading
  const state = loadWorkflowState(root, "default");
  assert.equal(state.manual_results.length, 1);
  assert.equal(state.manual_results[0].verdict, "partial");
});

// ---------------------------------------------------------------------------
// workflow_advance(mode="propose") — decision rules
// ---------------------------------------------------------------------------

test("workflow_advance propose: completed + failed → fix proposal, no task created", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, manual_verdict: "failed", manual_note: "Still broken", mode: "propose" });
  assert.equal(result.proposal.next_action, "create_fix_task");
  assert.equal(result.proposal.needs_gptchat_decision, false);
  assert.ok(result.proposal.proposed_next_task.title.includes("Fix"));
  assert.equal(result.created_task_id, null);
});

test("workflow_advance propose: completed + partial → converge proposal", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, manual_verdict: "partial", manual_note: "Edge cases remain", mode: "propose" });
  assert.equal(result.proposal.next_action, "create_fix_task");
  assert.equal(result.proposal.needs_gptchat_decision, false);
  assert.ok(result.proposal.proposed_next_task.title.toLowerCase().includes("converge") || result.proposal.proposed_next_task.title.includes("收敛"));
  assert.equal(result.created_task_id, null);
});

test("workflow_advance propose: completed + passed → needs_gptchat_decision", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, manual_verdict: "passed", manual_note: "All good", mode: "propose" });
  assert.equal(result.proposal.next_action, "needs_gptchat_decision");
  assert.equal(result.proposal.needs_gptchat_decision, true);
  assert.equal(result.proposal.proposed_next_task, null);
  assert.equal(result.created_task_id, null);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("workflow_advance idempotent: same inputs return existing proposal", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const root = uniqueRoot();
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: root }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });

  const r1 = await tools.workflow_advance.handler({ workflow_id: "idem", task_id: taskState.id, manual_verdict: "failed", manual_note: "Has bugs", mode: "propose" });
  assert.equal(r1.proposal.next_action, "create_fix_task");
  assert.equal(r1.duplicate, undefined);

  const r2 = await tools.workflow_advance.handler({ workflow_id: "idem", task_id: taskState.id, manual_verdict: "failed", manual_note: "Has bugs", mode: "propose" });
  assert.ok(r2.duplicate === true);
});

// ---------------------------------------------------------------------------
// Blocked state
// ---------------------------------------------------------------------------

test("workflow_advance propose: worker running → blocked", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask();
  const store = { load: async () => ({ tasks: [taskState] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: { ...fakeWorkerState, running: true }, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, manual_verdict: "passed", manual_note: "", mode: "propose" });
  assert.equal(result.proposal.next_action, "blocked");
  assert.equal(result.proposal.needs_gptchat_decision, true);
  assert.equal(result.created_task_id, null);
});

// ---------------------------------------------------------------------------
// workflow_apply_proposal
// ---------------------------------------------------------------------------

test("workflow_apply_proposal: throws on missing proposal", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const store = { load: async () => ({ tasks: [] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  await assert.rejects(() => tools.workflow_apply_proposal.handler({ workflow_id: "nonexist", proposal_id: "wf_nonexist" }), /Proposal not found/);
});

// ---------------------------------------------------------------------------
// waiting_for_review auto-accept tests
// ---------------------------------------------------------------------------

test("proposal: waiting_for_review + valid result → auto_accepted", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "auto_accepted");
  assert.equal(p.needs_gptchat_decision, false);
  assert.equal(p.proposed_next_task, null);
  assert.equal(p.auto_accepted, true);
});

test("proposal: waiting_for_review + valid result + remote_head null → auto_accepted", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics({ runtime: { running_commit: "abc123", repo_head: "abc123", remote_head: null } }), task: makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "auto_accepted");
  assert.equal(p.needs_gptchat_decision, false);
  assert.equal(p.auto_accepted, true);
});

test("proposal: waiting_for_review + no result → needs_gptchat_decision", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "waiting_for_review", result: null }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "needs_gptchat_decision");
  assert.equal(p.needs_gptchat_decision, true);
});

test("proposal: waiting_for_review + tests_missing → needs_gptchat_decision", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", tests: null, changed_files: ["src/file.js"] } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "needs_gptchat_decision");
  assert.equal(p.needs_gptchat_decision, true);
});

test("proposal: waiting_for_review + commit_missing (has changed_files) → needs_gptchat_decision", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics(), task: makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: null, tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "needs_gptchat_decision");
  assert.equal(p.needs_gptchat_decision, true);
});

test("proposal: waiting_for_review + blocked by worker → blocked", () => {
  const p = generateProposal({ diagnostics: makeDiagnostics({ worker: { enabled: true, running: true, health: { phase: "running" } } }), task: makeTask({ status: "waiting_for_review", result: { status: "completed", summary: "Done", commit: "abc123", tests: "pass" } }), manualVerdict: "passed", manualNote: "" });
  assert.equal(p.next_action, "blocked");
  assert.equal(p.needs_gptchat_decision, true);
});

test("workflow_advance propose: waiting_for_review + valid → auto_accepted proposal", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } });
  const store = { load: async () => ({ tasks: [taskState], goals: [], activities: [] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, mode: "propose" });
  assert.equal(result.proposal.next_action, "auto_accepted");
  assert.equal(result.proposal.needs_gptchat_decision, false);
  assert.equal(result.proposal.auto_accepted, true);
  assert.equal(result.created_task_id, null);
});

test("workflow_status: waiting_for_review + valid → triggers auto-accept", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } });
  let saveCalled = false;
  const store = { load: async () => {
    const tasks = [{ ...taskState, ...(saveCalled ? { status: "completed" } : {}) }];
    const goals = [];
    return { tasks, goals, activities: [] };
  }, save: async () => { saveCalled = true; } };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_status.handler({ task_id: taskState.id });
  assert.ok(result.workflow_id);
  assert.ok(result.latest_task);
  assert.ok(saveCalled);
});

test("workflow_advance apply: waiting_for_review + accepted reviewer decision auto-accepts", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  let taskState = makeTask({
    status: "waiting_for_review",
    goal_id: "goal_accept",
    result: {
      status: "completed",
      kind: "codex_executed",
      summary: "Done",
      commit: "abc123",
      remote_head: null,
      tests: "npm test: passed 15/15",
      changed_files: ["src/file.js"],
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
    },
  });
  const goal = { id: "goal_accept", task_id: taskState.id, status: "assigned" };
  const store = {
    load: async () => ({ tasks: [taskState], goals: [goal], activities: [] }),
    save: async () => {},
  };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, mode: "apply" });

  assert.equal(result.needs_gptchat_decision, false);
  assert.equal(result.auto_accepted, true);
  assert.equal(result.proposal.next_action, "auto_accepted");
  assert.equal(taskState.status, "completed");
  assert.equal(taskState.result.auto_accepted, true);
});

test("proposal: waiting_for_review + only minor and followup findings auto-accepts with next tasks", () => {
  const p = generateProposal({
    diagnostics: makeDiagnostics(),
    task: makeTask({
      status: "waiting_for_review",
      result: {
        status: "completed",
        kind: "codex_executed",
        summary: "Done",
        commit: "abc123",
        remote_head: null,
        tests: "npm test: passed 15/15",
        changed_files: ["src/file.js"],
        reviewer_decision: { status: "needs_fix", passed: false },
        acceptance_findings: [
          { severity: "minor", code: "docs_gap", message: "Document later" },
          { severity: "followup", code: "cleanup", message: "Cleanup later" },
        ],
      },
    }),
    manualVerdict: "passed",
    manualNote: "",
  });

  assert.equal(p.next_action, "auto_accepted");
  assert.equal(p.needs_gptchat_decision, false);
  assert.equal(p.acceptance.next_tasks.length, 2);
});

test("workflow_advance apply: blocker finding returns automatic repair proposal", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask({
    status: "waiting_for_review",
    goal_id: "goal_repair",
    result: {
      status: "completed",
      kind: "codex_executed",
      summary: "Done",
      commit: "abc123",
      tests: "npm test: passed 15/15",
      changed_files: ["src/file.js"],
      reviewer_decision: { status: "needs_fix", passed: false },
      acceptance_findings: [{ severity: "blocker", code: "dirty_worktree_after_codex", message: "Worktree dirty" }],
    },
  });
  const store = {
    load: async () => ({ tasks: [taskState], goals: [{ id: "goal_repair", task_id: taskState.id, status: "assigned", title: "Original goal" }], activities: [] }),
    save: async () => {},
  };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts: fakeCollectWorkerQueueCounts });
  const result = await tools.workflow_advance.handler({ task_id: taskState.id, mode: "apply" });

  assert.equal(result.proposal.next_action, "create_repair_task");
  assert.equal(result.proposal.needs_gptchat_decision, false);
  assert.ok(result.proposal.proposed_next_task.description.includes("dirty_worktree_after_codex"));
  assert.ok(result.created_task_id || result.proposal.repair_proposal);
});

test("proposal: waiting_for_review + missing reviewer decision derives accepted decision from policy", () => {
  const p = generateProposal({
    diagnostics: makeDiagnostics({ runtime: { running_commit: "abc123", repo_head: "abc123", remote_head: null } }),
    task: makeTask({ status: "waiting_for_review", result: { status: "completed", kind: "codex_executed", summary: "Done", commit: "abc123", remote_head: null, tests: "npm test: passed 15/15", changed_files: ["src/file.js"] } }),
    manualVerdict: "passed",
    manualNote: "",
  });

  assert.equal(p.next_action, "auto_accepted");
  assert.equal(p.acceptance.reviewer_decision.status, "accepted");
  assert.equal(p.acceptance.reviewer_decision.passed, true);
});

test("workflow_status exposes reviewer decision and actionable review count", async () => {
  const mod = await import("../src/tool-groups/workflow-tools-group.mjs");
  const taskState = makeTask({
    status: "waiting_for_review",
    result: {
      status: "completed",
      kind: "codex_executed",
      summary: "Done",
      commit: "abc123",
      tests: "npm test: passed 15/15",
      changed_files: ["src/file.js"],
      reviewer_decision: { status: "accepted", passed: true },
      acceptance_findings: [],
    },
  });
  const resolvedReview = makeTask({ status: "waiting_for_review", result: { resolved_by_task_id: "task_fix" } });
  const store = { load: async () => ({ tasks: [taskState, resolvedReview], goals: [], activities: [] }), save: async () => {} };
  const tools = mod.createWorkflowToolsGroup({ tool: fakeTool, schema: fakeSchema, store, config: { defaultWorkspaceRoot: uniqueRoot() }, workerState: fakeWorkerState, collectWorkerQueueCounts });
  const result = await tools.workflow_status.handler({ task_id: taskState.id });

  assert.equal(result.latest_task.reviewer_decision.status, "accepted");
  assert.equal(result.queue.actionable_review, 0);
});
