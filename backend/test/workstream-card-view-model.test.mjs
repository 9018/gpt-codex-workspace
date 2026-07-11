import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkstreamStatusCard } from "../src/workstream/workstream-card-view-model.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkstreamData(overrides = {}) {
  return {
    workstream: {
      id: "ws_test_001",
      title: "Test Workstream",
      status: "active",
      phase: "active",
      iteration: 0,
      project_id: "default",
      workspace_id: "hosted-default",
      repo_id: "default",
      root_goal_id: "goal_root",
      workflow_id: "wf_test",
      created_by: "system",
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T01:00:00.000Z",
      execution_policy: {
        max_parallel_tasks: 3,
        max_tui_sessions: 3,
        max_subagents_per_task: 4,
        max_subagent_depth: 1,
        max_repair_iterations: 2,
      },
    },
    dag: {
      node_count: 5,
      edge_count: 4,
      ready_count: 2,
      blocked_count: 1,
      completed_count: 2,
      running_count: 0,
      ready_nodes: [{ id: "node_a", label: "Task A" }, { id: "node_b", label: "Task B" }],
      blocked_nodes: [{ id: "node_c", label: "Task C" }],
      completed_nodes: ["node_d", "node_e"],
      phase: "active",
      iteration: 0,
    },
    tasks: [
      { id: "task_1", title: "Implement feature X", status: "running", assignee: "codex", mode: "builder" },
      { id: "task_2", title: "Write tests", status: "completed", assignee: "codex", mode: "builder" },
      { id: "task_3", title: "Review changes", status: "waiting_for_review", assignee: "codex", mode: "builder" },
      { id: "task_4", title: "Failed task", status: "failed", assignee: "codex", mode: "builder" },
    ],
    tui: {
      active_sessions: 2,
      total_sessions: 2,
      active_subagents: 3,
      max_sessions: 5,
      phase: "active",
      iteration: 0,
    },
    subagents: [
      { id: "sa_1", role: "writer", status: "completed", progress: "100%" },
      { id: "sa_2", role: "reviewer", status: "running", progress: "60%" },
      { id: "sa_3", role: "tester", status: "running", progress: "30%" },
    ],
    acceptance: {
      overall_status: "partial",
      verdict: "partial",
      checks: {
        result_json_valid: true,
        summary_present: true,
        safe_changed_paths: true,
        verification_present_for_non_noop: true,
        verification_passed: false,
        worktree_clean: false,
      },
      findings: [
        { severity: "major", code: "verification_failed", message: "Tests failed" },
      ],
      repair_proposals: ["Fix failing tests", "Clean worktree"],
    },
    repair: {
      repair_attempt: 1,
      max_attempts: 2,
      root_task_id: "task_root",
      parent_task_id: "task_parent",
      repair_of_goal_id: "goal_repair",
      can_continue: true,
    },
    chatgpt_requests: [
      { id: "req_1", kind: "escalation", status: "pending", reason: "Repair budget limit reached", created_at: "2026-07-10T12:00:00Z" },
      { id: "req_2", kind: "decision", status: "resolved", reason: "Approved scope change", created_at: "2026-07-09T08:00:00Z" },
    ],
    diagnostics: ["DAG has blocked nodes", "Repair budget running low"],
    warnings: [{ severity: "warning", message: "Worktree is dirty" }],
    errors: [{ severity: "error", message: "Task crashed" }],
    next_actions: [
      { priority: "high", action: "Fix blocked DAG node: Task C" },
      { priority: "medium", action: "Address failed acceptance checks" },
    ],
    summary: "Test workstream: active — 4 task(s), 5 DAG nodes",
    status: "warning",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("buildWorkstreamStatusCard builds a complete card with all sections", () => {
  const data = makeWorkstreamData();
  const card = buildWorkstreamStatusCard("workstream_status", data, {
    payload_hash: "hash-a",
    card_instance_id: "workstream_status:hash-a",
    title: "Workstream: Test Workstream",
  });

  assert.equal(card.card_version, "gptwork-card-v1");
  assert.equal(card.card_type, "workstream_dashboard");
  assert.equal(card.identity.tool, "workstream_status");
  assert.equal(card.identity.payload_hash, "hash-a");
  assert.equal(card.identity.workstream_id, "ws_test_001");
  assert.equal(card.title, "Workstream: Test Workstream");
  assert.equal(card.subtitle, "ws_test_001");
  assert.equal(card.status, "warning");
  assert.equal(card.severity, "error");

  // Verify key_values
  assert.ok(card.key_values.some((row) => row.key === "workstream_id" && row.value === "ws_test_001"));
  assert.ok(card.key_values.some((row) => row.key === "phase" && row.value === "active"));
  assert.ok(card.key_values.some((row) => row.key === "status" && row.value === "active"));
  assert.ok(card.key_values.some((row) => row.key === "dag_nodes" && row.value === 5));
  assert.ok(card.key_values.some((row) => row.key === "dag_ready_nodes" && row.value === 2));
  assert.ok(card.key_values.some((row) => row.key === "dag_blocked_nodes" && row.value === 1));
  assert.ok(card.key_values.some((row) => row.key === "tasks_total" && row.value === 4));
  assert.ok(card.key_values.some((row) => row.key === "tasks_active" && row.value === 1));
  assert.ok(card.key_values.some((row) => row.key === "tui_sessions" && row.value === 2));
  assert.ok(card.key_values.some((row) => row.key === "tui_active" && row.value === 2));
  assert.ok(card.key_values.some((row) => row.key === "subagents_active" && row.value === 2));
  assert.ok(card.key_values.some((row) => row.key === "acceptance_verdict" && row.value === "partial"));
  assert.ok(card.key_values.some((row) => row.key === "repair_attempts" && row.value === "1/2"));
  assert.ok(card.key_values.some((row) => row.key === "repair_can_continue" && row.value === true));
  assert.ok(card.key_values.some((row) => row.key === "chatgpt_requests_total" && row.value === 2));
  assert.ok(card.key_values.some((row) => row.key === "chatgpt_requests_pending" && row.value === 1));

  // Verify sections exist
  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Workstream Summary"));
  assert.ok(sectionTitles.includes("Execution Graph"));
  assert.ok(sectionTitles.includes("Ready / Blocked Nodes"));
  assert.ok(sectionTitles.includes("Task Execution (4)"));
  assert.ok(sectionTitles.includes("TUI / Subagent Progress"));
  assert.ok(sectionTitles.includes("Acceptance Checks"));
  assert.ok(sectionTitles.includes("Repair"));
  assert.ok(sectionTitles.includes("Open ChatGPT Requests (1 pending)"));
  assert.ok(sectionTitles.includes("Blockers & Diagnostics"));
  assert.ok(sectionTitles.includes("Next Actions"));

  // Verify diagnostics
  assert.ok(card.diagnostics.some((d) => d.code === "dag_blocked_nodes"));
  assert.ok(card.diagnostics.some((d) => d.code === "task_execution_failures"));

  // Verify actions
  assert.ok(card.actions.some((a) => a.tool === "get_workstream"));
  assert.ok(card.actions.some((a) => a.tool === "run_workstream_tick"));

  // Verify progress
  assert.equal(card.progress.current_stage, "active");
  assert.ok(card.progress.stages.some((s) => s.key === "active" && s.status === "current"));
  assert.ok(card.progress.stages.some((s) => s.key === "planned" && s.status === "done"));
  assert.ok(card.progress.stages.some((s) => s.key === "completed" && s.status === "pending"));
});

test("buildWorkstreamStatusCard handles minimal data gracefully", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {});

  assert.equal(card.card_version, "gptwork-card-v1");
  assert.equal(card.card_type, "workstream_dashboard");
  assert.equal(card.status, "info");
  assert.equal(card.severity, "info");
  assert.ok(card.summary, "card should have a summary");
  assert.equal(card.key_values.length, 0, "no key_values when data is empty");
  assert.equal(card.sections.length, 0, "empty data should not invent sections");
});

