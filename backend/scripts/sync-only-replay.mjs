#!/usr/bin/env node
/**
 * sync-only-replay.mjs — Deterministic worker-level replay for sync-only verification.
 *
 * P0: Simulates the complete GPTWork convergence → notification → sweeper chain
 * for all key scenarios without external network dependencies.
 *
 * Outputs a structured report matching the goal requirement.
 */

import { convergeTaskAfterRun, detectAcceptanceProfile, consolidateBatchConvergence, CONVERGENCE_STATUSES } from "../src/task-convergence.mjs";
import { sweepStaleTaskStates } from "../src/stale-state-sweeper.mjs";

const REPLAYS = [];
const NOW = Date.now();
const STALE_THRESHOLD = 300_000;

function run(name, fn) {
  try {
    const result = fn();
    REPLAYS.push({ name, status: "passed", result });
    return result;
  } catch (err) {
    REPLAYS.push({ name, status: "failed", error: err.message });
    console.error(`  ✗ ${name}: ${err.message}`);
    return null;
  }
}

// ===========================================================================
// Replay 1: sync-only no-code → completed
// ===========================================================================
run("sync-only no-code → completed", () => {
  const convergence = convergeTaskAfterRun({
    task: {
      id: "replay_sync_1",
      status: "running",
      mode: "builder",
      title: "P0: 同步本地 main 到远端 main",
      description: "同步当前本地 main 到远端 main，报告 ahead/behind",
    },
    taskResult: {
      status: "completed",
      summary: "remote head updated, ahead/behind 0/0, local=remote",
      changed_files: [],
      commit: "abc123def456",
      remote_head: "abc123def456",
      verification: { passed: true },
    },
    acceptance: {
      passed: false,
      status: "needs_fix",
      findings: [
        { severity: "major", code: "tests_missing", message: "Contract: tests_missing" },
        { severity: "major", code: "changed_files_mismatch", message: "No files changed" },
      ],
    },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.COMPLETED)
    throw new Error(`Expected completed, got ${convergence.nextStatus}`);

  return convergence;
});

// ===========================================================================
// Replay 2: 429 rate_limited → quota_wait, no repair
// ===========================================================================
run("429 rate_limited → quota_wait, no repair", () => {
  const convergence = convergeTaskAfterRun({
    task: { id: "replay_429", status: "running", title: "Some task" },
    taskResult: { failure_class: "rate_limited", summary: "429 Too Many Requests" },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.QUOTA_WAIT)
    throw new Error(`Expected quota_wait, got ${convergence.nextStatus}`);
  if (convergence.repairPlan !== null)
    throw new Error("429 should NOT create repair plan");

  return convergence;
});

// ===========================================================================
// Replay 3: 502 gateway_error → retry_wait, no repair
// ===========================================================================
run("502 gateway_error → retry_wait, no repair", () => {
  const convergence = convergeTaskAfterRun({
    task: { id: "replay_502", status: "running" },
    taskResult: { failure_class: "gateway_error", summary: "502 Bad Gateway" },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.RETRY_WAIT)
    throw new Error(`Expected retry_wait, got ${convergence.nextStatus}`);
  if (convergence.repairPlan !== null)
    throw new Error("502 should NOT create repair plan");

  return convergence;
});

// ===========================================================================
// Replay 4: 503 service_unavailable → retry_wait, no repair
// ===========================================================================
run("503 provider_interruption → retry_wait, no repair", () => {
  const convergence = convergeTaskAfterRun({
    task: { id: "replay_503", status: "running" },
    taskResult: { failure_class: "provider_interruption", summary: "Provider interruption: empty stdout" },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.RETRY_WAIT)
    throw new Error(`Expected retry_wait, got ${convergence.nextStatus}`);
  if (convergence.repairPlan !== null)
    throw new Error("provider_interruption should NOT create repair plan");

  return convergence;
});

// ===========================================================================
// Replay 5: verification failed → waiting_for_repair
// ===========================================================================
run("verification failed → waiting_for_repair", () => {
  const convergence = convergeTaskAfterRun({
    task: { id: "replay_verify", status: "running", title: "P0: feature", repair_attempt: 0 },
    taskResult: { status: "completed", summary: "Tests failed", verification: { passed: false }, failure_class: "verification_failed" },
    acceptance: { passed: false, status: "needs_fix", findings: [{ severity: "blocker", code: "test_failed", message: "Tests failed" }] },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.WAITING_FOR_REPAIR)
    throw new Error(`Expected waiting_for_repair, got ${convergence.nextStatus}`);
  if (convergence.repairPlan === null)
    throw new Error("Should have repair plan");

  return convergence;
});

// ===========================================================================
// Replay 6: Runtime change → restart_pending
// ===========================================================================
run("runtime change → restart_pending", () => {
  const convergence = convergeTaskAfterRun({
    task: { id: "replay_restart", status: "running" },
    taskResult: { status: "completed", summary: "Runtime changed", verification: { passed: true } },
    acceptance: { passed: true, status: "accepted", findings: [] },
    runtimeState: { runningCommit: "old_sha", repo_head: "new_sha", runtimeChanged: true },
    attempt: 0,
  });

  if (convergence.nextStatus !== CONVERGENCE_STATUSES.RESTART_PENDING)
    throw new Error(`Expected restart_pending, got ${convergence.nextStatus}`);
  if (convergence.restartPlan === null || !convergence.restartPlan.required)
    throw new Error("Should have restart plan with required=true");

  return convergence;
});

// ===========================================================================
// Replay 7: Sweeper — stale waiting_for_integration aligned → completed
// ===========================================================================
run("sweeper: stale waiting_for_integration aligned → completed", () => {
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "replay_sweep_int",
      status: "waiting_for_integration",
      updated_at: new Date(NOW - STALE_THRESHOLD * 3).toISOString(),
      result: { commit: "abc", remote_head: "abc" },
    }],
    repoState: { localHead: "abc", remoteHead: "abc" },
    now: NOW,
    staleThresholdMs: STALE_THRESHOLD,
  });

  if (actions.length !== 1 || actions[0].recommendedStatus !== "completed")
    throw new Error(`Expected completed, got ${actions[0]?.recommendedStatus}`);

  return actions[0];
});

// ===========================================================================
// Replay 8: Sweeper — waiting_for_repair parent completed → completed
// ===========================================================================
run("sweeper: waiting_for_repair parent completed → completed", () => {
  const actions = sweepStaleTaskStates({
    tasks: [
      { id: "parent_done", status: "completed" },
      { id: "child_repair", status: "waiting_for_repair", parent_task_id: "parent_done", updated_at: new Date(NOW - 1000).toISOString() },
    ],
    now: NOW,
  });

  if (actions.length !== 1 || actions[0].recommendedStatus !== "completed")
    throw new Error(`Expected completed, got ${actions[0]?.recommendedStatus}`);

  return actions[0];
});

// ===========================================================================
// Replay 9: Sweeper — retry_wait backoff elapsed → queued
// ===========================================================================
run("sweeper: retry_wait backoff elapsed → queued", () => {
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "replay_retry",
      status: "retry_wait",
      updated_at: new Date(NOW - 30_000).toISOString(),
      result: { failure_class: "gateway_error" },
      healing_retry_count: 0,
    }],
    now: NOW,
    staleThresholdMs: STALE_THRESHOLD,
  });

  if (actions.length !== 1 || actions[0].recommendedStatus !== "queued")
    throw new Error(`Expected queued, got ${actions[0]?.recommendedStatus}`);

  return actions[0];
});

