/**
 * subagent-result-normalizer.test.mjs — Tests for subagent result normalizer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSubagentResult,
  normalizeSubagentResults,
  deduplicateSubagentResults,
  inferPipelineStatus,
  inferCurrentPhase,
  collectBlockers,
  inferNextExpectedEvent,
} from "../src/subagents/subagent-result-normalizer.mjs";

// ===========================================================================
// normalizeSubagentResult
// ===========================================================================

test("normalizeSubagentResult handles empty input", () => {
  const result = normalizeSubagentResult(null);
  assert.equal(result.role, "");
  assert.equal(result.status, "failed");
  assert.ok(result.summary.includes("Invalid"));
});

test("normalizeSubagentResult normalizes a typical result", () => {
  const raw = {
    role: "builder",
    status: "completed",
    summary: "Implemented the feature",
    changed_files: ["src/main.mjs", "src/lib.mjs"],
    artifacts: ["dist/output.js"],
    blockers: [],
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T01:00:00.000Z",
  };

  const result = normalizeSubagentResult(raw);
  assert.equal(result.role, "builder");
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Implemented the feature");
  assert.deepEqual(result.changed_files, ["src/main.mjs", "src/lib.mjs"]);
  assert.deepEqual(result.artifacts, ["dist/output.js"]);
  assert.equal(result.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(result.completed_at, "2026-01-01T01:00:00.000Z");
  assert.equal(result.round, 1);
  assert.equal(result.phase, "building");
});

test("normalizeSubagentResult normalizes various field aliases", () => {
  const raw = {
    role: "explorer",
    changedFiles: ["api.ts"],
    output_artifacts: ["report.md"],
    blocking_findings: ["api_key_missing"],
    startedAt: "2026-01-01T00:00:00.000Z",
    exit_code: 0,
  };

  const result = normalizeSubagentResult(raw);
  assert.equal(result.role, "explorer");
  assert.deepEqual(result.changed_files, ["api.ts"]);
  assert.deepEqual(result.artifacts, ["report.md"]);
  assert.deepEqual(result.blockers, ["api_key_missing"]);
  assert.equal(result.status, "pending");
  assert.equal(result.evidence.exit_code, 0);
});

test("normalizeSubagentResult handles unknown role gracefully", () => {
  const result = normalizeSubagentResult({ role: "unknown_role", status: "completed" });
  assert.equal(result.role, "unknown_role");
  assert.equal(result.status, "completed");
  // phase detection should throw but result is handled gracefully
  assert.equal(result.phase, "");
});

test("normalizeSubagentResult handles repairer result", () => {
  const result = normalizeSubagentResult({ role: "repairer", round: 2, status: "completed" });
  assert.equal(result.role, "repairer");
  assert.equal(result.round, 2);
  assert.equal(result.phase, "repair");
});

// ===========================================================================
// normalizeSubagentResults
// ===========================================================================

test("normalizeSubagentResults handles empty/null/undefined", () => {
  assert.deepEqual(normalizeSubagentResults(), []);
  assert.deepEqual(normalizeSubagentResults(null), []);
  assert.deepEqual(normalizeSubagentResults([]), []);
});

test("normalizeSubagentResults normalizes multiple results", () => {
  const results = normalizeSubagentResults([
    { role: "explorer", status: "completed" },
    { role: "builder", status: "running" },
    { role: "finalizer", status: "pending" },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].role, "explorer");
  assert.equal(results[1].status, "running");
  assert.equal(results[2].role, "finalizer");
});

// ===========================================================================
// deduplicateSubagentResults
// ===========================================================================

test("deduplicateSubagentResults merges entries by role+round", () => {
  const merged = deduplicateSubagentResults([
    { role: "builder", round: 1, status: "running", summary: "In progress" },
    { role: "builder", round: 1, status: "completed", summary: "Done" },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].summary, "Done");
});

test("deduplicateSubagentResults keeps repairer rounds separate", () => {
  const merged = deduplicateSubagentResults([
    { role: "repairer", round: 1, status: "completed", summary: "Fixed issue" },
    { role: "repairer", round: 2, status: "running", summary: "Still fixing" },
  ]);

  assert.equal(merged.length, 2);
  const r1 = merged.find((m) => m.round === 1);
  const r2 = merged.find((m) => m.round === 2);
  assert.ok(r1);
  assert.ok(r2);
  assert.equal(r1.status, "completed");
  assert.equal(r2.status, "running");
});

// ===========================================================================
// inferPipelineStatus
// ===========================================================================

test("inferPipelineStatus returns running for empty input", () => {
  assert.equal(inferPipelineStatus([]), "running");
});

test("inferPipelineStatus returns running when agent is running", () => {
  const agents = [
    { role: "context_curator", status: "completed" },
    { role: "builder", status: "running" },
  ];
  assert.equal(inferPipelineStatus(agents), "running");
});

test("inferPipelineStatus returns blocked when agent is blocked", () => {
  const agents = [
    { role: "builder", status: "blocked", blockers: ["Missing API key"] },
  ];
  assert.equal(inferPipelineStatus(agents), "blocked");
});

test("inferPipelineStatus returns completed when all agents completed", () => {
  const agents = [
    { role: "context_curator", status: "completed", started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T01:00:00.000Z" },
    { role: "explorer", status: "completed", started_at: "2026-01-01T01:00:00.000Z", completed_at: "2026-01-01T02:00:00.000Z" },
    { role: "architect", status: "completed", started_at: "2026-01-01T01:00:00.000Z", completed_at: "2026-01-01T02:00:00.000Z" },
    { role: "test_analyst", status: "completed", started_at: "2026-01-01T01:00:00.000Z", completed_at: "2026-01-01T02:00:00.000Z" },
    { role: "planner", status: "completed", started_at: "2026-01-01T02:00:00.000Z", completed_at: "2026-01-01T03:00:00.000Z" },
    { role: "builder", status: "completed", started_at: "2026-01-01T03:00:00.000Z", completed_at: "2026-01-01T04:00:00.000Z" },
    { role: "verifier", status: "completed", started_at: "2026-01-01T04:00:00.000Z", completed_at: "2026-01-01T05:00:00.000Z" },
    { role: "reviewer", status: "completed", started_at: "2026-01-01T05:00:00.000Z", completed_at: "2026-01-01T06:00:00.000Z" },
    { role: "repairer", round: 1, status: "skipped", started_at: null, completed_at: null },
    { role: "repairer", round: 2, status: "skipped", started_at: null, completed_at: null },
    { role: "finalizer", status: "completed", started_at: "2026-01-01T06:00:00.000Z", completed_at: "2026-01-01T07:00:00.000Z" },
  ];
  assert.equal(inferPipelineStatus(agents), "completed");
});

test("inferPipelineStatus returns failed when non-repair agent failed", () => {
  const agents = [
    { role: "builder", status: "failed" },
    { role: "finalizer", status: "pending" },
  ];
  assert.equal(inferPipelineStatus(agents), "failed");
});

// ===========================================================================
// inferCurrentPhase
// ===========================================================================

test("inferCurrentPhase returns context_curation for empty", () => {
  assert.equal(inferCurrentPhase([]), "context_curation");
});

test("inferCurrentPhase returns running agent's phase", () => {
  const agents = [
    { role: "context_curator", status: "completed", phase: "context_curation" },
    { role: "builder", status: "running", phase: "building" },
  ];
  assert.equal(inferCurrentPhase(agents), "building");
});

test("inferCurrentPhase returns pending agent phase", () => {
  const agents = [
    { role: "builder", status: "completed", phase: "building" },
    { role: "verifier", status: "pending", phase: "verification" },
  ];
  assert.equal(inferCurrentPhase(agents), "verification");
});

// ===========================================================================
// collectBlockers
// ===========================================================================

test("collectBlockers returns unique blockers from blocked agents", () => {
  const agents = [
    { role: "builder", status: "blocked", blockers: ["Missing API key", "No disk space"] },
    { role: "verifier", status: "blocked", blockers: ["Missing API key"] },
  ];
  const blockers = collectBlockers(agents);
  assert.equal(blockers.length, 2);
  assert.ok(blockers.includes("Missing API key"));
  assert.ok(blockers.includes("No disk space"));
});

test("collectBlockers returns empty for no blockers", () => {
  assert.deepEqual(collectBlockers([]), []);
  assert.deepEqual(collectBlockers([{ role: "builder", status: "completed", blockers: [] }]), []);
});

// ===========================================================================
// inferNextExpectedEvent
// ===========================================================================

test("inferNextExpectedEvent returns pipeline_start for empty", () => {
  assert.equal(inferNextExpectedEvent([]), "pipeline_start");
});

test("inferNextExpectedEvent returns task_completion for completed pipeline", () => {
  const agents = [
    { role: "context_curator", status: "completed", started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T01:00:00.000Z" },
    { role: "planner", status: "completed", started_at: "2026-01-01T01:00:00.000Z", completed_at: "2026-01-01T02:00:00.000Z" },
    { role: "builder", status: "completed", started_at: "2026-01-01T02:00:00.000Z", completed_at: "2026-01-01T03:00:00.000Z" },
    { role: "verifier", status: "completed", started_at: "2026-01-01T03:00:00.000Z", completed_at: "2026-01-01T04:00:00.000Z" },
    { role: "reviewer", status: "completed", started_at: "2026-01-01T04:00:00.000Z", completed_at: "2026-01-01T05:00:00.000Z" },
    { role: "finalizer", status: "completed", started_at: "2026-01-01T05:00:00.000Z", completed_at: "2026-01-01T06:00:00.000Z" },
  ];
  assert.equal(inferNextExpectedEvent(agents), "task_completion");
});

test("inferNextExpectedEvent returns recovery_or_repair for failed pipeline", () => {
  const agents = [
    { role: "builder", status: "failed" },
  ];
  assert.equal(inferNextExpectedEvent(agents), "recovery_or_repair");
});

test("inferNextExpectedEvent returns blocker_resolution for blocked pipeline", () => {
  const agents = [
    { role: "builder", status: "blocked" },
  ];
  assert.equal(inferNextExpectedEvent(agents), "blocker_resolution");
});

console.log("subagent-result-normalizer tests loaded");