test("buildWorkstreamStatusCard detects error severity from data.errors", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {
    errors: [{ severity: "error", message: "Critical failure" }],
  });

  assert.equal(card.severity, "error");
  assert.ok(card.diagnostics.some((d) => d.message.includes("Critical failure")));
});

test("buildWorkstreamStatusCard handles empty DAG with task status fallback", () => {
  const data = makeWorkstreamData();
  delete data.dag;
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Execution Graph (list fallback)"),
    "should show list fallback when no DAG data");
});

test("buildWorkstreamStatusCard handles missing workstream data", () => {
  const data = makeWorkstreamData();
  delete data.workstream;
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.equal(card.progress, undefined, "no progress without workstream phase");
  assert.ok(card.actions.length === 0 || card.actions.length > 0, "actions should be handled");
  // Should not crash
  assert.equal(card.card_type, "workstream_dashboard");
});

test("buildWorkstreamStatusCard handles empty tasks array", () => {
  const data = makeWorkstreamData({ tasks: [] });
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.equal(sectionTitles.includes("Task Execution (0)"), false,
    "should not render task execution section with 0 tasks");
  assert.equal(card.key_values.some((k) => k.key === "tasks_total"), false);
});

test("buildWorkstreamStatusCard handles empty acceptance and repair", () => {
  const data = makeWorkstreamData({ acceptance: {}, repair: {} });
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.equal(sectionTitles.includes("Acceptance Checks"), false);
  assert.equal(sectionTitles.includes("Repair"), false);
});

