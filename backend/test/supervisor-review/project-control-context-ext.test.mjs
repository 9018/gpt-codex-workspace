/**
 * project-control-context-ext.test.mjs — Tests for assertChatGPTDirectControl
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertChatGPTDirectControl, ProjectControlInvariantError } from "../../src/tool-groups/project-control/project-control-context.mjs";

test("passes when all invariants satisfied", () => {
  const run = {
    id: "run_1", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
    workspace_ref: { worktree_path: "/home/user/project" },
  };
  const lease = { owner: "chatgpt_direct", epoch: 3 };
  const result = assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 3, run, lease });
  assert.ok(result.valid);
});

test("rejects when run state is not chatgpt_direct", () => {
  const run = {
    id: "run_1", state: "running",
    supervision: { controller_owner: "codex_active", controller_epoch: 0 },
  };
  assert.throws(
    () => assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 0, run, lease: { owner: "codex_active", epoch: 0 } }),
    /chatgpt_direct/
  );
});

test("rejects when lease owner is not chatgpt_direct", () => {
  const run = {
    id: "run_1", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 0 },
  };
  assert.throws(
    () => assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 0, run, lease: { owner: "codex_active", epoch: 0 } }),
    /Lease owner/
  );
});

test("rejects when controller epoch mismatch", () => {
  const run = {
    id: "run_1", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
    workspace_ref: { worktree_path: "/home/user/project" },
  };
  const lease = { owner: "chatgpt_direct", epoch: 3 };
  assert.throws(
    () => assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 5, run, lease }),
    /epoch/
  );
});

test("rejects when requested path is outside worktree", () => {
  const run = {
    id: "run_1", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
    workspace_ref: { worktree_path: "/home/user/project" },
  };
  const lease = { owner: "chatgpt_direct", epoch: 3 };
  assert.throws(
    () => assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 3, run, lease, requestedPath: "/etc/passwd" }),
    /outside the worktree/
  );
});

test("allows path inside worktree", () => {
  const run = {
    id: "run_1", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
    workspace_ref: { worktree_path: "/home/user/project" },
  };
  const lease = { owner: "chatgpt_direct", epoch: 3 };
  const result = assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 3, run, lease, requestedPath: "/home/user/project/src/x.mjs" });
  assert.ok(result.valid);
});

test("rejects when runId does not match run.id", () => {
  const run = {
    id: "run_2", state: "chatgpt_direct",
    supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
    workspace_ref: { worktree_path: "/home/user/project" },
  };
  const lease = { owner: "chatgpt_direct", epoch: 3 };
  assert.throws(
    () => assertChatGPTDirectControl({ runId: "run_1", controllerEpoch: 3, run, lease }),
    /id mismatch/
  );
});
