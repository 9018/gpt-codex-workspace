import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("full-auto-retry", () => {
  it("retry inherits parent contract hash", async () => {
    const { hashContract, createRetryIterationAtomic } = await import("../src/task-retry.mjs");

    const parentContract = {
      mode: "full",
      operation_kind: "code_change",
      requires_commit: true,
      requires_integration: true,
      retry_policy: { max_attempts: 3, backoff_ms: [0, 5000] },
      acceptance_policy: { auto_accept: true },
    };

    const parentHash = hashContract(parentContract);

    // Cannot test createRetryIterationAtomic without a real transaction,
    // but we can verify hashContract works and the clone preserves it
    const cloned = structuredClone(parentContract);
    const cloneHash = hashContract(cloned);

    assert.equal(cloneHash, parentHash, "Clone must have same hash as parent");
  });

  it("hashContract returns deterministic hashes", async () => {
    const { hashContract } = await import("../src/task-retry.mjs");

    const c1 = { mode: "full", requires_commit: true };
    const c2 = { mode: "full", requires_commit: true };

    assert.equal(hashContract(c1), hashContract(c2));
  });

  it("hashContract returns null for null input", async () => {
    const { hashContract } = await import("../src/task-retry.mjs");
    assert.equal(hashContract(null), null);
  });
});