test("buildWorkstreamStatusCard handles empty TUI data", () => {
  const data = makeWorkstreamData({ tui: {} });
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.equal(sectionTitles.includes("TUI / Subagent Progress"), false,
    "should not render TUI section with no TUI data");
});

test("buildWorkstreamStatusCard handles repair budget exhaustion", () => {
  const repair = {
    repair_attempt: 2,
    max_attempts: 2,
    can_continue: false,
  };
  const card = buildWorkstreamStatusCard("workstream_status", {
    workstream: { id: "ws_test", title: "Test" },
    repair,
  });

  assert.ok(card.key_values.some((k) => k.key === "repair_attempts" && k.value === "2/2"));
  assert.ok(card.key_values.some((k) => k.key === "repair_can_continue" && k.value === false));
  assert.ok(card.diagnostics.some((d) => d.code === "repair_budget_exhausted"));
});

test("buildWorkstreamStatusCard uses meta.title when no workstream title", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {
    workstream: { id: "ws_no_title" },
  }, { title: "Custom Workstream Card" });

  assert.equal(card.title, "Custom Workstream Card");
});

test("buildWorkstreamStatusCard shows phase progress for workstream with phase", () => {
  const data = makeWorkstreamData();
  data.workstream.phase = "review";
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.equal(card.progress.current_stage, "review");
  assert.ok(card.progress.stages.some((s) => s.key === "active" && s.status === "done"));
  assert.ok(card.progress.stages.some((s) => s.key === "review" && s.status === "current"));
});

test("buildWorkstreamStatusCard generates summary from data", () => {
  const data = makeWorkstreamData();
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.match(card.summary, /Test workstream/i);
  assert.match(card.summary, /4 task\(s\)/);
  assert.match(card.summary, /5 DAG nodes/);
});

test("buildWorkstreamStatusCard handles chatgpt_requests as escalations field", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {
    workstream: { id: "ws_1", title: "WS" },
    escalations: [
      { id: "esc_1", kind: "escalation", status: "pending", reason: "Need human review" },
    ],
  });

  assert.ok(card.key_values.some((k) => k.key === "chatgpt_requests_total" && k.value === 1));
  assert.ok(card.key_values.some((k) => k.key === "chatgpt_requests_pending" && k.value === 1));
  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.some((t) => t.includes("Open ChatGPT Requests")));
});

test("buildWorkstreamStatusCard handles next_actions as suggested_actions", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {
    workstream: { id: "ws_1", title: "WS" },
    suggested_actions: [
      { priority: "high", action: "Fix the bug" },
    ],
  });

  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Next Actions"));
});

test("buildWorkstreamStatusCard finalize ensures arrays", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {});

  assert.ok(Array.isArray(card.key_values));
  assert.ok(Array.isArray(card.sections));
  assert.ok(Array.isArray(card.actions));
  assert.ok(Array.isArray(card.diagnostics));
});

