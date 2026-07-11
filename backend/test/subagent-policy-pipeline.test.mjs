/**
 * subagent-policy-pipeline.test.mjs — Tests for parent TUI subagent pipeline definitions.
 *
 * Tests the fixed multi-agent pipeline phases, parallel groups, repair rounds,
 * role-to-phase mapping, and default skeleton builder.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PARENT_TUI_PHASES,
  PARENT_TUI_PHASE_COUNT,
  PARENT_TUI_MAX_REPAIR_ROUNDS,
  PARENT_TUI_PIPELINE_ROLES,
  PARENT_TUI_ROLE_TO_PHASE,
  getPhaseForRole,
  getPhaseForRoleInfo,
  isParallelPhase,
  isTerminalPhase,
  getPhaseLabelForRole,
  isRepairRole,
  getMaxRepairRounds,
  getFlatPipelineOrder,
  buildDefaultSubagentSkeleton,
} from "../src/subagents/subagent-policy.mjs";

// ===========================================================================
// Pipeline phase definitions
// ===========================================================================

test("PARENT_TUI_PHASES has 8 phases in order", () => {
  assert.equal(PARENT_TUI_PHASE_COUNT, 8);
  assert.equal(PARENT_TUI_PHASES.length, 8);

  const phaseNames = PARENT_TUI_PHASES.map((p) => p.name);
  assert.deepEqual(phaseNames, [
    "context_curation",
    "analysis",
    "planning",
    "building",
    "verification",
    "review",
    "repair",
    "finalization",
  ]);
});

test("analysis phase has three parallel roles", () => {
  const analysis = PARENT_TUI_PHASES[1];
  assert.equal(analysis.name, "analysis");
  assert.equal(analysis.parallel, true);
  assert.deepEqual(analysis.roles, ["explorer", "architect", "test_analyst"]);
});

test("repair phase allows max 2 rounds", () => {
  const repair = PARENT_TUI_PHASES[6];
  assert.equal(repair.name, "repair");
  assert.equal(repair.max_rounds, 2);
  assert.equal(repair.parallel, false);
  assert.deepEqual(repair.roles, ["repairer"]);
});

test("all non-analysis phases are sequential", () => {
  for (const phase of PARENT_TUI_PHASES) {
    if (phase.name === "analysis") {
      assert.equal(phase.parallel, true);
    } else {
      assert.equal(phase.parallel, false, `Phase ${phase.name} should be sequential`);
    }
  }
});

test("PARENT_TUI_PIPELINE_ROLES includes all roles", () => {
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("context_curator"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("explorer"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("architect"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("test_analyst"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("planner"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("builder"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("verifier"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("reviewer"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("repairer"));
  assert.ok(PARENT_TUI_PIPELINE_ROLES.includes("finalizer"));
  assert.equal(PARENT_TUI_PIPELINE_ROLES.length, 10); // Includes repairer once
});

test("PARENT_TUI_MAX_REPAIR_ROUNDS is 2", () => {
  assert.equal(PARENT_TUI_MAX_REPAIR_ROUNDS, 2);
  assert.equal(getMaxRepairRounds(), 2);
});

// ===========================================================================
// Role-to-phase mapping
// ===========================================================================

test("getPhaseForRole returns correct phase indices", () => {
  assert.equal(getPhaseForRole("context_curator"), 0);
  assert.equal(getPhaseForRole("explorer"), 1);
  assert.equal(getPhaseForRole("architect"), 1);
  assert.equal(getPhaseForRole("test_analyst"), 1);
  assert.equal(getPhaseForRole("planner"), 2);
  assert.equal(getPhaseForRole("builder"), 3);
  assert.equal(getPhaseForRole("verifier"), 4);
  assert.equal(getPhaseForRole("reviewer"), 5);
  assert.equal(getPhaseForRole("repairer"), 6);
  assert.equal(getPhaseForRole("finalizer"), 7);
});

test("getPhaseForRole throws for unknown role", () => {
  assert.throws(() => getPhaseForRole("unknown_role"), /unknown parent tui role/i);
});

test("getPhaseForRoleInfo returns full phase object", () => {
  const info = getPhaseForRoleInfo("explorer");
  assert.equal(info.name, "analysis");
  assert.equal(info.label, "Analysis");
  assert.equal(info.index, 1);
  assert.equal(info.parallel, true);
});

test("PARENT_TUI_ROLE_TO_PHASE maps roles to indices", () => {
  assert.equal(PARENT_TUI_ROLE_TO_PHASE.context_curator, 0);
  assert.equal(PARENT_TUI_ROLE_TO_PHASE.builder, 3);
  assert.equal(PARENT_TUI_ROLE_TO_PHASE.verifier, 4);
  assert.equal(PARENT_TUI_ROLE_TO_PHASE.finalizer, 7);
  assert.equal(PARENT_TUI_ROLE_TO_PHASE.repairer, 6);
});

// ===========================================================================
// Phase helpers
// ===========================================================================

test("isParallelPhase returns correct values", () => {
  assert.equal(isParallelPhase(0), false);  // context_curation
  assert.equal(isParallelPhase(1), true);   // analysis
  assert.equal(isParallelPhase(2), false);  // planning
  assert.equal(isParallelPhase(7), false);  // finalization
});

test("isTerminalPhase returns true only for phase 7", () => {
  assert.equal(isTerminalPhase(7), true);
  for (let i = 0; i < 7; i++) {
    assert.equal(isTerminalPhase(i), false, `Phase ${i} should not be terminal`);
  }
});

test("getPhaseLabelForRole returns human-readable labels", () => {
  assert.equal(getPhaseLabelForRole("context_curator"), "Context Curation");
  assert.equal(getPhaseLabelForRole("explorer"), "Analysis");
  assert.equal(getPhaseLabelForRole("architect"), "Analysis");
  assert.equal(getPhaseLabelForRole("builder"), "Building");
  assert.equal(getPhaseLabelForRole("finalizer"), "Finalization");
  assert.equal(getPhaseLabelForRole("repairer"), "Repair");
});

test("isRepairRole returns true only for repairer", () => {
  assert.equal(isRepairRole("repairer"), true);
  assert.equal(isRepairRole("builder"), false);
  assert.equal(isRepairRole("verifier"), false);
  assert.equal(isRepairRole("reviewer"), false);
});

// ===========================================================================
// Pipeline order & skeleton
// ===========================================================================

test("getFlatPipelineOrder returns all roles in order", () => {
  const order = getFlatPipelineOrder();
  assert.deepEqual(order, [
    "context_curator",
    "explorer", "architect", "test_analyst",
    "planner",
    "builder",
    "verifier",
    "reviewer",
    "repairer",
    "finalizer",
  ]);
});

test("buildDefaultSubagentSkeleton creates entry for each role with pending status", () => {
  const skeleton = buildDefaultSubagentSkeleton();
  assert.equal(skeleton.length, 11); // 9 unique roles + 2 repairer rounds = 11 entries

  // Check first entry
  assert.equal(skeleton[0].role, "context_curator");
  assert.equal(skeleton[0].status, "pending");
  assert.equal(skeleton[0].round, 1);

  // Check parallel agents
  const parallelAgents = skeleton.filter((s) => s.phase === "analysis");
  assert.equal(parallelAgents.length, 3);
  const roles = parallelAgents.map((s) => s.role).sort();
  assert.deepEqual(roles, ["architect", "explorer", "test_analyst"]);

  // Check repairer has 2 rounds
  const repairers = skeleton.filter((s) => s.role === "repairer");
  assert.equal(repairers.length, 2);
  assert.equal(repairers[0].round, 1);
  assert.equal(repairers[1].round, 2);
  assert.equal(repairers[0].status, "pending");

  // Check finalizer
  const finalizer = skeleton.find((s) => s.role === "finalizer");
  assert.ok(finalizer);
  assert.equal(finalizer.status, "pending");

  // Check all entries have required fields
  for (const entry of skeleton) {
    assert.ok(entry.role);
    assert.ok(entry.phase);
    assert.ok(entry.status);
    assert.ok(Array.isArray(entry.changed_files));
    assert.ok(Array.isArray(entry.artifacts));
    assert.ok(Array.isArray(entry.blockers));
  }
});

test("buildDefaultSubagentSkeleton repairRounds parameter", () => {
  const skeleton = buildDefaultSubagentSkeleton({ repairRounds: 1 });
  const repairers = skeleton.filter((s) => s.role === "repairer");
  assert.equal(repairers.length, 1);
  assert.equal(repairers[0].round, 1);
});

test("buildDefaultSubagentSkeleton zero repair rounds", () => {
  const skeleton = buildDefaultSubagentSkeleton({ repairRounds: 0 });
  const repairers = skeleton.filter((s) => s.role === "repairer");
  assert.equal(repairers.length, 0);
});

console.log("subagent-policy-pipeline tests loaded");
