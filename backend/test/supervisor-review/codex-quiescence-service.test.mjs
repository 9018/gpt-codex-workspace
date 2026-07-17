/**
 * codex-quiescence-service.test.mjs — Tests for Quiescence Service
 *
 * @module test/supervisor-review/codex-quiescence-service
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCodexQuiescenceService, WorktreeStillChangingError } from "../../src/supervisor-review/codex-quiescence-service.mjs";

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  let leaseEpoch = 0;
  return {
    leaseStore: {
      compareAndSetOwner: async ({ runId, expectedOwner, nextOwner }) => {
        leaseEpoch++;
        return { owner: nextOwner, epoch: leaseEpoch };
      },
    },
    repositorySnapshot: {
      capture: async () => ({
        diff_digest: "stable_digest",
        head_sha: "abc123",
      }),
    },
    provider: {
      interrupt: async () => {},
    },
    processProbe: {
      waitForNoWriter: async () => {},
    },
    clock: {
      sleep: async () => {},
    },
    checkpointService: {
      createTakeoverCheckpoint: async () => ({ id: "cp_1" }),
    },
    ...overrides,
    _getLeaseEpoch: () => leaseEpoch,
  };
}

const baseRun = {
  id: "run_1",
  active_attempt_id: "attempt_1",
  workspace_ref: { worktree_path: "/home/user/project" },
};

const baseCommand = {
  id: "cmd_1",
  payload: { reason: "Takeover needed", required_changes: ["Fix X"] },
};

// ---------------------------------------------------------------------------
// Successful quiesce
// ---------------------------------------------------------------------------

test("quiesce transitions lease codex_active -> codex_quiescing -> chatgpt_supervising", async () => {
  let transitions = [];
  const deps = createMockDeps({
    leaseStore: {
      compareAndSetOwner: async ({ runId, expectedOwner, nextOwner }) => {
        transitions.push(`${expectedOwner} -> ${nextOwner}`);
        return { owner: nextOwner, epoch: transitions.length };
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  await service.quiesce({ run: baseRun, command: baseCommand });

  assert.equal(transitions.length, 2);
  assert.equal(transitions[0], "codex_active -> codex_quiescing");
  assert.equal(transitions[1], "codex_quiescing -> chatgpt_supervising");
});

test("quiesce interrupts the provider", async () => {
  let interrupted = false;
  const deps = createMockDeps({
    provider: {
      interrupt: async ({ attemptId, mode, reason }) => {
        interrupted = true;
        assert.equal(attemptId, "attempt_1");
        assert.equal(mode, "checkpoint_and_pause");
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  await service.quiesce({ run: baseRun, command: baseCommand });
  assert.ok(interrupted);
});

test("quiesce waits for no writer", async () => {
  let waited = false;
  const deps = createMockDeps({
    processProbe: {
      waitForNoWriter: async ({ runId, worktreePath, timeoutMs }) => {
        waited = true;
        assert.equal(runId, "run_1");
        assert.equal(worktreePath, "/home/user/project");
        assert.equal(timeoutMs, 30000);
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  await service.quiesce({ run: baseRun, command: baseCommand });
  assert.ok(waited);
});

// ---------------------------------------------------------------------------
// Two stable snapshots
// ---------------------------------------------------------------------------

test("quiesce requires two stable snapshots", async () => {
  let captureCount = 0;
  const deps = createMockDeps({
    repositorySnapshot: {
      capture: async () => {
        captureCount++;
        return { diff_digest: `digest_${captureCount}`, head_sha: "abc123" };
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  // Snapshots differ -> should throw
  await assert.rejects(
    () => service.quiesce({ run: baseRun, command: baseCommand }),
    WorktreeStillChangingError
  );
});

test("quiesce accepts stable snapshots", async () => {
  const deps = createMockDeps({
    repositorySnapshot: {
      capture: async () => ({ diff_digest: "stable", head_sha: "abc123" }),
    },
  });
  const service = createCodexQuiescenceService(deps);
  const result = await service.quiesce({ run: baseRun, command: baseCommand });
  assert.ok(result);
});

test("quiesce sleeps between snapshot captures", async () => {
  let slept = false;
  const deps = createMockDeps({
    clock: {
      sleep: async (ms) => {
        slept = true;
        assert.equal(ms, 1500);
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  await service.quiesce({ run: baseRun, command: baseCommand });
  assert.ok(slept);
});

// ---------------------------------------------------------------------------
// Checkpoint creation
// ---------------------------------------------------------------------------

test("quiesce creates takeover checkpoint", async () => {
  let checkpointArgs = null;
  const deps = createMockDeps({
    checkpointService: {
      createTakeoverCheckpoint: async (args) => {
        checkpointArgs = args;
        return { id: "cp_1" };
      },
    },
  });
  const service = createCodexQuiescenceService(deps);
  await service.quiesce({ run: baseRun, command: baseCommand });
  assert.ok(checkpointArgs);
  assert.equal(checkpointArgs.run.id, "run_1");
  assert.equal(checkpointArgs.command.id, "cmd_1");
});