test("buildWorkstreamStatusCard raw_available true when data provided", () => {
  const card = buildWorkstreamStatusCard("workstream_status", { workstream: { id: "ws_1" } });
  assert.equal(card.raw_available, true);
});

test("buildWorkstreamStatusCard raw_available true even when data is empty", () => {
  const card = buildWorkstreamStatusCard("workstream_status", {});
  assert.equal(card.raw_available, true);
});

test("buildWorkstreamStatusCard handles TUI progress stages", () => {
  const data = makeWorkstreamData();
  data.tui.progress = {
    stages: [
      { key: "planning", label: "Planning", status: "done" },
      { key: "execution", label: "Execution", status: "current", detail: "2/4 tasks done" },
      { key: "review", label: "Review", status: "pending" },
    ],
  };
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Progress Stages"),
    "should include progress stages from TUI");

  // Find the progress stages section
  const progSection = card.sections.find((s) => s.title === "Progress Stages");
  assert.ok(progSection, "progress stages section should exist");
  assert.equal(progSection.type, "checklist");
  assert.ok(progSection.items.some((i) => i.label === "Planning" && i.status === "done"));
  assert.ok(progSection.items.some((i) => i.label === "Execution" && i.status === "current"));
});

test("buildWorkstreamStatusCard handles subagent array data", () => {
  const data = makeWorkstreamData();
  data.subagents = [
    { id: "sa_a", role: "coder", status: "completed" },
    { id: "sa_b", role: "debugger", status: "running" },
  ];
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Subagents (2)"),
    "should include subagent table when subagents array exists");
});

test("buildWorkstreamStatusCard adds workflow action when workflow_id present", () => {
  const data = makeWorkstreamData();
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.ok(card.actions.some((a) => a.tool === "get_workflow" && a.args.workflow_id === "wf_test"));
});

test("buildWorkstreamStatusCard does not add workflow action without workflow_id", () => {
  const data = makeWorkstreamData({ workstream: { id: "ws_1", title: "Test" } });
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.equal(card.actions.some((a) => a.tool === "get_workflow"), false);
});

test("buildWorkstreamStatusCard reports severity warning when dag blocked nodes > 0", () => {
  const data = makeWorkstreamData();
  data.errors = [];
  data.warnings = [];
  data.diagnostics = [];
  // Keep blocked DAG nodes
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.equal(card.severity, "warning", "should be warning because dag.blocked_count = 1");
  assert.ok(card.diagnostics.some((d) => d.code === "dag_blocked_nodes"));
});

test("buildWorkstreamStatusCard uses data.status when provided", () => {
  const data = makeWorkstreamData({ status: "error" });
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.equal(card.status, "error");
});

test("buildWorkstreamStatusCard integrates with card-view-model isCardViewModelEnabledTool", async () => {
  // Dynamic import to verify the module exports
  const cm = await import("../src/card-view-model.mjs");
  assert.ok(cm.isCardViewModelEnabledTool("workstream_status"),
    "workstream_status must be card-enabled");
});

test("buildWorkstreamStatusCard handles acceptance with repair proposals", () => {
  const data = makeWorkstreamData();
  data.acceptance.repair_proposals = ["Fix failed tests", "Clean up worktree"];
  const card = buildWorkstreamStatusCard("workstream_status", data);

  const sectionTitles = card.sections.map((s) => s.title);
  assert.ok(sectionTitles.includes("Repair Proposals"), "should include repair proposals");

  const propSection = card.sections.find((s) => s.title === "Repair Proposals");
  assert.equal(propSection.type, "list");
  assert.ok(propSection.items.some((i) => i.includes("Fix failed tests")));
});

test("buildWorkstreamStatusCard handles acceptance findings as diagnostics", () => {
  const data = makeWorkstreamData();
  data.acceptance.findings = [
    { severity: "major", code: "TEST_FAIL", message: "Unit tests failed" },
    { severity: "blocker", code: "NO_COMMIT", message: "No commit evidence" },
  ];
  const card = buildWorkstreamStatusCard("workstream_status", data);

  assert.ok(card.diagnostics.some((d) => d.code === "TEST_FAIL"));
  assert.ok(card.diagnostics.some((d) => d.code === "NO_COMMIT"));
});