// ===========================================================================
// Replay 10: Sweeper — quota_wait backoff elapsed → queued
// ===========================================================================
run("sweeper: quota_wait backoff elapsed → queued", () => {
  const actions = sweepStaleTaskStates({
    tasks: [{
      id: "replay_quota",
      status: "quota_wait",
      updated_at: new Date(NOW - 60_000).toISOString(),
      result: { failure_class: "rate_limited" },
      healing_retry_count: 0,
    }],
    now: NOW,
    staleThresholdMs: STALE_THRESHOLD,
  });

  if (actions.length !== 1 || actions[0].recommendedStatus !== "queued")
    throw new Error(`Expected queued, got ${actions[0]?.recommendedStatus}`);

  return actions[0];
});

// ===========================================================================
// Replay 11: Batch convergence consolidation
// ===========================================================================
run("consolidateBatchConvergence healthy and stale detection", () => {
  const healthy = consolidateBatchConvergence([
    { nextStatus: "completed" },
    { nextStatus: "completed" },
    { nextStatus: "failed" },
  ]);
  if (!healthy.healthy) throw new Error("Should be healthy");

  const stale = consolidateBatchConvergence([
    { nextStatus: "completed" },
    { nextStatus: "waiting_for_review" },
    { nextStatus: "waiting_for_repair" },
    { nextStatus: "waiting_for_integration" },
  ]);
  if (stale.healthy) throw new Error("Should be unhealthy");
  if (stale.staleReviewCount !== 1 || stale.staleRepairCount !== 1 || stale.staleIntegrationCount !== 1)
    throw new Error("Stale counts mismatch");

  return { healthy, stale };
});

