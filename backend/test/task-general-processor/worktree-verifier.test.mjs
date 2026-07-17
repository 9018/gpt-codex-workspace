import test from "node:test";
import assert from "node:assert/strict";

import { verifyRealTaskWorktree } from "../../src/task-processing/task-worktree-verifier.mjs";

test("rejects lifecycle metadata that is not a verified git worktree", async () => {
  const result = await verifyRealTaskWorktree({
    resolvedRepo: { worktree_lifecycle: { ok: false, mode: "planned", error: "not materialized" } },
    plan: {},
  });
  assert.deepEqual(result, { valid: false, error: "not materialized" });
});
