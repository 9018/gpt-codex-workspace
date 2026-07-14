import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("acceptance-contract-full-mode", () => {
  it("mode is always full regardless of input", async () => {
    const { buildAcceptanceContract } = await import("../src/acceptance/contract-builder.mjs");

    const c1 = buildAcceptanceContract({});
    assert.equal(c1.mode, "full");

    const c2 = buildAcceptanceContract({ mode: "readonly" });
    assert.equal(c2.mode, "full");

    const c3 = buildAcceptanceContract({ mode: "implementation" });
    assert.equal(c3.mode, "full");
  });

  it("execution_mode is always full in intent", async () => {
    const { buildAcceptanceContract } = await import("../src/acceptance/contract-builder.mjs");

    const c = buildAcceptanceContract({});
    assert.equal(c.intent.execution_mode, "full");
  });

  it("retry_policy and acceptance_policy are present", async () => {
    const { buildAcceptanceContract } = await import("../src/acceptance/contract-builder.mjs");

    const c = buildAcceptanceContract({});
    assert.ok(c.retry_policy, "retry_policy should be present");
    assert.equal(typeof c.retry_policy.max_attempts, "number");
    assert.ok(c.acceptance_policy, "acceptance_policy should be present");
  });

  it("required_checks is an array", async () => {
    const { buildAcceptanceContract } = await import("../src/acceptance/contract-builder.mjs");

    const c = buildAcceptanceContract({});
    assert.ok(Array.isArray(c.required_checks));
  });
});

it('schema and every contract profile expose only full execution mode', async () => {
  const { EXECUTION_MODES } = await import('../src/acceptance/contract-schema.mjs');
  const { ACCEPTANCE_CONTRACT_PROFILES } = await import('../src/acceptance/contract-profiles.mjs');
  assert.deepEqual([...EXECUTION_MODES], ['full']);
  for (const [name, profile] of Object.entries(ACCEPTANCE_CONTRACT_PROFILES)) {
    assert.equal(profile.intent.execution_mode, 'full', name);
  }
});