// ===========================================================================
// Report
// ===========================================================================
const failed = REPLAYS.filter(r => r.status === "failed").length;
const passed = REPLAYS.filter(r => r.status === "passed").length;

const report = {
  timestamp: new Date().toISOString(),
  summary: `${passed}/${REPLAYS.length} replays passed (${failed} failed)`,
  replays: REPLAYS.map(r => ({
    name: r.name,
    status: r.status,
    error: r.error || null,
    details: r.result ? {
      nextStatus: r.result.nextStatus || r.result.recommendedStatus || null,
      profile: r.result.profile || null,
      closureReason: r.result.closureReason || null,
      repairCount: r.result.repairPlan ? 1 : 0,
      retryCount: r.result.retryPlan ? 1 : 0,
      restartCount: r.result.restartPlan ? 1 : 0,
      barkEvents: (r.result.notifications || []).map(n => n.event),
      githubWriteback: r.result.githubWriteback ? {
        action: r.result.githubWriteback.action,
        status: r.result.githubWriteback.status || r.result.githubWriteback.body?.slice(0, 80) || null,
      } : null,
    } : null,
  })),
  final_status: failed === 0 ? "completed" : "failed",
  failure_class: null,
  repair_count: REPLAYS.reduce((sum, r) => sum + (r.result?.repairPlan ? 1 : 0), 0),
  bark_events: REPLAYS.flatMap(r => r.result?.notifications?.map(n => n.event) || []),
  github_writeback_actions: REPLAYS.map(r => r.result?.githubWriteback?.action || null).filter(Boolean),
  runtime_restart_count: REPLAYS.filter(r => r.result?.restartPlan?.required).length,
};

console.log("\n" + "=".repeat(70));
console.log("GPTWORK WORKER-LEVEL REPLAY REPORT");
console.log("=".repeat(70));
console.log(`Status: ${report.final_status}`);
console.log(`Replays: ${report.summary}`);
console.log(`Repair plans created: ${report.repair_count}`);
console.log(`Restart plans created: ${report.runtime_restart_count}`);
console.log("");
console.log("Replay Details:");
console.log("-".repeat(40));
for (const r of report.replays) {
  const icon = r.status === "passed" ? "✓" : "✗";
  console.log(`  ${icon} ${r.name}`);
  if (r.details) {
    console.log(`     Status: ${r.details.nextStatus}`);
    if (r.details.profile) console.log(`     Profile: ${r.details.profile}`);
    if (r.details.barkEvents?.length) console.log(`     Bark: ${r.details.barkEvents.join(", ")}`);
    if (r.details.githubWriteback) console.log(`     GitHub: ${r.details.githubWriteback.action}`);
  }
}
console.log("-".repeat(40));
console.log(`Bark events fired: ${report.bark_events.join(", ")}`);
console.log(`GitHub writeback actions: ${report.github_writeback_actions.join(", ")}`);
console.log("=".repeat(70));

// Exit with proper code
process.exit(failed === 0 ? 0 : 1);
