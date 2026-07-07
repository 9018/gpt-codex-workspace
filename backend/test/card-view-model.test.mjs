import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCardViewModel, legacyFieldsFromCard, isCardViewModelEnabledTool } from "../src/card-view-model.mjs";
import { renderCardText } from "../src/card-render-text.mjs";

test("buildCardViewModel builds runtime_status card with worker and queue summary", () => {
  const card = buildCardViewModel("runtime_status", {
    pid: 123,
    started_at: "2026-06-25T00:00:00.000Z",
    running_commit: "abcdef1234567890",
    worktree_dirty: true,
    dirty_paths: ["M backend/src/card-view-model.mjs"],
    worker: {
      enabled: true,
      running: true,
      health: { phase: "healthy", reason: "tick ok" },
      queue: { assigned: 2, running: 1, waiting_for_review: 1, failed: 0 },
    },
    queue: { assigned: 2, queued: 1, running: 1, waiting_for_lock: 0, waiting_for_review: 1, completed: 5, failed: 0 },
  }, { payload_hash: "hash-a", card_instance_id: "runtime_status:hash-a" });

  assert.equal(card.card_version, "gptwork-card-v1");
  assert.equal(card.card_type, "runtime_health");
  assert.equal(card.identity.tool, "runtime_status");
  assert.equal(card.identity.payload_hash, "hash-a");
  assert.equal(card.severity, "warning");
  assert.match(card.summary, /worker enabled/);
  assert.ok(card.key_values.some((row) => row.key === "queue.assigned" && row.value === 2));
  assert.ok(card.sections.some((section) => section.title === "Queue" && section.type === "table"));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.message.includes("Dirty worktree")));
});

test("buildCardViewModel labels runtime current blockers from normalized queue semantics", () => {
  const card = buildCardViewModel("runtime_status", {
    pid: 123,
    started_at: "2026-06-25T00:00:00.000Z",
    running_commit: "abcdef1234567890",
    worktree_dirty: false,
    worker: {
      enabled: true,
      running: false,
      health: { phase: "healthy" },
    },
    queue: {
      assigned: 0,
      queued: 0,
      running: 0,
      waiting_for_lock: 1,
      waiting_for_review: 4,
      waiting_for_repair: 1,
      actionable_review: 2,
      waiting_for_integration: 1,
      completed: 5,
      failed: 0,
      legacy_failed_policy: { blocks_current_work: true },
    },
  });

  assert.match(card.summary, /current blockers=5/);
  assert.ok(card.key_values.some((row) => row.key === "queue.current_blockers" && row.value === 5));
  assert.ok(card.key_values.some((row) => row.key === "queue.actionable_review" && row.value === 2));
  assert.ok(card.sections.some((section) => section.title === "Queue" && section.rows.some((row) => row.key === "waiting_for_repair" && row.value === 1)));
  assert.ok(card.sections.some((section) => section.title === "Current blockers" && section.items.includes("waiting_for_lock")));
  assert.ok(card.sections.some((section) => section.title === "Current blockers" && section.items.includes("waiting_for_repair")));
  assert.ok(card.sections.some((section) => section.title === "Current blockers" && section.items.includes("actionable_review")));
  assert.ok(!card.sections.some((section) => section.title === "Current blockers" && section.items.includes("waiting_for_review")));
});

