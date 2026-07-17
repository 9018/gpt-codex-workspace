/**
 * native-session-resume-service.test.mjs — Tests for Native Session Resume
 *
 * @module test/supervisor-review/native-session-resume-service
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createNativeSessionResumeService } from "../../src/codex-tui/native-session-resume-service.mjs";

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    processGuard: {
      assertNoActiveControlSession: async () => {},
    },
    repositoryGuard: {
      assertWorktreeExists: async () => {},
      assertExpectedIdentity: async () => {},
    },
    ptyManager: {
      spawn: async ({ cwd, command, args }) => ({
        id: "ctrl_sess_1",
        pid: 12345,
      }),
    },
    sessionBinder: {
      bind: async ({ runId, attemptId, nativeSessionId, controlSessionId, worktreePath }) => ({
        run_id: runId,
        attempt_id: attemptId,
        task_id: null,
        goal_id: null,
        worktree_path: worktreePath,
        control_session_id: controlSessionId,
        native_session_id: nativeSessionId,
        started_at: "2026-07-18T00:00:00.000Z",
        last_bound_at: "2026-07-18T00:00:00.000Z",
      }),
    },
    readyProbe: {
      waitUntilWritable: async () => {},
    },
    ...overrides,
  };
}

const baseRun = {
  id: "run_1",
  active_attempt_id: "attempt_1",
  workspace_ref: { worktree_path: "/home/user/project" },
  codex_home: "/home/user/.codex",
};

// ---------------------------------------------------------------------------
// Successful resume
// ---------------------------------------------------------------------------

test("resume spawns codex process and returns binding", async () => {
  let spawnArgs = null;
  const deps = createMockDeps({
    ptyManager: {
      spawn: async (args) => {
        spawnArgs = args;
        return { id: "ctrl_sess_1", pid: 12345 };
      },
    },
  });
  const service = createNativeSessionResumeService(deps);
  const binding = await service.resume({
    run: baseRun,
    nativeSessionId: "ns_1",
    worktreePath: "/home/user/project",
  });

  assert.ok(binding);
  assert.equal(binding.run_id, "run_1");
  assert.equal(binding.control_session_id, "ctrl_sess_1");
  assert.equal(binding.native_session_id, "ns_1");
  assert.equal(binding.worktree_path, "/home/user/project");

  assert.ok(spawnArgs);
  assert.equal(spawnArgs.command, "codex");
  assert.ok(spawnArgs.args.includes("ns_1"));
  assert.equal(spawnArgs.cwd, "/home/user/project");
});

// ---------------------------------------------------------------------------
// Pre-flight guards
// ---------------------------------------------------------------------------

test("resume rejects if active control session exists", async () => {
  const deps = createMockDeps({
    processGuard: {
      assertNoActiveControlSession: async () => { throw new Error("Active control session exists"); },
    },
  });
  const service = createNativeSessionResumeService(deps);
  await assert.rejects(
    () => service.resume({ run: baseRun, nativeSessionId: "ns_1", worktreePath: "/home/user/project" }),
    /Active control session/
  );
});

test("resume rejects if worktree does not exist", async () => {
  const deps = createMockDeps({
    repositoryGuard: {
      assertWorktreeExists: async () => { throw new Error("Worktree not found"); },
    },
  });
  const service = createNativeSessionResumeService(deps);
  await assert.rejects(
    () => service.resume({ run: baseRun, nativeSessionId: "ns_1", worktreePath: "/home/user/project" }),
    /Worktree not found/
  );
});

test("resume rejects if worktree identity mismatch", async () => {
  const deps = createMockDeps({
    repositoryGuard: {
      assertWorktreeExists: async () => {},
      assertExpectedIdentity: async () => { throw new Error("Identity mismatch"); },
    },
  });
  const service = createNativeSessionResumeService(deps);
  await assert.rejects(
    () => service.resume({ run: baseRun, nativeSessionId: "ns_1", worktreePath: "/home/user/project" }),
    /Identity mismatch/
  );
});

// ---------------------------------------------------------------------------
// Binding attempt
// ---------------------------------------------------------------------------

test("resume passes correct parameters to sessionBinder", async () => {
  let bindArgs = null;
  const deps = createMockDeps({
    ptyManager: {
      spawn: async () => ({ id: "ctrl_sess_1", pid: 12345 }),
    },
    sessionBinder: {
      bind: async (args) => {
        bindArgs = args;
        return { run_id: args.runId };
      },
    },
  });
  const service = createNativeSessionResumeService(deps);
  await service.resume({
    run: baseRun,
    nativeSessionId: "ns_1",
    worktreePath: "/home/user/project",
  });

  assert.ok(bindArgs);
  assert.equal(bindArgs.runId, "run_1");
  assert.equal(bindArgs.attemptId, "attempt_1");
  assert.equal(bindArgs.nativeSessionId, "ns_1");
  assert.equal(bindArgs.controlSessionId, "ctrl_sess_1");
  assert.equal(bindArgs.worktreePath, "/home/user/project");
});

// ---------------------------------------------------------------------------
// Ready probe
// ---------------------------------------------------------------------------

test("resume waits until session is writable", async () => {
  let waited = false;
  const deps = createMockDeps({
    readyProbe: {
      waitUntilWritable: async (id) => {
        waited = true;
        assert.equal(id, "ctrl_sess_1");
      },
    },
  });
  const service = createNativeSessionResumeService(deps);
  await service.resume({
    run: baseRun,
    nativeSessionId: "ns_1",
    worktreePath: "/home/user/project",
  });
  assert.ok(waited);
});
