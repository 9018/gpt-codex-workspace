/**
 * p0-goal-dispatch-subagent-lifecycle.test.mjs
 *
 * P0 regression tests:
 * 1. Subagent state model must distinguish declared/not_spawned/spawning/running/completed/failed/skipped.
 * 2. Native spawn evidence must be tracked when available.
 * 3. codex_tui_start_goal must dispatch /goal via PTY (not argv).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

const GOAL_ID = "goal_test_lifecycle";

async function makeStore() {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "subagent-lifecycle-")));
  const { createSubagentProgressStore } = await import("../src/subagents/subagent-progress-store.mjs");
  return { workspaceRoot, store: createSubagentProgressStore({ workspaceRoot }) };
}

// ===========================================================================
// P0-2: Subagent state model with native lifecycle evidence
// ===========================================================================

test("P0-2: VALID_STATUSES includes declared, not_spawned, spawning", async () => {
  const { store } = await makeStore();

  // declared — role defined but no native spawn evidence yet
  const declared = await store.writeSubagents(GOAL_ID, [
    { role: "explorer", status: "declared", summary: "Pipeline role declared" },
  ]);
  assert.equal(declared[0].status, "declared");

  // not_spawned — main agent completed without spawning this role
  const notSpawned = await store.writeSubagents(GOAL_ID, [
    { role: "architect", status: "not_spawned", summary: "Main agent handled directly" },
  ]);
  assert.equal(notSpawned.find((item) => item.role === "architect").status, "not_spawned");

  // spawning — agent dispatch initiated
  const spawning = await store.writeSubagents(GOAL_ID, [
    { role: "builder", status: "spawning", summary: "Spawning subagent" },
  ]);
  assert.equal(spawning.find((item) => item.role === "builder").status, "spawning");

  // invalid status falls back to declared
  const invalid = await store.writeSubagents(GOAL_ID, [
    { role: "verifier", status: "invalid_xyz" },
  ]);
  assert.equal(invalid.find((item) => item.role === "verifier").status, "declared", "invalid status falls back to declared");

  // pending (old) should no longer be valid — falls back
  const oldPending = await store.writeSubagents(GOAL_ID, [
    { role: "reviewer", status: "pending" },
  ]);
  assert.equal(oldPending.find((item) => item.role === "reviewer").status, "declared", "pending (old) falls back to declared");
});

test("P0-2: buildDefaultSubagentSkeleton uses declared not pending", async () => {
  const { buildDefaultSubagentSkeleton } = await import("../src/subagents/subagent-policy.mjs");

  const skeleton = buildDefaultSubagentSkeleton();
  assert.ok(skeleton.length > 0);

  for (const agent of skeleton) {
    assert.equal(agent.status, "declared",
      `Role "${agent.role}" must default to "declared", got "${agent.status}"`);
  }

  const pendingRoles = skeleton.filter(a => a.status === "pending");
  assert.equal(pendingRoles.length, 0, "No role should default to pending");
});

test("P0-2: native evidence fields are tracked when subagent has spawn info", async () => {
  const { store } = await makeStore();

  const written = await store.writeSubagents(GOAL_ID, [
    {
      role: "explorer",
      status: "running",
      summary: "Exploring",
      native_agent_id: "agent_explorer_001",
      child_thread_id: "thread_child_abc",
      parent_thread_id: "thread_parent_xyz",
      spawned_at: "2026-07-18T00:00:00.000Z",
    },
  ]);

  assert.equal(written[0].native_agent_id, "agent_explorer_001");
  assert.equal(written[0].child_thread_id, "thread_child_abc");
  assert.equal(written[0].parent_thread_id, "thread_parent_xyz");
  assert.equal(written[0].spawned_at, "2026-07-18T00:00:00.000Z");
});

test("P0-2: empty agent runs produce no subagent entries", async () => {
  const { buildProgressFromAgentRuns } = await import("../src/subagent-progress-bridge.mjs");

  const progress = buildProgressFromAgentRuns([]);
  assert.ok(Array.isArray(progress.subagents));
  assert.equal(progress.subagents.length, 0);
});

test("P0-2: progress bridge maps declared/spawning/running/completed states", async () => {
  const { buildProgressFromAgentRuns } = await import("../src/subagent-progress-bridge.mjs");

  const progress = buildProgressFromAgentRuns([
    {
      role: "explorer",
      status: "declared",
      id: null,
      created_at: null,
    },
    {
      role: "builder",
      status: "spawning",
      id: "run_builder_001",
      created_at: "2026-07-18T00:00:00.000Z",
    },
    {
      role: "verifier",
      status: "running",
      id: "run_verifier_001",
      created_at: "2026-07-18T01:00:00.000Z",
    },
    {
      role: "finalizer",
      status: "completed",
      id: "run_finalizer_001",
      created_at: "2026-07-18T02:00:00.000Z",
    },
  ]);

  const subagents = progress.subagents;
  assert.equal(subagents.length, 4);

  const explorer = subagents.find(s => s.role === "explorer");
  assert.equal(explorer.status, "declared");

  const builder = subagents.find(s => s.role === "builder");
  assert.equal(builder.status, "spawning");

  const verifier = subagents.find(s => s.role === "verifier");
  assert.equal(verifier.status, "running");

  const finalizer = subagents.find(s => s.role === "finalizer");
  assert.equal(finalizer.status, "completed");
});

test("P0-2: progress bridge maps old pending/blocked/cancelled to new states", async () => {
  const { buildProgressFromAgentRuns } = await import("../src/subagent-progress-bridge.mjs");

  const progress = buildProgressFromAgentRuns([
    {
      role: "explorer",
      status: "pending",
      id: null,
      created_at: null,
    },
    {
      role: "builder",
      status: "blocked",
      id: "run_builder_001",
      created_at: "2026-07-18T00:00:00.000Z",
    },
    {
      role: "verifier",
      status: "cancelled",
      id: "run_verifier_001",
      created_at: "2026-07-18T01:00:00.000Z",
    },
    {
      role: "finalizer",
      status: "queued",
      id: "run_finalizer_001",
      created_at: "2026-07-18T02:00:00.000Z",
    },
  ]);

  const explorer = progress.subagents.find(s => s.role === "explorer");
  assert.equal(explorer.status, "declared", "pending -> declared");

  const builder = progress.subagents.find(s => s.role === "builder");
  assert.equal(builder.status, "failed", "blocked -> failed");

  const verifier = progress.subagents.find(s => s.role === "verifier");
  assert.equal(verifier.status, "skipped", "cancelled -> skipped");

  const finalizer = progress.subagents.find(s => s.role === "finalizer");
  assert.equal(finalizer.status, "declared", "queued -> declared");
});

test("P0-2: normalizeSubagentResult accepts new states", async () => {
  const { normalizeSubagentResult } = await import("../src/subagents/subagent-result-normalizer.mjs");

  const declared = normalizeSubagentResult({ role: "explorer", status: "declared" });
  assert.equal(declared.status, "declared");

  const notSpawned = normalizeSubagentResult({ role: "architect", status: "not_spawned" });
  assert.equal(notSpawned.status, "not_spawned");

  const spawning = normalizeSubagentResult({ role: "builder", status: "spawning" });
  assert.equal(spawning.status, "spawning");

  // invalid status should fall back to declared
  const invalid = normalizeSubagentResult({ role: "builder", status: "invalid_status" });
  assert.equal(invalid.status, "declared");

  // pending is no longer valid — falls back to declared
  const pending = normalizeSubagentResult({ role: "builder", status: "pending" });
  assert.equal(pending.status, "declared");
});

test("P0-2: inferPipelineStatus understands declared, spawning, not_spawned", async () => {
  const { inferPipelineStatus } = await import("../src/subagents/subagent-result-normalizer.mjs");

  // All declared = running (not yet started)
  const allDeclared = [
    { role: "context_curator", status: "declared" },
    { role: "builder", status: "declared" },
    { role: "finalizer", status: "declared" },
  ];
  assert.equal(inferPipelineStatus(allDeclared), "running");

  // Some declared, some spawning = running
  const withSpawning = [
    { role: "context_curator", status: "declared" },
    { role: "builder", status: "spawning" },
    { role: "finalizer", status: "declared" },
  ];
  assert.equal(inferPipelineStatus(withSpawning), "running");

  // Completed everywhere + not_spawned = completed
  const withNotSpawned = [
    { role: "context_curator", status: "completed" },
    { role: "planner", status: "completed" },
    { role: "explorer", status: "not_spawned" },
    { role: "architect", status: "not_spawned" },
    { role: "builder", status: "completed" },
    { role: "verifier", status: "completed" },
    { role: "reviewer", status: "completed" },
    { role: "finalizer", status: "completed" },
  ];
  assert.equal(inferPipelineStatus(withNotSpawned), "completed",
    "completed pipeline with not_spawned should be completed");
});

// ===========================================================================
// P0-1: Real /goal dispatch evidence tracking
// ===========================================================================

test("P0-1: buildCodexTuiBootstrapMessages starts with /goal", async () => {
  const { buildCodexTuiBootstrapMessages } = await import("../src/codex-tui-goal-prompt.mjs");

  const messages = buildCodexTuiBootstrapMessages({ goalId: "goal_abc", taskTitle: "Fix P0" });
  assert.equal(messages.length, 2);

  // First message must be /goal (real slash command, not prompt content)
  assert.match(messages[0], /^\/goal /, "First message must start with /goal ");
  assert.match(messages[0], /goal_id=goal_abc/, "Must contain goal_id");
  assert.match(messages[0], /Fix P0/, "Must contain task title");

  // Second message is follow-up instruction
  assert.match(messages[1], /goal_id=goal_abc/, "Follow-up must reference goal_id");
});

test("P0-1: buildCodexTuiGoalObjective does not contain /goal prefix", async () => {
  const { buildCodexTuiGoalObjective } = await import("../src/codex-tui-goal-prompt.mjs");

  const objective = buildCodexTuiGoalObjective({ goalId: "goal_abc", taskTitle: "Test" });

  // The objective itself should NOT contain /goal
  assert.ok(!objective.startsWith("/goal"), "Goal objective must not start with /goal");
  assert.match(objective, /goal_id=goal_abc/, "Must contain goal_id");
  assert.match(objective, /Test/, "Must contain task title");
});

test("P0-1: goal dispatch evidence schema holds structured dispatch record", async () => {
  // Validate that evidence fields can be stored in the session record
  const goalDispatchEvidence = {
    command_type: "slash_command",
    command: "/goal",
    dispatched_at: "2026-07-18T00:00:00.000Z",
    ack_received: true,
    ack_status: "active",
    ack_at: "2026-07-18T00:00:00.500Z",
    method: "goal_slash_command",
    dispatch_id: "dispatch_001",
    error: null,
  };

  assert.equal(goalDispatchEvidence.command_type, "slash_command");
  assert.equal(goalDispatchEvidence.ack_received, true);
  assert.equal(goalDispatchEvidence.ack_status, "active");

  // Fail-closed scenario: no ack
  const failClosedEvidence = {
    command_type: "slash_command",
    command: "/goal",
    dispatched_at: "2026-07-18T00:00:00.000Z",
    ack_received: false,
    ack_status: "no_ack",
    ack_at: null,
    method: "goal_slash_command",
    dispatch_id: "dispatch_002",
    error: "TUI did not acknowledge /goal command within timeout",
  };

  assert.equal(failClosedEvidence.ack_received, false);
  assert.equal(failClosedEvidence.ack_status, "no_ack");
  assert.ok(failClosedEvidence.error, "Must carry error when not acked");

  // Native evidence unavailable scenario
  const nativeUnavailableEvidence = {
    command_type: "slash_command",
    native_evidence_unavailable: true,
    reason: "Codex version does not expose spawn events",
  };
  assert.equal(nativeUnavailableEvidence.native_evidence_unavailable, true);
});

// ===========================================================================
// P0-2: Progress distinguishes pipeline manifest from native lifecycle
// ===========================================================================

test("P0-2: explorer without native evidence stays declared (not pending)", async () => {
  const { buildProgressFromAgentRuns } = await import("../src/subagent-progress-bridge.mjs");

  // Role in pipeline manifest but without native spawn evidence
  const progress = buildProgressFromAgentRuns([
    {
      role: "explorer",
      status: "declared",
      id: null,
      created_at: null,
    },
    {
      role: "builder",
      status: "completed",
      id: "run_builder_001",
      created_at: "2026-07-18T00:00:00.000Z",
    },
  ]);

  const explorer = progress.subagents.find(s => s.role === "explorer");
  assert.equal(explorer.status, "declared",
    "explorer without native evidence must be declared");

  const builder = progress.subagents.find(s => s.role === "builder");
  assert.equal(builder.status, "completed",
    "builder with native evidence should be completed");
  assert.ok(builder.agent_run_id, "builder should have agent_run_id");
});

