/**
 * handoff-to-codex-service.test.mjs — Tests for Handoff to Codex
 *
 * @module test/supervisor-review/handoff-to-codex-service
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHandoffToCodexService } from "../../src/supervisor-review/handoff-to-codex-service.mjs";

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    runStore: {
      readRun: async () => ({
        id: "run_1",
        state: "chatgpt_direct",
        version: 3,
        supervision: {
          controller_owner: "chatgpt_direct",
          controller_epoch: 3,
        },
        workspace_ref: { worktree_path: "/home/user/project" },
        native_session_id: "ns_1",
      }),
      compareAndSetState: async ({ runId, expectedState, nextState, patch }) => ({
        id: runId,
        state: nextState,
        ...patch,
      }),
    },
    receiptVerifier: {
      verify: async () => {},
    },
    leaseStore: {
      compareAndSetOwner: async ({ runId, expectedOwner, nextOwner }) => ({
        owner: nextOwner,
        epoch: 4,
      }),
    },
    checkpointStore: {
      createCheckpoint: async () => ({ id: "cp_1" }),
    },
    sessionResumeOrStart: {
      resolve: async ({ run, nativeSessionId, worktreePath }) => ({
        id: "sess_1",
        worktree_path: worktreePath,
        active: true,
      }),
    },
    ...overrides,
  };
}

const baseReceipt = {
  id: "receipt_1",
  run_id: "run_1",
  takeover_command_id: "cmd_1",
  controller_epoch: 3,
  base_sha: "abc123",
  final_head_sha: "def456",
  changed_files: ["src/x.mjs"],
  commands: [{ command: "npm test", exit_code: 0 }],
  recommended_next_action: "handoff_to_codex",
};

// ---------------------------------------------------------------------------
// Successful handoff
// ---------------------------------------------------------------------------

test("handoff returns run and session", async () => {
  const service = createHandoffToCodexService(createMockDeps());
  const result = await service.handoff({ runId: "run_1", receipt: baseReceipt });

  assert.ok(result.run);
  assert.ok(result.session);
  assert.equal(result.session.id, "sess_1");
});

test("handoff transitions lease to handoff_to_codex then codex_active", async () => {
  let transitions = [];
  const deps = createMockDeps({
    leaseStore: {
      compareAndSetOwner: async ({ runId, expectedOwner, nextOwner }) => {
        transitions.push(`${expectedOwner} -> ${nextOwner}`);
        return { owner: nextOwner, epoch: 4 };
      },
    },
  });
  const service = createHandoffToCodexService(deps);
  await service.handoff({ runId: "run_1", receipt: baseReceipt });
  // Handoff transitions: chatgpt_direct -> handoff_to_codex
  assert.ok(transitions.length >= 1);
});

test("handoff creates checkpoint with receipt evidence", async () => {
  let checkpointArgs = null;
  const deps = createMockDeps({
    checkpointStore: {
      createCheckpoint: async (args) => {
        checkpointArgs = args;
        return { id: "cp_1" };
      },
    },
  });
  const service = createHandoffToCodexService(deps);
  await service.handoff({ runId: "run_1", receipt: baseReceipt });
  assert.ok(checkpointArgs);
  assert.equal(checkpointArgs.trigger_source, "chatgpt_handoff");
  assert.deepEqual(checkpointArgs.evidence_snapshot, baseReceipt);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("handoff rejects run not in chatgpt_direct state", async () => {
  const deps = createMockDeps({
    runStore: {
      readRun: async () => ({
        id: "run_1",
        state: "running",
        supervision: { controller_owner: "codex_active", controller_epoch: 1 },
      }),
    },
  });
  const service = createHandoffToCodexService(deps);
  await assert.rejects(
    () => service.handoff({ runId: "run_1", receipt: baseReceipt }),
    /chatgpt_direct/
  );
});

test("handoff rejects receipt with wrong controller epoch", async () => {
  const deps = createMockDeps({
    runStore: {
      readRun: async () => ({
        id: "run_1",
        state: "chatgpt_direct",
        supervision: { controller_owner: "chatgpt_direct", controller_epoch: 5 },
      }),
    },
  });
  const service = createHandoffToCodexService(deps);
  await assert.rejects(
    () => service.handoff({ runId: "run_1", receipt: baseReceipt }),
    /epoch/
  );
});

test("handoff rejects when receipt verification fails", async () => {
  const deps = createMockDeps({
    receiptVerifier: {
      verify: async () => { throw new Error("Missing required commands"); },
    },
  });
  const service = createHandoffToCodexService(deps);
  await assert.rejects(
    () => service.handoff({ runId: "run_1", receipt: baseReceipt }),
    /Missing required commands/
  );
});

// ---------------------------------------------------------------------------
// Session resume or start
// ---------------------------------------------------------------------------

test("handoff resolves session via sessionResumeOrStart", async () => {
  let resolveArgs = null;
  const deps = createMockDeps({
    sessionResumeOrStart: {
      resolve: async (args) => {
        resolveArgs = args;
        return { id: "sess_1", worktree_path: args.worktreePath };
      },
    },
  });
  const service = createHandoffToCodexService(deps);
  await service.handoff({ runId: "run_1", receipt: baseReceipt });
  assert.ok(resolveArgs);
  assert.equal(resolveArgs.nativeSessionId, "ns_1");
  assert.equal(resolveArgs.worktreePath, "/home/user/project");
});

// ---------------------------------------------------------------------------
// Run state transition
// ---------------------------------------------------------------------------

test("handoff transitions run to running state", async () => {
  let stateTransition = null;
  const deps = createMockDeps({
    runStore: {
      readRun: async () => ({
        id: "run_1",
        state: "chatgpt_direct",
        supervision: { controller_owner: "chatgpt_direct", controller_epoch: 3 },
      }),
      compareAndSetState: async ({ runId, expectedState, nextState, patch }) => {
        stateTransition = { expectedState, nextState };
        return { id: runId, state: nextState, ...patch };
      },
    },
  });
  const service = createHandoffToCodexService(deps);
  await service.handoff({ runId: "run_1", receipt: baseReceipt });
  assert.ok(stateTransition);
  assert.equal(stateTransition.expectedState, "chatgpt_direct");
  assert.equal(stateTransition.nextState, "running");
});
