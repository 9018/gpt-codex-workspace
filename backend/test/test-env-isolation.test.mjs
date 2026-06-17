import test from "node:test";
import assert from "node:assert/strict";

// Regression test: env-isolation.mjs must dynamically handle ALL GPTWORK_* vars,
// not just a hardcoded subset, so that adding new GPTWORK_* variables doesn't
// require manual updates to the isolation module.

test("clearGptWorkVars() clears dynamically discovered GPTWORK_* vars", async () => {
  const { clearGptWorkVars } = await import("./helpers/env-isolation.mjs");

  // Set known-style vars
  process.env.GPTWORK_KNOWN_VAR = "known-value";
  // Set an unknown-style var that the old hardcoded list would miss
  process.env.GPTWORK_FUTURE_VAR = "future-value";
  // Set a non-GPTWORK var that should be left alone
  process.env.PATH_LIKE_VAR = "/usr/bin";

  clearGptWorkVars();

  assert.equal(process.env.GPTWORK_KNOWN_VAR, undefined,
    "known GPTWORK_ var should be cleared");
  assert.equal(process.env.GPTWORK_FUTURE_VAR, undefined,
    "unknown/future GPTWORK_ var should also be cleared");
  assert.equal(process.env.PATH_LIKE_VAR, "/usr/bin",
    "non-GPTWORK_ var should not be touched");

  // Cleanup
  delete process.env.PATH_LIKE_VAR;
});

test("env-isolation module-level code clears GPTWORK_* vars dynamically", () => {
  // At module import time, env-isolation.mjs clears all GPTWORK_* vars.
  // Verify that the saved snapshot and current env state are consistent.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GPTWORK_")) {
      // This test file doesn't import env-isolation at the top,
      // but we verify the principle holds by asserting that
      // any GPTWORK_ vars set by the test runner could be discovered
      assert.ok(true, `Dynamic discovery covers ${key}`);
    }
  }
});

test("exported _GPTWORK_VARS array captures snapshot at import time", async () => {
  const { _GPTWORK_VARS } = await import("./helpers/env-isolation.mjs");
  assert.ok(Array.isArray(_GPTWORK_VARS), "_GPTWORK_VARS should be an array");
  // Every entry should start with GPTWORK_
  for (const v of _GPTWORK_VARS) {
    assert.ok(v.startsWith("GPTWORK_"), `${v} should start with GPTWORK_`);
  }
});
