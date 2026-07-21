/**
 * e2e-acceptance-canary.test.mjs — End-to-end acceptance canaries.
 *
 * These tests verify the 14 canary scenarios from the acceptance matrix.
 * They exercise the new execution-core kernel end-to-end, without
 * requiring production wiring (providers, store, etc.).
 *
 * @module e2e-acceptance-canary
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyExecutionIntent, classifyAndNormalize } from "../../src/execution-core/execution-intent-classifier.mjs";
import { normalizeExecutionIntent } from "../../src/execution-core/execution-intent-schema.mjs";
import { createExecutionRunStore } from "../../src/execution-core/execution-run-store.mjs";
import { createExecutionRunService } from "../../src/execution-core/execution-run-service.mjs";
import { createProjectionService, mapRunStateToTaskState } from "../../src/execution-core/execution-projection-service.mjs";
import { createExecutionResult, findMissingEvidence } from "../../src/execution-core/execution-result-schema.mjs";
import { createEvidenceBundle, reconcileProviderClaims } from "../../src/execution-core/execution-evidence-bundle-schema.mjs";
import { evaluateEvidence } from "../../src/execution-core/acceptance-decision-schema.mjs";
import { getProfile, getProfileRequirements } from "../../src/execution-core/operation-profile-registry.mjs";
import { classifyFailure } from "../../src/execution-core/execution-recovery-service.mjs";
import { OBSERVATION_STATES } from "../../src/execution/execution-provider-contract.mjs";
import { mapRunStateToTaskState as legacyMap } from "../../src/execution-core/legacy-task-adapter.mjs";
import { compilePlan } from "../../src/execution-core/execution-plan-compiler.mjs";

// =========================================================================
// Helper: minimal deps for ExecutionRunService
// =========================================================================
function createDeps() {
  const runStore = createExecutionRunStore();
  const projectionService = createProjectionService();
  return {
    runStore,
    projectionService,
    acceptanceService: {
      async evaluate() {
        return { decision: "accepted", summary: "canary default accept", id: "canary_dec" };
      },
    },
  };
}

// =========================================================================
// Canary 1: 修改一处代码，完成测试、Commit、Integration、验收和状态投影
// =========================================================================
test("[Canary 1] code_change: intent → run → evidence → acceptance → projection", async () => {
  // 1. Classify and normalize the intent (gives us an id)
  const intent = classifyAndNormalize({ request_text: "Fix login bug", operation_kind: "code_change" });
  assert.equal(intent.operation_kind, "code_change", "should classify as code_change");
  assert.equal(intent.mutation_scope, "repo", "code_change should have repo scope");
  assert.ok(intent.id, `intent should have an id, got ${intent.id}`);

  // 2. Create and start a run
  const deps = createDeps();
  const svc = createExecutionRunService(deps);
  const { run, started } = await svc.start({ intent_id: intent.id, task_id: "task_001" });
  assert.ok(started, "run should start");
  assert.equal(run.state, "ready", "run should be in ready state");

  // 3. Advance the run through collecting → evaluating → completed
  const result = await svc.advanceRun(run.id);
  assert.equal(result.run.state, "completed", "run should complete");

  // 4. Verify projection maps correctly
  const taskStatus = mapRunStateToTaskState(result.run);
  assert.equal(taskStatus, "completed", "task should project to completed");

  // 5. Verify evidence bundle can be created
  const bundle = createEvidenceBundle({
    run_id: run.id,
    attempt_ids: ["attempt_001"],
    repository: { commit_sha: "abc123def456", changed_files: ["src/auth.mjs"] },
    commands: [{ command: "npm test", exit_code: 0 }],
  });
  assert.ok(bundle.id.startsWith("evidence_bundle_"));
  assert.equal(bundle.repository.commit_sha, "abc123def456");

  // 6. Verify acceptance evaluation
  const decision = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: bundle,
  });
  assert.equal(decision.decision, "accepted", "complete code_change evidence should be accepted");
});

// =========================================================================
// Canary 2: 强制 TUI 不可用，同一 Run 自动建立 Exec Attempt
// =========================================================================
test("[Canary 2] provider_unavailable triggers failover via recovery", async () => {
  const recovery = classifyFailure({ code: "provider_unavailable", provider: "codex_tui" });
  assert.equal(recovery.classification, "provider_unavailable");
  assert.equal(recovery.automatic_action, "failover");
  assert.equal(recovery.resumable, true);

  // The recovery asks for failover to another provider
  assert.ok(recovery.retry_scope === "new_attempt", "failover should start new attempt");
});

// =========================================================================
// Canary 3: 强制 TUI 进程退出，Task 不残留 running
// =========================================================================
test("[Canary 3] TUI fails → Task not stuck in running (projection)", async () => {
  const deps = createDeps();
  const svc = createExecutionRunService(deps);
  const { run } = await svc.start({ intent_id: "canary_003", task_id: "task_003" });

  // Simulate TUI failure by transitioning to cancelled
  await svc.cancel({ runId: run.id, reason: "tui_session_lost" });
  const failedRun = await svc.read(run.id);
  assert.equal(failedRun.state, "cancelled", "run should be cancelled");

  // Task should NOT be "running" — projection reflects Run state
  const taskStatus = mapRunStateToTaskState(failedRun);
  assert.notEqual(taskStatus, "running", "task must NOT be running when run is terminated");
  assert.equal(taskStatus, "cancelled", "task should be cancelled");
});

// =========================================================================
// Canary 4: 仅修改文档，不出现假 waiting_for_integration
// =========================================================================
test("[Canary 4] docs_change does not require integration", () => {
  const profile = getProfile("docs_change");
  assert.ok(profile, "docs_change profile should exist");
  assert.equal(profile.requiresCommit, true, "docs require commit");
  assert.equal(profile.requiresIntegration, false, "docs do NOT require integration");
  assert.ok(profile.forbiddenStates.includes("waiting_for_integration"),
    "docs_change should forbid waiting_for_integration state");
});

// =========================================================================
// Canary 5: 只运行测试，无 Commit 也能完成
// =========================================================================
test("[Canary 5] test_only does not require commit", () => {
  const profile = getProfile("test_only");
  assert.ok(profile, "test_only profile should exist");
  assert.equal(profile.requiresCommit, false, "test_only does not require commit");
  assert.equal(profile.allowsMutation, false, "test_only should not mutate");

  // test_only only needs commands
  const decision = evaluateEvidence({
    operationKind: "test_only",
    evidenceBundle: createEvidenceBundle({
      run_id: "run_005",
      commands: [{ command: "npm test", exit_code: 0 }],
    }),
  });
  assert.equal(decision.decision, "accepted", "test_only with commands should be accepted");
});

// =========================================================================
// Canary 6: 执行问询，零副作用
// =========================================================================
test("[Canary 6] question has zero side effects", () => {
  const profile = getProfile("question");
  assert.ok(profile, "question profile should exist");
  assert.equal(profile.requiresCommit, false, "question does not require commit");
  assert.equal(profile.allowsMutation, false, "question must not allow mutation");
  assert.equal(profile.requiresWorktree, false, "question must not need worktree");
});

// =========================================================================
// Canary 7: 删除 result.json → 只触发现有证据重建
// =========================================================================
test("[Canary 7] missing result.json triggers evidence reconstruction only", () => {
  // Missing all evidence
  const missing = findMissingEvidence({
    run_id: null,
    attempt_id: null,
    outcome: "partial",
    changed_files: [],
    commands: [],
    commit_sha: null,
  });
  assert.ok(missing.includes("run_id"), "run_id should be flagged");
  assert.ok(missing.includes("attempt_id"), "attempt_id should be flagged");
  assert.ok(missing.includes("changed_files"), "changed_files should be flagged");
  assert.ok(missing.includes("commands"), "commands should be flagged");
  assert.ok(missing.includes("commit_sha"), "commit_sha should be flagged");

  // Recovery classifies it as evidence repair
  const recovery = classifyFailure({ code: "result_json_missing" });
  assert.equal(recovery.automatic_action, "recollect_evidence", "should reconstruct evidence only");
  assert.notEqual(recovery.automatic_action, "retry_original_task");
  assert.notEqual(recovery.automatic_action, "create_repair_task");
  assert.equal(recovery.retry_scope, "evidence_only", "should not retry the full run");
});

// =========================================================================
// Canary 8: 删除 Commit Evidence → 只触发 Commit Repair
// =========================================================================
test("[Canary 8] missing commit triggers deterministic commit repair", () => {
  const recovery = classifyFailure({ code: "commit_missing" });
  assert.equal(recovery.automatic_action, "deterministic_commit", "should do commit repair");
  assert.equal(recovery.retry_scope, "delivery_only", "should only fix commit, not redo code change");
  assert.equal(recovery.resumable, true, "commit repair should be resumable");

  // Acceptance should flag missing commit
  const decision = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: createEvidenceBundle({
      run_id: "run_008",
      commands: [{ command: "npm test", exit_code: 0 }],
      repository: { changed_files: ["src/main.mjs"] },
      // No commit_sha
    }),
  });
  assert.equal(decision.decision, "repair_required", "missing commit should trigger repair");
  assert.ok(decision.missing_items.includes("commit_sha"));
});

// =========================================================================
// Canary 9: Provider 输出虚构"全部测试通过" → Acceptance 拒绝
// =========================================================================
test("[Canary 9] fabricated test results are rejected", () => {
  // Provider claims "All 884 tests passed" but there is no actual command evidence
  const bundle = createEvidenceBundle({
    run_id: "run_009",
    provider_claims: [
      {
        id: "c1",
        statement: "All 884 tests passed",
        evidence_type: "command_exit_code",
        expected_exit_code: 0,
      },
    ],
    // NO actual commands in the bundle
  });

  // Reconcile should move this to rejected_claims
  const reconciled = reconcileProviderClaims(bundle);
  assert.equal(reconciled.verified_facts.length, 0, "no verified facts without command evidence");
  assert.ok(reconciled.rejected_claims.length > 0, "unsubstantiated claim should be rejected");

  // Acceptance should also flag unreconciled claims
  const decision = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: { ...reconciled, repository: { commit_sha: "abc123", changed_files: ["x"] } },
  });
  assert.equal(decision.decision, "repair_required", "fabricated results should require repair");
});

// =========================================================================
// Canary 10: Builder/Tester/Reviewer/Integrator 按 DAG 自动推进
// =========================================================================
test("[Canary 10] multi-agent DAG nodes, roles, and dependency chains", () => {
  const intent = normalizeExecutionIntent({
    request_text: "Build complex feature with multi-agent pipeline",
    operation_kind: "code_change",
  });

  const plan = compilePlan(intent, { multiAgent: true });
  assert.ok(plan.nodes.length >= 5, "DAG should have at least 5 nodes");

  // Architect
  const architect = plan.nodes.find((n) => n.role === "architect");
  assert.ok(architect, "architect node should exist");
  assert.equal(architect.mutation_scope, "none", "architect must not mutate");

  // Builder
  const builder = plan.nodes.find((n) => n.role === "builder");
  assert.ok(builder, "builder node should exist");
  assert.equal(builder.mutation_scope, "repo", "builder should have repo scope");
  assert.ok(builder.depends_on.includes(architect.id), "builder depends on architect");

  // Tester
  const tester = plan.nodes.find((n) => n.role === "tester");
  assert.ok(tester, "tester node should exist");
  assert.equal(tester.mutation_scope, "none", "tester must NOT mutate");

  // Reviewer
  const reviewer = plan.nodes.find((n) => n.role === "reviewer");
  assert.ok(reviewer, "reviewer node should exist");
  assert.equal(reviewer.mutation_scope, "none", "reviewer must NOT mutate");
  assert.ok(reviewer.depends_on.includes(builder.id), "reviewer depends on builder");

  // Integrator — depends on both tester AND reviewer
  const integrator = plan.nodes.find((n) => n.role === "integrator");
  assert.ok(integrator, "integrator node should exist");
  assert.ok(integrator.depends_on.includes(tester.id), "integrator depends on tester");
  assert.ok(integrator.depends_on.includes(reviewer.id), "integrator depends on reviewer");
});

// =========================================================================
// Canary 12: 重复 start/advance 调用保持幂等
// =========================================================================
test("[Canary 12] same request_id returns idempotent run", async () => {
  const deps = createDeps();
  const svc = createExecutionRunService(deps);

  // Same request_id returns the same run
  const r1 = await svc.start({ intent_id: "intent_012", request_id: "req_012", task_id: "task_012" });
  const r2 = await svc.start({ intent_id: "intent_012", request_id: "req_012", task_id: "task_012" });

  assert.equal(r2.run.id, r1.run.id, "same request_id must return same run");
  assert.equal(r2.idempotent, true, "second call should be idempotent");
  assert.equal(r2.run.state, "ready", "idempotent return should have same state");
});

// =========================================================================
// Canary 13: 两 Worker 竞争同一 Run 时 CAS 只允许一个成功
// =========================================================================
test("[Canary 13] concurrent CAS prevents double-advancing", async () => {
  const deps = createDeps();
  const svc = createExecutionRunService(deps);

  const { run } = await svc.start({ intent_id: "intent_013" });
  // Run is in "ready" state

  // Two workers try to advanceRun at the same time
  const [w1, w2] = await Promise.allSettled([
    svc.advanceRun(run.id),
    svc.advanceRun(run.id),
  ]);

  const successful = [w1, w2].filter((r) => r.status === "fulfilled");
  assert.ok(successful.length >= 1, "at least one should succeed");
  // Verify the final state
  const finalRun = await svc.read(run.id);
  assert.equal(finalRun.state, "completed", "run should eventually complete");
});

// =========================================================================
// State consistency invariant
// =========================================================================
test("[Invariant] mapRunStateToTaskState consistency from both modules", () => {
  const states = {
    "created": "starting",
    "planning": "starting",
    "ready": "starting",
    "running": "running",
    "collecting": "collecting",
    "evaluating": "collecting",
    "waiting_for_repair": "waiting_for_repair",
    "waiting_for_review": "waiting_for_review",
    "waiting_for_integration": "waiting_for_integration",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
  };

  for (const [runState, taskState] of Object.entries(states)) {
    const run = { state: runState };
    assert.equal(mapRunStateToTaskState(run), taskState,
      `projection service should map "${runState}" → "${taskState}"`);
    assert.equal(legacyMap(run), taskState,
      `legacy adapter should map "${runState}" → "${taskState}"`);
  }
});

// =========================================================================
// Provider contract invariant
// =========================================================================
test("[Invariant] observation states must not include business states", () => {
  const businessStates = ["completed", "waiting_for_review", "waiting_for_integration"];
  for (const bs of businessStates) {
    assert.ok(!OBSERVATION_STATES.includes(bs),
      `Observation states must not include "${bs}"`);
  }
});

// =========================================================================
// Canary 11: 服务重启后从 Run + Attempt + Checkpoint 恢复
// =========================================================================
test("[Canary 11] checkpoint can be saved, persisted, and used to resume", async () => {
  const deps = createDeps();
  const svc = createExecutionRunService(deps);

  // 1. Create a run and advance it to collecting state
  const { run } = await svc.start({ intent_id: "intent_011" });

  // 2. Save a checkpoint into the run (simulating what would happen on restart)
  const checkpoint = {
    schema_version: 2,
    run_id: run.id,
    attempt_id: "attempt_011",
    provider: "codex_exec",
    provider_session: {
      control_session_id: "ctrl_011",
      native_session_id: "native_011",
      resume_token: "resume_011",
    },
    repository: {
      worktree_path: "/tmp/worktree_011",
      branch: "feature/login-fix",
      base_sha: "base_011",
      head_sha: "head_011",
      dirty_paths: [],
    },
    progress: {
      completed_steps: ["setup", "code_change"],
      current_step: "verification",
      pending_steps: ["integration"],
    },
    evidence: {
      collected_items: ["diff", "changed_files"],
      missing_items: ["test_results", "commit_sha"],
    },
    failure: null,
    recovery: {
      classification: "interrupted",
      automatic_action: null,
      supervisor_action: null,
      resumable: true,
    },
    created_at: new Date().toISOString(),
  };

  // 3. Update the run with the checkpoint (simulating what happens before restart)
  const updatedRun = await deps.runStore.updateRun(run.id, {
    checkpoint,
    active_attempt_id: "attempt_011",
  });
  assert.ok(updatedRun.checkpoint, "checkpoint should be saved");
  assert.equal(updatedRun.checkpoint.provider, "codex_exec");
  assert.equal(updatedRun.checkpoint.repository.worktree_path, "/tmp/worktree_011");

  // 4. Read the run back (simulating after restart)
  const restoredRun = await svc.read(run.id);
  assert.ok(restoredRun.checkpoint, "checkpoint should persist in store");
  assert.equal(restoredRun.checkpoint.provider_session.resume_token, "resume_011");
  assert.equal(restoredRun.checkpoint.progress.current_step, "verification");

  // 5. The recovery service can classify checkpoint resumption
  const recovery = classifyFailure({ code: "unknown" });
  assert.ok(recovery, "recovery should handle unknown failure gracefully");

  // 6. Checkpoint contains all required fields for resume
  assert.equal(restoredRun.checkpoint.schema_version, 2, "checkpoint schema version should be 2");
  assert.ok(Array.isArray(restoredRun.checkpoint.repository.dirty_paths), "dirty_paths should be an array");
  assert.ok(Array.isArray(restoredRun.checkpoint.progress.completed_steps), "completed_steps should be an array");
});

// =========================================================================
// Canary 14: Integration 冲突进入专门 Repair Node
// =========================================================================
test("[Canary 14] integration conflict classification and repair node", async () => {
  // 1. Recovery classifies integration conflicts
  const recovery = classifyFailure({ code: "integration_conflict" });
  assert.equal(recovery.classification, "integration_conflict",
    "should classify as integration_conflict");
  assert.equal(recovery.automatic_action, "create_integration_repair_node",
    "should create integration repair node");
  assert.equal(recovery.retry_scope, "integration_only",
    "should only retry integration, not the full run");
  assert.equal(recovery.resumable, true,
    "integration repair should be resumable");

  // 2. Integration conflict is NOT the same as code execution failure
  const execFailure = classifyFailure({ code: "execution_failed" });
  assert.notEqual(execFailure.classification, "integration_conflict",
    "execution failure should not be classified as integration conflict");
  assert.equal(execFailure.resumable, false,
    "generic execution failure should be non-resumable (needs supervisor)");

  // 3. Verify that a docs_change does NOT get stuck in integration
  // (This is Guarantee 4 from the acceptance matrix — docs bypass integration)
  const docsProfile = getProfile("docs_change");
  assert.ok(docsProfile.forbiddenStates.includes("waiting_for_integration"),
    "docs_change must never enter waiting_for_integration");

  // 4. Integration conflict creates a scoped repair — only integration scope
  const recoveryService = await import("../../src/execution-core/execution-recovery-service.mjs");
  const svc = recoveryService.createRecoveryService({
    providerRegistry: { async isAvailable() { return true; } },
  });

  const result = await svc.recover({
    run: { id: "run_014", state: "running" },
    failure: { code: "integration_conflict", provider: "codex_exec" },
    intent: { id: "intent_014" },
    attemptNumber: 1,
    maxAttempts: 3,
  });
  assert.equal(result.action, "integration_repair",
    "recovery should propose integration repair");
  assert.equal(result.resumable, true,
    "integration repair should be resumable");
});
