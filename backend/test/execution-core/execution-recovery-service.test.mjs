import test from "node:test";
import assert from "node:assert/strict";

import { createRecoveryService, classifyFailure } from "../../src/execution-core/execution-recovery-service.mjs";

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

test("classifies provider_unavailable", () => {
  const r = classifyFailure({ code: "provider_unavailable", provider: "codex_tui" });
  assert.equal(r.classification, "provider_unavailable");
  assert.equal(r.automatic_action, "failover");
  assert.equal(r.retry_scope, "new_attempt");
  assert.equal(r.resumable, true);
});

test("classifies session binding missing", () => {
  const r = classifyFailure({ code: "native_session_binding_missing" });
  assert.equal(r.classification, "session_missing");
  assert.equal(r.automatic_action, "rebind_session");
  assert.equal(r.resumable, true);
});

test("classifies result_json_missing", () => {
  const r = classifyFailure({ code: "result_json_missing" });
  assert.equal(r.classification, "evidence_missing");
  assert.equal(r.automatic_action, "recollect_evidence");
  assert.equal(r.retry_scope, "evidence_only");
  assert.equal(r.resumable, true);
});

test("classifies commit_missing", () => {
  const r = classifyFailure({ code: "commit_missing" });
  assert.equal(r.classification, "evidence_missing");
  assert.equal(r.automatic_action, "deterministic_commit");
  assert.equal(r.retry_scope, "delivery_only");
});

test("classifies worktree_dirty_unexpected", () => {
  const r = classifyFailure({ code: "worktree_dirty_unexpected" });
  assert.equal(r.classification, "workspace_dirty");
  assert.equal(r.automatic_action, "classify_and_clean_worktree");
  assert.equal(r.retry_scope, "workspace_only");
});

test("classifies integration_conflict", () => {
  const r = classifyFailure({ code: "integration_conflict" });
  assert.equal(r.classification, "integration_conflict");
  assert.equal(r.automatic_action, "create_integration_repair_node");
  assert.equal(r.retry_scope, "integration_only");
});

test("classifies context_stale", () => {
  const r = classifyFailure({ code: "context_stale" });
  assert.equal(r.classification, "context_stale");
  assert.equal(r.automatic_action, "rebuild_context");
});

test("classifies attempt_budget_exhausted as non-resumable", () => {
  const r = classifyFailure({ code: "attempt_budget_exhausted" });
  assert.equal(r.resumable, false);
  assert.equal(r.automatic_action, "supervisor_required");
});

test("classifies unknown code as non-resumable", () => {
  const r = classifyFailure({ code: "some_unknown_error" });
  assert.equal(r.resumable, false);
  assert.equal(r.automatic_action, "supervisor_required");
});

test("classifies null as unknown", () => {
  const r = classifyFailure(null);
  assert.equal(r.classification, "unknown");
});

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

test("recover with not-terminal classification returns supervisor_required for exhausted budget", async () => {
  const svc = createRecoveryService();
  const result = await svc.recover({
    run: { id: "run_001" },
    failure: { code: "result_json_missing" },
    attemptNumber: 5,
    maxAttempts: 3,
  });
  // Even though result_json_missing is resumable, budget is exhausted
  assert.equal(result.action, "supervisor_required");
  assert.equal(result.resumable, false);
});

test("recover performs failover between providers", async () => {
  let availCheckCount = 0;
  const svc = createRecoveryService({
    providerRegistry: {
      async isAvailable(name) {
        availCheckCount++;
        return true;
      },
    },
  });

  const result = await svc.recover({
    run: { id: "run_001" },
    failure: { code: "provider_unavailable", provider: "codex_tui" },
    intent: {},
    attemptNumber: 1,
    maxAttempts: 3,
  });

  assert.equal(result.action, "failover");
  assert.equal(result.next_provider, "codex_exec", "should failover from codex_tui to codex_exec");
  assert.equal(result.next_attempt, true);
  assert.equal(availCheckCount, 1);
});

test("recover with recollect_evidence returns appropriate action", async () => {
  const svc = createRecoveryService();
  const result = await svc.recover({
    run: { id: "run_001" },
    failure: { code: "result_json_missing", provider: "codex_exec" },
    intent: {},
    attemptNumber: 1,
    maxAttempts: 3,
  });

  assert.equal(result.action, "recollect_evidence");
  assert.equal(result.resumable, true);
  assert.equal(result.next_attempt, false);
});

test("recover with deterministic_commit", async () => {
  const svc = createRecoveryService();
  const result = await svc.recover({
    run: { id: "run_001" },
    failure: { code: "commit_missing" },
    attemptNumber: 1,
    maxAttempts: 3,
  });

  assert.equal(result.action, "deterministic_commit");
  assert.equal(result.resumable, true);
});
