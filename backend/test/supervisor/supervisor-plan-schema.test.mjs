import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorPlan, CHECKPOINT_TRIGGER_MODES, TAKEOVER_POLICIES } from "../../src/supervisor/supervisor-plan-schema.mjs";

test("createSupervisorPlan requires run_id", () => {
  assert.throws(() => createSupervisorPlan({}), /run_id is required/);
});

test("createSupervisorPlan creates plan with defaults", () => {
  const plan = createSupervisorPlan({ run_id: "run_001" });
  assert.ok(plan.id.startsWith("sp_"));
  assert.equal(plan.run_id, "run_001");
  assert.equal(plan.schema_version, 1);
  assert.equal(plan.user_goal, "");
  assert.deepEqual(plan.architecture_decisions, []);
  assert.deepEqual(plan.execution_steps, []);
  assert.equal(plan.acceptance_contract_ref, null);
  assert.equal(plan.tui_strategy.preferred_mode, "automatic");
  assert.equal(plan.autonomy_budget.max_attempts, 3);
  assert.equal(plan.autonomy_budget.max_corrections, 5);
  assert.equal(plan.checkpoint_policy.triggers.length, 1);
  assert.equal(plan.checkpoint_policy.triggers[0], "no_progress");
  assert.equal(plan.takeover_policy.mode, "automatic");
  assert.equal(typeof plan.created_at, "string");
});

test("createSupervisorPlan preserves explicit fields", () => {
  const plan = createSupervisorPlan({
    run_id: "run_001",
    id: "sp_custom",
    user_goal: "Implement feature X",
    architecture_decisions: [{ decision: "use codex_tui", reason: "better UX" }],
    execution_steps: [
      { description: "Step 1", action: "code_change" },
      { description: "Step 2", action: "test" },
    ],
    acceptance_contract_ref: "contract_001",
    tui_strategy: { preferred_mode: "interactive", autopilot_enabled: false },
    autonomy_budget: { max_attempts: 5, max_corrections: 10 },
    checkpoint_policy: { triggers: ["interval", "git_diff"], interval_seconds: 600 },
    takeover_policy: { mode: "manual_only" },
  });
  assert.equal(plan.id, "sp_custom");
  assert.equal(plan.user_goal, "Implement feature X");
  assert.equal(plan.architecture_decisions.length, 1);
  assert.equal(plan.execution_steps.length, 2);
  assert.equal(plan.acceptance_contract_ref, "contract_001");
  assert.equal(plan.tui_strategy.preferred_mode, "interactive");
  assert.equal(plan.autonomy_budget.max_attempts, 5);
  assert.equal(plan.checkpoint_policy.triggers.length, 2);
  assert.ok(plan.checkpoint_policy.triggers.includes("git_diff"));
  assert.equal(plan.takeover_policy.mode, "manual_only");
});

test("CHECKPOINT_TRIGGER_MODES and TAKEOVER_POLICIES are frozen", () => {
  assert.throws(() => { CHECKPOINT_TRIGGER_MODES.push("extra"); }, /Cannot add property/);
  assert.throws(() => { TAKEOVER_POLICIES.push("extra"); }, /Cannot add property/);
});