test("buildCardViewModel builds get_task card with lifecycle progress and P1 summaries", () => {
  const card = buildCardViewModel("get_task", {
    task: {
      id: "task_123",
      goal_id: "goal_123",
      title: "Implement cards",
      status: "waiting_for_review",
      mode: "builder",
      assignee: "codex",
      logs: [
        { time: "2026-06-25T00:00:00.000Z", message: "started" },
        { time: "2026-06-25T00:01:00.000Z", message: "acceptance failed" },
      ],
      result: {
        summary: "Needs repair",
        acceptance: {
          overall_status: "failed",
          checks: {
            result_json_valid: true,
            summary_present: true,
            safe_changed_paths: false,
            verification_present_for_non_noop: true,
            verification_passed: false,
            worktree_clean: false,
            no_blocker_or_major_findings: false,
          },
          findings: [
            { severity: "major", code: "verification_failed", message: "Tests failed" },
          ],
          repair_proposals: ["Fix failing test"],
        },
        repair: {
          root_task_id: "task_root",
          parent_task_id: "task_parent",
          repair_attempt: 2,
          max_attempts: 2,
          repair_of_goal_id: "goal_123",
          retained_worktree: "/tmp/worktree",
          retained_branch: "gptwork/task_parent-repair-2",
          can_continue: false,
        },
        integration: {
          mode: "open_pr",
          branch: "gptwork/cards",
          worktree_path: "/tmp/worktree",
          cleanup_status: "retained",
          push_status: "passed",
          pr_status: "failed",
          merge_status: "pending",
          commit: "abcdef1234567890",
          retained_failed_worktree: true,
        },
      },
    },
  });

  assert.equal(card.card_type, "task_execution");
  assert.equal(card.identity.task_id, "task_123");
  assert.equal(card.identity.goal_id, "goal_123");
  assert.equal(card.progress.current_stage, "waiting_for_review");
  assert.ok(card.progress.stages.some((stage) => stage.key === "waiting_for_review" && stage.status === "current"));
  assert.ok(card.sections.some((section) => section.title === "Acceptance" && section.type === "checklist"));
  assert.ok(card.sections.some((section) => section.title === "Repair" && section.type === "table"));
  assert.ok(card.sections.some((section) => section.title === "Integration" && section.type === "table"));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.message.includes("Tests failed")));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.message.includes("maximum repair attempts")));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.message.includes("Retained failed worktree")));
});

test("get_task card shows finalizing convergence instead of manual checkpoint", () => {
  const card = buildCardViewModel("get_task", {
    task: {
      id: "task_finalizing",
      goal_id: "goal_finalizing",
      title: "Finish code task",
      status: "completed",
      mode: "builder",
      assignee: "codex",
      result: {
        summary: "Verification passed; finalization is converging automatically.",
        commit: "abc123",
        tests: "npm test passed",
        changed_files: ["src/file.js"],
        verification: { passed: true, commands: [{ cmd: "npm test", exit_code: 0 }] },
        convergence: { status: "finalizing", next_action: "auto_finalize_convergence" },
      },
    },
  });

  assert.ok(card.key_values.some((row) => row.key === "convergence" && row.value === "finalizing"));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.code === "finalizing_convergence" && /finalizing/i.test(diagnostic.message)));
  assert.equal(card.diagnostics.some((diagnostic) => /manual checkpoint/i.test(diagnostic.message)), false);
});

test("renderCardText uses the ViewModel fields consistently", () => {
  const card = buildCardViewModel("list_tasks", {
    tasks: [
      { id: "task_a", title: "A", status: "assigned", assignee: "codex", mode: "builder" },
      { id: "task_b", title: "B", status: "completed", assignee: "codex", mode: "builder" },
      { id: "task_c", title: "C", status: "failed", assignee: "codex", mode: "builder" },
    ],
  });
  const text = renderCardText(card);

  assert.match(text, /Task Queue/);
  assert.match(text, /assigned=1/);
  assert.match(text, /completed=1/);
  assert.match(text, /failed=1/);
  assert.match(text, /Recent tasks/);
});

