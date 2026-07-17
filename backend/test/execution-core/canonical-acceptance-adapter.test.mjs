import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalAcceptanceAdapter } from "../../src/execution-core/canonical-acceptance-adapter.mjs";
test("accepts when evidence is complete", async () => {
  const adapter = createCanonicalAcceptanceAdapter();
  const result = await adapter.evaluate({
    run: { id: "run_001", state: "evaluating" },
    evidence: { provider_claims: [], tests: [] },
  });
  assert.equal(result.decision, "accepted");
  assert.equal(result.canonical, true);
});
test("rejects when evidence has missing items", async () => {
  const adapter = createCanonicalAcceptanceAdapter();
  const result = await adapter.evaluate({
    run: { id: "run_001" },
    evidence: { missing_items: ["commit_sha"], provider_claims: [], tests: [] },
  });
  assert.equal(result.decision, "repair_required");
});
test("rejects when no evidence exists", async () => {
  const adapter = createCanonicalAcceptanceAdapter();
  const result = await adapter.evaluate({ run: { id: "run_001" } });
  assert.equal(result.decision, "repair_required");
  assert.equal(result.canonical, false);
});
test("passes through unified decision when available", async () => {
  const adapter = createCanonicalAcceptanceAdapter({
    unifiedDecisionService: {
      async evaluate({ taskId, goalId, evidence, runState }) {
        return { decision: "accept", summary: "All checks passed", id: "ud_001" };
      },
    },
  });
  const result = await adapter.evaluate({
    run: { id: "run_001", task_id: "task_001", state: "evaluating" },
    evidence: { provider_claims: [], tests: [] },
  });
  assert.equal(result.decision, "accepted");
  assert.equal(result.id, "ud_001");
  assert.equal(result.canonical, true);
});
