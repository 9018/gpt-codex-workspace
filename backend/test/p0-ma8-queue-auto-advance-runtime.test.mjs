import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state-store.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

import {
  BLOCKED_REASON_TYPES,
  checkTypedEligibility,
  queueAutoAdvanceTick,
} from "../src/goal-queue.mjs";

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

async function makeStore(dir) {
  const store = new StateStore({
    statePath: join(dir, "state.json"),
    defaultWorkspaceRoot: dir,
  });
  await store.load();
  store.state.goal_queue = [];
  store.state.goals = [];
  store.state.tasks = [];
  await store.save();
  return store;
}

const noLocks = () => ({ active: 0, stale: 0 });
const oneLock = () => ({ active: 1, stale: 0 });
const cleanWorktree = () => ({ clean: true });
const dirtyWorktree = () => ({ clean: false, error: "simulated dirty" });

test("MA8 S1: BLOCKED_REASON_TYPES exports", async (t) => {
  await t.test("has all 9 typed reasons", () => {
    assert.equal(BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL, "dependency_not_terminal");
    assert.equal(BLOCKED_REASON_TYPES.ACTIVE_REPO_LOCK, "active_repo_lock");
    assert.equal(BLOCKED_REASON_TYPES.DIRTY_WORKTREE, "dirty_worktree");
    assert.equal(BLOCKED_REASON_TYPES.WAITING_FOR_REVIEW, "waiting_for_review");
    assert.equal(BLOCKED_REASON_TYPES.WAITING_FOR_REPAIR, "waiting_for_repair");
    assert.equal(BLOCKED_REASON_TYPES.WAITING_FOR_INTEGRATION, "waiting_for_integration");
    assert.equal(BLOCKED_REASON_TYPES.ACCEPTANCE_NOT_SATISFIED, "acceptance_not_satisfied");
    assert.equal(BLOCKED_REASON_TYPES.INTEGRATION_NOT_SATISFIED, "integration_not_satisfied");
    assert.equal(BLOCKED_REASON_TYPES.FINALIZER_NOT_TERMINAL, "finalizer_not_terminal");
    assert.equal(Object.keys(BLOCKED_REASON_TYPES).length, 9);
  });
  await t.test("no admin override types", () => {
    const v = Object.values(BLOCKED_REASON_TYPES);
    assert.equal(v.includes("admin_override"), false);
    assert.equal(v.includes("skip"), false);
  });
});

test("MA8 S2: checkTypedEligibility happy path", async (t) => {
  await t.test("no dependency = eligible", async () => {
    const r = await checkTypedEligibility(
      { tasks: [], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, true);
    assert.equal(r.blocked_reason, null);
  });
});

test("MA8 S3: dependency_not_terminal", async (t) => {
  await t.test("missing task", async () => {
    const r = await checkTypedEligibility(
      { tasks: [], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_missing", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_missing", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL);
  });
  await t.test("running task", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_running", status: "running" }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_running", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_running", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL);
  });
  await t.test("failed task", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_failed", status: "failed" }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_failed", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_failed", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL);
  });
});

test("MA8 S4: waiting_for_review", async (t) => {
  await t.test("task waiting_for_review blocks", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_review", status: "waiting_for_review" }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_review", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_review", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.WAITING_FOR_REVIEW);
  });
});

test("MA8 S5: waiting_for_repair", async (t) => {
  await t.test("task waiting_for_repair blocks", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_repair", status: "waiting_for_repair" }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_repair", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_repair", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.WAITING_FOR_REPAIR);
  });
});

test("MA8 S6: waiting_for_integration", async (t) => {
  await t.test("task waiting_for_integration blocks", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_integ", status: "waiting_for_integration" }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_integ", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_integ", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.WAITING_FOR_INTEGRATION);
  });
});

test("MA8 S7: acceptance_not_satisfied", async (t) => {
  await t.test("completed but no acceptance", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_noacc", status: "completed", result: { requires_review: true, verification: { passed: false } } }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_noacc", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_noacc", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.ACCEPTANCE_NOT_SATISFIED);
  });
});

test("MA8 S8: finalizer_not_terminal", async (t) => {
  await t.test("completed but no terminal finalizer", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_nofin", status: "completed", result: { acceptance_gate: { passed: true }, verification: { passed: true }, finalizer_decision: { status: "waiting_for_review" }, requires_review: false } }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_nofin", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_nofin", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.FINALIZER_NOT_TERMINAL);
  });
});