test("list_tasks card separates current actionable review from resolved legacy history", () => {
  const card = buildCardViewModel("list_tasks", {
    tasks: [
      {
        id: "task_legacy_zvec",
        title: "Legacy zvec failed repair",
        status: "waiting_for_review",
        assignee: "codex",
        mode: "builder",
        result: {
          resolved_by_task_id: "task_successor_zvec",
          superseded_by_task_id: "task_successor_zvec",
        },
      },
      {
        id: "task_current_review",
        title: "Current manual review",
        status: "waiting_for_review",
        assignee: "codex",
        mode: "builder",
        waiting_for_review_reason: "manual_review",
        result: {},
      },
    ],
  });

  assert.equal(card.key_values.find((row) => row.key === "waiting_for_review")?.value, 2);
  assert.equal(card.key_values.find((row) => row.key === "actionable_review")?.value, 1);
  assert.equal(card.key_values.find((row) => row.key === "resolved_legacy_review")?.value, 1);
  assert.ok(card.sections.some((section) => section.title === "Resolved legacy history"));
  assert.ok(card.diagnostics.some((diagnostic) => diagnostic.code === "wfr_actionable" && diagnostic.message.includes("1 review")));
  assert.equal(card.diagnostics.some((diagnostic) => diagnostic.message.includes("2 review task(s) actionable")), false);
});

test("legacyFieldsFromCard derives keyValues and items for old widget compatibility", () => {
  const card = buildCardViewModel("worker_status", {
    enabled: true,
    running: true,
    health: { phase: "healthy" },
    queue: { assigned: 1, running: 1, completed: 4 },
  });
  const legacy = legacyFieldsFromCard(card);

  assert.equal(legacy.summary, card.summary);
  assert.equal(legacy.status, card.status);
  assert.ok(Array.isArray(legacy.keyValues));
  assert.ok(legacy.keyValues.some((row) => row.key === "worker"));
  assert.ok(Array.isArray(legacy.items));
  assert.ok(legacy.items.some((item) => item.includes("Queue")));
});

test("isCardViewModelEnabledTool returns true for read_handoff", () => {
  assert.ok(isCardViewModelEnabledTool("read_handoff"), "read_handoff should be card-enabled");
});

test("isCardViewModelEnabledTool returns true for show_changes", () => {
  assert.ok(isCardViewModelEnabledTool("show_changes"), "show_changes should be card-enabled");
});

test("isCardViewModelEnabledTool returns true for gptwork_doctor", () => {
  assert.ok(isCardViewModelEnabledTool("gptwork_doctor"), "gptwork_doctor should be card-enabled");
});

test("isCardViewModelEnabledTool returns true for gptwork_self_test", () => {
  assert.ok(isCardViewModelEnabledTool("gptwork_self_test"), "gptwork_self_test should be card-enabled");
});

test("isCardViewModelEnabledTool returns true for list_goals", () => {
  assert.ok(isCardViewModelEnabledTool("list_goals"), "list_goals should be card-enabled");
});

test("isCardViewModelEnabledTool returns true for start_next_queued_goal", () => {
  assert.ok(isCardViewModelEnabledTool("start_next_queued_goal"), "start_next_queued_goal should be card-enabled");
});

test("buildCardViewModel handles read_handoff via generic card", () => {
  const card = buildCardViewModel("read_handoff", {
    status: { agent: "builder", status: "completed", goal_id: "goal_123" },
    plan: "Step 1\nStep 2\nStep 3",
  });
  assert.ok(card.summary, "card should have summary");
  assert.ok(card.status, "card should have status");
  assert.ok(card.key_values, "card should have key_values");
});

test("buildCardViewModel handles show_changes via generic card", () => {
  const card = buildCardViewModel("show_changes", {
    summary: "3 files changed",
    staged_count: 2,
    unstaged_count: 1,
    changed_files: [{ path: "src/foo.mjs" }, { path: "src/bar.mjs" }],
  });
  assert.ok(card.summary, "card should have summary");
  assert.equal(card.summary, "3 files changed");
  assert.ok(card.key_values, "card should have key_values");
});

test("buildCardViewModel handles gptwork_doctor via generic card", () => {
  const card = buildCardViewModel("gptwork_doctor", {
    running_commit: "abc123def456",
    runtime_env_loaded: true,
    repository_registry_count: 3,
    worktree_dirty: false,
    summary: "GPTWork Doctor OK",
  });
  assert.ok(card.summary, "card should have summary");
  assert.equal(card.summary, "GPTWork Doctor OK");
  assert.ok(card.key_values, "card should have key_values");
});
