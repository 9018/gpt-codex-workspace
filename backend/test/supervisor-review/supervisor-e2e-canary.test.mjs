/**
 * supervisor-e2e-canary.test.mjs — End-to-end supervisor review canaries.
 *
 * @module test/supervisor-review/supervisor-e2e-canary
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildReviewRevision } from "../../src/supervisor-review/supervisor-review-revision.mjs";
import { createSupervisorReviewPacket } from "../../src/supervisor-review/supervisor-review-packet-schema.mjs";
import { normalizeSupervisorDecision, DECISION_ACTIONS } from "../../src/supervisor-review/supervisor-decision-schema.mjs";
import { commandFromDecision } from "../../src/supervisor-review/supervisor-command-schema.mjs";
import { createCommandStore } from "../../src/supervisor-review/supervisor-command-store.mjs";
import { createReviewRequestStore } from "../../src/supervisor-review/supervisor-review-request-store.mjs";
import { createActionGuard } from "../../src/supervisor-review/supervisor-action-guard.mjs";
import { createReviewCoordinator } from "../../src/supervisor-review/review-coordinator.mjs";

const facts = {
  run: { id: "run_1", version: 3, acceptance_contract_digest: "acc123" },
  checkpoint: { id: "cp_1", digest: "cp_digest_1" },
  repository: {
    base_sha: "abc123", head_sha: "def456", diff_digest: "diff_abc",
    dirty_paths: ["src/x.mjs"],
  },
  contextManifest: { digest: "ctx_1" },
  supervisorPlan: { version: 1 },
};

const run = {
  id: "run_1", version: 3, state: "running",
  supervision: { controller_owner: "codex_active", correction_cycles: 0 },
  workspace_ref: { worktree_path: "/home/user/project" },
};

function sharedStore() {
  const d = { commands: [], requests: [], decisions: [] };
  return {
    load: async () => d,
    mutate: async (fn) => { fn(d); },
  };
}

// ---------------------------------------------------------------------------
// Canary A: continue_codex → no command side effect
// ---------------------------------------------------------------------------

test("[Canary A] continue_codex → no command side effect", () => {
  const rev = buildReviewRevision(facts);
  const packet = createSupervisorReviewPacket({ run: facts.run, revision: rev, repository: facts.repository });
  const decision = normalizeSupervisorDecision({
    run_id: "run_1", review_revision_id: rev.id, verdict: "aligned", action: "continue_codex",
  });
  assert.equal(decision.action, "continue_codex");
  assert.equal(decision.correction, null);

  const cmd = commandFromDecision(decision, run);
  assert.equal(cmd.action, "continue_codex");
});

// ---------------------------------------------------------------------------
// Canary B: send_correction creates one unique command
// ---------------------------------------------------------------------------

test("[Canary B] send_correction → one unique command created", async () => {
  const store = createCommandStore({ stateStore: sharedStore() });
  const rev = buildReviewRevision(facts);
  const decision = normalizeSupervisorDecision({
    run_id: "run_1", review_revision_id: rev.id, verdict: "minor_drift",
    action: "send_correction",
    correction: { objective: "Fix drift", required_changes: ["Refactor X"] },
  });
  const cmd = commandFromDecision(decision, run);
  assert.equal(cmd.action, "send_correction");
  assert.equal(cmd.idempotency_key, `run_1:${rev.id}:send_correction`);

  const stored = await store.createFromDecision(decision, run);
  assert.equal(stored.idempotency_key, `run_1:${rev.id}:send_correction`);
  assert.equal(stored.status, "pending");

  const claimed = await store.claimNext({ workerId: "w1" });
  assert.ok(claimed);
  assert.equal(claimed.status, "claimed");
});

// ---------------------------------------------------------------------------
// Canary C: same revision → request deduplicated
// ---------------------------------------------------------------------------

test("[Canary C] same revision → request deduplicated", async () => {
  const requestStore = createReviewRequestStore();
  const coordinator = createReviewCoordinator({
    reviewPacketBuilder: {
      build: async () => createSupervisorReviewPacket({
        run: facts.run,
        revision: buildReviewRevision(facts),
        repository: facts.repository,
      }),
    },
    reviewRequestStore: requestStore,
  });

  const r1 = await coordinator.tick("run_1");
  assert.equal(r1.review_required, true);

  // Same revision → same request returned (dedup), no new review needed
  const r2 = await coordinator.tick("run_1");
  assert.equal(r2.request.id, r1.request.id);
  assert.ok(r2.skipped_reason);
});

// ---------------------------------------------------------------------------
// Canary D: stale revision → action guard rejects
// ---------------------------------------------------------------------------

test("[Canary D] stale revision → action guard rejects", () => {
  const guard = createActionGuard();
  const result = guard.validateCommand({
    command: {
      id: "cmd_stale", run_id: "run_1", review_revision_id: "rev_old",
      action: "send_correction", payload: {},
      preconditions: { expected_controller_owner: "codex_active", expected_run_version: 3 },
    },
    run, lease: { owner: "codex_active", epoch: 0 },
    currentRevision: { id: "rev_current" },
    plan: { autonomy_budget: { max_corrections: 5 } },
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Canary E: invalid decision action is rejected
// ---------------------------------------------------------------------------

test("[Canary E] invalid action rejected in normalization", () => {
  assert.throws(
    () => normalizeSupervisorDecision({
      run_id: "run_1", review_revision_id: "rev_001", verdict: "aligned", action: "invalid_action",
    }),
    /invalid action/
  );
});
