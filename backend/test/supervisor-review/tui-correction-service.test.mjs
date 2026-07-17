/**
 * tui-correction-service.test.mjs — Tests for TUI Correction Service
 *
 * @module test/supervisor-review/tui-correction-service
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTuiCorrectionService, TuiSessionUnavailableError } from "../../src/supervisor-review/tui-correction-service.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCommand = {
  id: "cmd_1",
  run_id: "run_1",
  review_revision_id: "rev_001",
  action: "send_correction",
  payload: {
    objective: "Fix architecture drift",
    observed_drift: ["Using wrong pattern"],
    required_changes: ["Refactor to correct pattern"],
    forbidden_changes: ["No new modules"],
    allowed_files: ["src/x.mjs"],
    required_commands: ["npm test"],
    completion_evidence: ["Tests pass"],
  },
  preconditions: {
    expected_controller_owner: "codex_active",
    expected_worktree_path: "/home/user/project",
    expected_session_id: "sess_1",
    expected_native_session_id: "ns_1",
  },
};

const baseRun = {
  id: "run_1",
  version: 3,
  active_attempt_id: "attempt_1",
  supervision: {
    controller_owner: "codex_active",
    correction_cycles: 2,
    awaiting_progress_after_correction: false,
  },
  workspace_ref: { worktree_path: "/home/user/project" },
};

const runAfterCorrection = {
  ...baseRun,
  supervision: {
    ...baseRun.supervision,
    awaiting_progress_after_correction: true,
    last_correction_id: "cmd_1",
  },
};

function createMockDeps(overrides = {}) {
  return {
    sessionResolver: {
      resolve: async () => ({
        id: "sess_1",
        active: true,
        writable: true,
        run_id: "run_1",
        worktree_path: "/home/user/project",
      }),
    },
    sessionGuard: {
      assertBoundToRun: async () => {},
      assertSameWorktree: async () => {},
    },
    tuiDeltaSender: {
      preview: async () => {},
      send: async ({ sessionId, delta }) => ({
        delta_id: `delta_${delta.command_id}`,
        sent_at: "2026-07-18T00:00:00.000Z",
      }),
    },
    runStore: {
      updateRun: async (runId, changes) => ({
        ...baseRun,
        ...changes,
        supervision: { ...baseRun.supervision, ...changes.supervision },
      }),
    },
    nativeResumeService: {
      resume: async ({ run, nativeSessionId, worktreePath }) => ({
        id: "resumed_sess",
        active: true,
        writable: true,
        run_id: "run_1",
        worktree_path: "/home/user/project",
      }),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Successful correction to active session
// ---------------------------------------------------------------------------

test("sends correction to active writable session", async () => {
  let sentDelta = null;
  const deps = createMockDeps({
    tuiDeltaSender: {
      preview: async () => {},
      send: async ({ sessionId, delta }) => {
        sentDelta = delta;
        return { delta_id: `delta_${delta.command_id}`, sent_at: "2026-07-18T00:00:00.000Z" };
      },
    },
  });
  const service = createTuiCorrectionService(deps);
  const result = await service.apply(baseCommand, baseRun);

  assert.ok(result.session_id, "sess_1");
  assert.ok(result.delta_id);
  assert.ok(sentDelta);
  assert.equal(sentDelta.type, "architecture_correction");
  assert.equal(sentDelta.command_id, "cmd_1");
});

test("correction sends only once for same command", async () => {
  let sendCount = 0;
  const deps = createMockDeps({
    tuiDeltaSender: {
      preview: async () => {},
      send: async () => {
        sendCount++;
        return { delta_id: "delta_1", sent_at: "2026-07-18T00:00:00.000Z" };
      },
    },
  });
  const service = createTuiCorrectionService(deps);

  // First send (run has awaiting_progress_after_correction: false)
  await service.apply(baseCommand, baseRun);
  assert.equal(sendCount, 1);

  // Second send with run now in awaiting state should be rejected
  await assert.rejects(
    () => service.apply(baseCommand, runAfterCorrection),
    /awaiting progress/
  );
  assert.equal(sendCount, 1);
});

// ---------------------------------------------------------------------------
// Binding validation
// ---------------------------------------------------------------------------

test("rejects when session not bound to run", async () => {
  const deps = createMockDeps({
    sessionGuard: {
      assertBoundToRun: async () => { throw new Error("Session not bound to run"); },
      assertSameWorktree: async () => {},
    },
  });
  const service = createTuiCorrectionService(deps);
  await assert.rejects(
    () => service.apply(baseCommand, baseRun),
    /Session not bound to run/
  );
});

test("rejects when worktree path mismatch", async () => {
  const deps = createMockDeps({
    sessionGuard: {
      assertBoundToRun: async () => {},
      assertSameWorktree: async () => { throw new Error("Worktree mismatch"); },
    },
  });
  const service = createTuiCorrectionService(deps);
  await assert.rejects(
    () => service.apply(baseCommand, baseRun),
    /Worktree mismatch/
  );
});

// ---------------------------------------------------------------------------
// Session unavailable
// ---------------------------------------------------------------------------

test("throws TuiSessionUnavailableError when no active or resumable session", async () => {
  const deps = createMockDeps({
    sessionResolver: {
      resolve: async () => ({
        id: null,
        active: false,
        writable: false,
        native_session_id: null,
        resumable: false,
      }),
    },
  });
  const service = createTuiCorrectionService(deps);
  await assert.rejects(
    () => service.apply(baseCommand, baseRun),
    TuiSessionUnavailableError
  );
});

// ---------------------------------------------------------------------------
// Native session resume fallback
// ---------------------------------------------------------------------------

test("resumes native session when control session unavailable", async () => {
  let wasResumed = false;
  const deps = createMockDeps({
    sessionResolver: {
      resolve: async () => ({
        id: null,
        active: false,
        writable: false,
        native_session_id: "ns_1",
        resumable: true,
      }),
    },
    nativeResumeService: {
      resume: async ({ run, nativeSessionId, worktreePath }) => {
        wasResumed = true;
        assert.equal(nativeSessionId, "ns_1");
        assert.equal(worktreePath, "/home/user/project");
        return {
          id: "resumed_sess",
          active: true,
          writable: true,
          run_id: "run_1",
          worktree_path: "/home/user/project",
        };
      },
    },
  });
  const service = createTuiCorrectionService(deps);
  const result = await service.apply(baseCommand, baseRun);

  assert.ok(wasResumed);
  assert.ok(result.session_id, "resumed_sess");
});

// ---------------------------------------------------------------------------
// Run supervision update
// ---------------------------------------------------------------------------

test("updates run supervision after correction sent", async () => {
  let updatedSupervision = null;
  const deps = createMockDeps({
    runStore: {
      updateRun: async (runId, changes) => {
        updatedSupervision = changes.supervision;
        return { ...baseRun, ...changes };
      },
    },
  });
  const service = createTuiCorrectionService(deps);
  await service.apply(baseCommand, baseRun);

  assert.ok(updatedSupervision);
  assert.equal(updatedSupervision.last_correction_id, "cmd_1");
  assert.equal(updatedSupervision.last_correction_revision, "rev_001");
  assert.equal(updatedSupervision.awaiting_progress_after_correction, true);
  assert.equal(updatedSupervision.correction_cycles, 3); // 2 + 1
});

// ---------------------------------------------------------------------------
// Correction instruction rendering
// ---------------------------------------------------------------------------

test("correction delta includes rendered instruction", async () => {
  let sentDelta = null;
  const deps = createMockDeps({
    tuiDeltaSender: {
      preview: async () => {},
      send: async ({ sessionId, delta }) => {
        sentDelta = delta;
        return { delta_id: "delta_1", sent_at: "2026-07-18T00:00:00.000Z" };
      },
    },
  });
  const service = createTuiCorrectionService(deps);
  await service.apply(baseCommand, baseRun);

  assert.ok(sentDelta.instruction);
  assert.ok(sentDelta.instruction.includes("架构纠偏目标"));
});