test("MA8 S9: active_repo_lock", async (t) => {
  await t.test("active lock blocks", async () => {
    const r = await checkTypedEligibility(
      { tasks: [], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: oneLock, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.ACTIVE_REPO_LOCK);
  });
});

test("MA8 S10: dirty_worktree", async (t) => {
  await t.test("dirty worktree blocks", async () => {
    const r = await checkTypedEligibility(
      { tasks: [], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp", defaultRepoPath: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: dirtyWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.DIRTY_WORKTREE);
  });
});

test("MA8 S11: tick stores typed blocked_reason", async (t) => {
  await t.test("dep_not_terminal stored on state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ma8-s11-"));
    const store = await makeStore(dir);
    store.state.goals.push({ id: "g1", project_id: "d", conversation_id: "c1", title: "t", status: "open", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    store.state.conversations = [{ id: "c1", goal_id: "g1", project_id: "d", workspace_id: "hosted-default", messages: [{ role: "user", content: "t" }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
    store.state.goal_queue.push({ queue_id: "q1", goal_id: "g1", position: 1, status: "waiting", depends_on_task_id: "t_missing", auto_start: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await store.save();
    const r = await queueAutoAdvanceTick(store, { defaultWorkspaceRoot: dir }, { dryRun: false, checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree });
    assert.equal(r.advanced, false);
    assert.ok(r.blocked_items.length > 0);
    assert.equal(r.blocked_items[0].blocked_reason, BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL);
    await store.load();
    const item = store.state.goal_queue.find(q => q.queue_id === "q1");
    assert.equal(item.status, "blocked");
    assert.equal(item.blocked_reason, BLOCKED_REASON_TYPES.DEPENDENCY_NOT_TERMINAL);
  });
});

test("MA8 S12: dry run", async (t) => {
  await t.test("dry run does not mutate state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ma8-s12-"));
    const repo = join(dir, "repo");
    await initGitRepo(repo);
    const store = await makeStore(dir);
    store.state.goals.push({ id: "g1", project_id: "d", conversation_id: "c1", title: "t", mode: "builder", status: "open", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    store.state.conversations = [{ id: "c1", goal_id: "g1", project_id: "d", workspace_id: "hosted-default", messages: [{ role: "user", content: "t" }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
    store.state.goal_queue.push({ queue_id: "q1", goal_id: "g1", position: 1, status: "waiting", auto_start: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await store.save();
    const r = await queueAutoAdvanceTick(store, { defaultWorkspaceRoot: dir, defaultRepoPath: repo }, { dryRun: true, checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree });
    assert.equal(r.advanced, false);
    assert.ok(r.summary.includes("Dry run"));
    await store.load();
    assert.equal(store.state.goal_queue[0].status, "waiting");
    assert.ok(store.state.goal_queue[0].task_id == null, "task_id should be null/undefined");
    assert.equal(store.state.tasks.length, 0);
  });
});

test("MA8 S13: stale blocker detection", async (t) => {
  await t.test("detectStaleBlockers identifies stale blocked item", async () => {
    const { detectStaleBlockers } = await import("../src/queue-reconciler.mjs");
    const state = {
      tasks: [{ id: "t_orig", status: "completed", result: { operation_kind: "readonly_validation", needs_integration: false } }],
      goals: [],
      goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "blocked", depends_on_task_id: "t_orig", blocked_reason: "stale" }],
    };
    const stale = detectStaleBlockers(state);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale_type, "dependency_resolved");
    assert.equal(stale[0].recommendation, "unblock: set status to ready and re-check");
  });
  await t.test("propagateRepairSuccess unblocks dependent", async () => {
    const { propagateRepairSuccess } = await import("../src/queue-reconciler.mjs");
    const state = {
      tasks: [
        { id: "t_orig", status: "resolved_by_successor" },
        { id: "t_repair", status: "completed", root_task_id: "t_orig", parent_task_id: "t_orig" },
      ],
      goals: [],
      goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "blocked", depends_on_task_id: "t_orig", blocked_reason: "waiting for original" }],
    };
    const result = await propagateRepairSuccess(state, state.tasks[1], { dryRun: false });
    assert.equal(result.propagated, true);
    assert.equal(result.affected_count, 1);
    assert.equal(state.goal_queue[0].status, "ready");
    assert.equal(state.goal_queue[0].blocked_reason, null);
  });
});

test("MA8 S14: integration_not_satisfied", async (t) => {
  await t.test("completed mutating but not integrated", async () => {
    const r = await checkTypedEligibility(
      { tasks: [{ id: "t_unint", status: "completed", result: { commit: "abc123", needs_integration: true } }], goals: [], goal_queue: [{ queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_unint", repo_id: "d", auto_start: true }] },
      { queue_id: "q1", goal_id: "g1", status: "waiting", depends_on_task_id: "t_unint", repo_id: "d", auto_start: true },
      { defaultWorkspaceRoot: "/tmp" },
      { checkRepoLocksFn: noLocks, checkWorktreeCleanFn: cleanWorktree }
    );
    assert.equal(r.eligible, false);
    assert.equal(r.blocked_reason, BLOCKED_REASON_TYPES.INTEGRATION_NOT_SATISFIED);
  });
});

test("MA8 S15: MA9 not launched", async (t) => {
  const v = Object.values(BLOCKED_REASON_TYPES);
  assert.equal(v.includes("ma9"), false, "No MA9 references in blocked types");
  const fs = await import("fs");
  const content = fs.readFileSync(new URL("../src/goal-queue.mjs", import.meta.url), "utf8");
  assert.equal(content.includes("MA9"), false, "goal-queue.mjs has no MA9 references");
});
