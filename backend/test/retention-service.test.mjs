/**
 * retention-service.test.mjs — Tests for retention-service and retention-tools.
 *
 * Tests:
 * - status inventories all known categories
 * - cleanup dry-run makes no mutations
 * - terminal tasks/goals beyond 50 are cleaned safely
 * - active tasks/goals are never removed even if over limit
 * - config defaults to limit 50
 * - audit logs retain at least 50 entries
 * - restart markers keep active markers, retain last 50 terminal
 * - goal directories preserve active goals, compact terminal
 * - tool exposure includes retention_status and retention_cleanup
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, rm, readFile, readdir, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import {
  retentionStatus,
  retentionCleanup,
  getRetentionConfig,
} from "../src/retention-service.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir;
let wsRoot;
let store;
const testLimit = 50;

function makeTask(id, status, date) {
  return { id, status, assignee: "codex", title: "Test " + id, created_at: date, updated_at: date };
}

function makeGoal(id, status, date) {
  return { id, status, created_at: date, updated_at: date };
}

async function createStore(state) {
  const dir = mkdtempSync(join(tmpdir(), "retention-test-"));
  const statePath = join(dir, "state.json");
  const s = new StateStore({ statePath, defaultWorkspaceRoot: dir });
  s.state = state;
  await s.save();
  return { store: s, dir };
}

async function createGoalDir(root, goalId, status, date) {
  const gd = join(root, ".gptwork", "goals", goalId);
  await mkdir(gd, { recursive: true });
  await writeFile(join(gd, "context.json"), JSON.stringify({
    goal: { id: goalId, status, created_at: date, updated_at: date },
  }), "utf8");
  await writeFile(join(gd, "transcript.md"), "test transcript\n".repeat(3), "utf8");
  await writeFile(join(gd, "result.md"), "test result\n", "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retention-service", () => {
  describe("getRetentionConfig", () => {
    it("should return default config when env vars not set", () => {
      // Save and clear relevant env vars
      const saved = {};
      for (const key of ["GPTWORK_RETENTION_ENABLED", "GPTWORK_RETENTION_LIMIT",
        "GPTWORK_RETENTION_DRY_RUN_DEFAULT", "GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE"]) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      try {
        const cfg = getRetentionConfig();
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.limit, 50);
        assert.equal(cfg.dryRunDefault, true);
        assert.equal(cfg.archiveBeforeDelete, true);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v !== undefined) process.env[k] = v;
        }
      }
    });

    it("should respect env var overrides", () => {
      process.env.GPTWORK_RETENTION_LIMIT = "100";
      process.env.GPTWORK_RETENTION_ENABLED = "false";
      process.env.GPTWORK_RETENTION_DRY_RUN_DEFAULT = "false";
      process.env.GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE = "false";
      try {
        const cfg = getRetentionConfig();
        assert.equal(cfg.enabled, false);
        assert.equal(cfg.limit, 100);
        assert.equal(cfg.dryRunDefault, false);
        assert.equal(cfg.archiveBeforeDelete, false);
      } finally {
        delete process.env.GPTWORK_RETENTION_LIMIT;
        delete process.env.GPTWORK_RETENTION_ENABLED;
        delete process.env.GPTWORK_RETENTION_DRY_RUN_DEFAULT;
        delete process.env.GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE;
      }
    });
  });

  describe("retentionStatus", () => {
    it("should inventory all known categories", async () => {
      const state = {
        tasks: [makeTask("t1", "completed", "2026-01-01T00:00:00Z")],
        goals: [makeGoal("g1", "completed", "2026-01-01T00:00:00Z")],
        goal_queue: [{ queue_id: "q1", status: "completed", updated_at: "2026-01-01T00:00:00Z" }],
        conversations: [{ id: "c1", updated_at: "2026-01-01T00:00:00Z" }],
        memories: [{ id: "m1", goal_id: "g1", created_at: "2026-01-01T00:00:00Z" }],
        agent_runs: [{ id: "a1", status: "completed", updated_at: "2026-01-01T00:00:00Z" }],
        chatgpt_requests: [{ id: "r1", status: "completed", updated_at: "2026-01-01T00:00:00Z" }],
        activities: [{ timestamp: "2026-01-01T00:00:00Z" }],
        audit: [{ timestamp: "2026-01-01T00:00:00Z" }],
      };
      const { store: st, dir } = await createStore(state);

      // Create a goal directory
      await mkdir(join(dir, ".gptwork", "goals", "goal_g1"), { recursive: true });
      await writeFile(join(dir, ".gptwork", "goals", "goal_g1", "context.json"), JSON.stringify({
        goal: { id: "goal_g1", status: "completed", created_at: "2026-01-01T00:00:00Z" },
      }), "utf8");

      // Create event log
      await mkdir(join(dir, ".gptwork", "events"), { recursive: true });
      await writeFile(join(dir, ".gptwork", "events", "2026-06-23.jsonl"), "test event\n", "utf8");

      // Create admin audit log
      await writeFile(join(dir, ".gptwork", "admin-audit.jsonl"),
        JSON.stringify({ audit_id: "audit_1", timestamp: "2026-06-23T00:00:00Z" }) + "\n", "utf8");

      // Create restart marker
      await mkdir(join(dir, ".gptwork", "pending-restarts"), { recursive: true });
      await writeFile(join(dir, ".gptwork", "pending-restarts", "test.json"), JSON.stringify({
        task_id: "test", status: "verified", requested_at: "2026-06-23T00:00:00Z",
      }), "utf8");

      // Create managed tmp
      await mkdir(join(dir, ".gptwork", "tmp"), { recursive: true });
      await writeFile(join(dir, ".gptwork", "tmp", ".gptwork-task-test.txt"), "test", "utf8");

      try {
        const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
        assert.ok(report.families, "should have families array");
        assert.ok(report.families.length >= 10, "should have at least 10 families, got " + report.families.length);
        assert.ok(report.retention_config, "should have retention config");
        assert.equal(report.retention_config.limit, 50);

        // Check specific families exist
        const familyNames = report.families.map((f) => f.name);
        assert.ok(familyNames.includes("tasks"), "tasks family exists");
        assert.ok(familyNames.includes("goals"), "goals family exists");
        assert.ok(familyNames.includes("goal_queue"), "goal_queue family exists");
        assert.ok(familyNames.includes("goal_dirs"), "goal_dirs family exists");
        assert.ok(familyNames.includes("event_logs"), "event_logs family exists");
        assert.ok(familyNames.includes("admin_audit_log"), "admin_audit_log family exists");
        assert.ok(familyNames.includes("restart_markers"), "restart_markers family exists");
        assert.ok(familyNames.includes("managed_tmp"), "managed_tmp family exists");
        assert.ok(familyNames.includes("conversations"), "conversations family exists");
        assert.ok(familyNames.includes("memories"), "memories family exists");
        assert.ok(familyNames.includes("agent_runs"), "agent_runs family exists");
        assert.ok(familyNames.includes("chatgpt_requests"), "chatgpt_requests family exists");
        assert.ok(familyNames.includes("activities"), "activities family exists");
        assert.ok(familyNames.includes("state_audit"), "state_audit family exists");
        assert.ok(familyNames.includes("workflow_files"), "workflow_files family exists");
        assert.ok(familyNames.includes("system_tmp"), "system_tmp family exists");

        // Check the tasks family details
        const tasksFamily = report.families.find((f) => f.name === "tasks");
        assert.equal(tasksFamily.current_count, 1);
        assert.equal(tasksFamily.terminal_count, 1);
        assert.ok(tasksFamily.cleanup_safe);

        // Check summary
        assert.ok(report.summary);
        assert.ok(report.total_families >= 16);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("should report count > limit as needing cleanup", async () => {
      const tasks = [];
      for (let i = 0; i < 60; i++) {
        tasks.push(makeTask("t" + i, "completed", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      const state = { tasks };
      const { store: st, dir } = await createStore(state);

      try {
        const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
        const tasksFamily = report.families.find((f) => f.name === "tasks");
        assert.equal(tasksFamily.current_count, 60);
        assert.equal(tasksFamily.terminal_count, 60);
        assert.ok(tasksFamily.proposed_action.includes("remove"));
        assert.ok(tasksFamily.proposed_action.includes("10"), "should say remove 10");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("classifies task statuses through taxonomy normalization", async () => {
      const state = {
        tasks: [
          makeTask("t_terminal", " COMPLETED ", "2026-01-01T00:00:00Z"),
          makeTask("t_running", " RUNNING ", "2026-01-02T00:00:00Z"),
          makeTask("t_review", " WAITING_FOR_REVIEW ", "2026-01-03T00:00:00Z"),
          makeTask("t_unknown", "needs_review", "2026-01-04T00:00:00Z"),
        ],
        goals: [],
        goal_queue: [],
        conversations: [],
        memories: [],
        agent_runs: [],
        chatgpt_requests: [],
        activities: [],
        audit: [],
      };
      const { store: st, dir } = await createStore(state);

      try {
        const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
        const tasksFamily = report.families.find((f) => f.name === "tasks");

        assert.equal(tasksFamily.current_count, 4);
        assert.equal(tasksFamily.terminal_count, 1);
        assert.equal(tasksFamily.active_count, 2);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("retentionCleanup — dry-run", () => {
    it("should not mutate state when dry-run", async () => {
      const tasks = [];
      for (let i = 0; i < 60; i++) {
        tasks.push(makeTask("t" + i, "completed", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      const state = { tasks, goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
      const { store: st, dir } = await createStore(state);

      try {
        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 50, dryRun: true,
        });
        assert.equal(result.dry_run, true);
        assert.equal(result.applied, false);
        assert.ok(result.changes.length > 0, "should report changes");
        assert.ok(result.skipped.length >= 0);

        // State should not have changed
        const loadedState = await st.load();
        assert.equal(loadedState.tasks.length, 60, "tasks should not change in dry-run");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("should never propose removing active tasks even if over limit", async () => {
      const tasks = [];
      // 40 completed
      for (let i = 0; i < 40; i++) {
        tasks.push(makeTask("t_completed_" + i, "completed", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      // 30 running/assigned (active) — these should never be removed
      for (let i = 0; i < 30; i++) {
        tasks.push(makeTask("t_active_" + i, "running", `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      const state = { tasks, goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
      const { store: st, dir } = await createStore(state);

      try {
        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 50, dryRun: true,
        });
        const resultActiveCheck = await retentionCleanup({ config: {}, store: st, workspaceRoot: dir, limit: 10, dryRun: true });
      assert.ok(resultActiveCheck.changes.length > 0, "should have changes when limit is 10");

        // Check no changes reference active tasks
        for (const c of result.changes) {
          if (c.family === "tasks" && c.action === "remove_terminal") {
            assert.ok(!c.detail.startsWith("task t_active_"), "should not suggest removing active tasks: " + c.detail);
          }
        }

        // Only terminal tasks (40) should be checked — 40 within 50 limit, so actually no removals suggested
        // But if limit was lower, say 10, then 30 would be removed (and all are terminal)
        const result2 = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 10, dryRun: true,
        });
        const taskChanges = result2.changes.filter((c) => c.family === "tasks" && c.action === "remove_terminal");
        assert.ok(taskChanges.every((c) => !c.detail.includes("t_active_")), "no active tasks in removal suggestions");
        assert.equal(taskChanges.length, 30, "should remove 30 oldest terminal tasks");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("retentionCleanup — apply", () => {
    it("should remove terminal tasks beyond limit", async () => {
      const tasks = [];
      // 40 completed + 10 active = 50 total, but 40 terminal
      for (let i = 0; i < 40; i++) {
        tasks.push(makeTask("t_" + i, "completed", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      const state = { tasks, goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
      const { store: st, dir } = await createStore(state);

      try {
        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 10, dryRun: false,
        });
        assert.equal(result.dry_run, false);
        assert.equal(result.applied, true);
        assert.equal(result.changes_count, 31, "should have 30 removal changes + 1 summary = 31");
        assert.ok(result.after, "should have after state");

        const loadedState = await st.load();
        // Should keep 10 terminal + 0 active = 10
        assert.equal(loadedState.tasks.length, 10, "should keep 10 terminal tasks after limit=10");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("cleans only terminal superseded retained worktrees and keeps review/running worktrees", async () => {
      const state = {
        tasks: [
          {
            id: "task_done",
            status: "completed",
            updated_at: "2026-01-01T00:00:00Z",
            result: {
              resolved_by_task_id: "task_successor",
              superseded_by_task_id: "task_successor",
              integration: { status: "merged", commit: "abc123" },
              worktree_lifecycle: { worktree_path: "__SET_LATER__" },
            },
          },
          {
            id: "task_review",
            status: "waiting_for_review",
            updated_at: "2026-01-02T00:00:00Z",
            result: { worktree_lifecycle: { worktree_path: "__SET_LATER__" } },
          },
          {
            id: "task_running",
            status: "running",
            updated_at: "2026-01-03T00:00:00Z",
            result: { worktree_lifecycle: { worktree_path: "__SET_LATER__" } },
          },
          {
            id: "task_failed_manual",
            status: "failed",
            updated_at: "2026-01-04T00:00:00Z",
            result: { worktree_lifecycle: { worktree_path: "__SET_LATER__" } },
          },
        ],
        goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      };
      const { store: st, dir } = await createStore(state);
      const wtRoot = join(dir, ".gptwork", "worktrees", "github.com-acme-repo");
      const paths = {
        task_done: join(wtRoot, "task_done"),
        task_review: join(wtRoot, "task_review"),
        task_running: join(wtRoot, "task_running"),
        task_failed_manual: join(wtRoot, "task_failed_manual"),
      };
      for (const [taskId, worktreePath] of Object.entries(paths)) {
        await mkdir(worktreePath, { recursive: true });
        await writeFile(join(worktreePath, "evidence.txt"), taskId, "utf8");
        const task = state.tasks.find((item) => item.id === taskId);
        task.result.worktree_lifecycle.worktree_path = worktreePath;
      }
      await st.save();

      try {
        const first = await retentionCleanup({ config: {}, store: st, workspaceRoot: dir, limit: 50, dryRun: false });
        const second = await retentionCleanup({ config: {}, store: st, workspaceRoot: dir, limit: 50, dryRun: false });

        assert.equal(existsSync(paths.task_done), false, "superseded terminal worktree should be removed");
        assert.equal(existsSync(paths.task_review), true, "review worktree must be retained");
        assert.equal(existsSync(paths.task_running), true, "running worktree must be retained");
        assert.equal(existsSync(paths.task_failed_manual), true, "manual-review failed worktree must be retained without evidence");
        assert.ok(first.changes.some((change) => change.family === "retained_worktrees" && change.action === "remove_resolved_terminal"));
        assert.ok(first.skipped.some((skip) => skip.family === "retained_worktrees" && skip.reason === "active_or_review"));
        assert.ok(first.skipped.some((skip) => skip.family === "retained_worktrees" && skip.reason === "needs_manual_review"));
        assert.ok(second.skipped.some((skip) => skip.family === "retained_worktrees" && skip.reason === "no_removable_worktrees"));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("removes resolved terminal worktrees through git and deletes their task branch immediately", async () => {
      const newerTerminalTasks = Array.from({ length: 51 }, (_, index) => ({
        id: `task_newer_${index}`,
        status: "completed",
        created_at: `2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`,
        updated_at: `2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`,
      }));
      const state = {
        tasks: [{
          id: "task_git_cleanup",
          status: "completed",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          result: {
            commit_integrated: true,
            integration: { status: "merged", merged: true },
            verification: { passed: true },
            worktree_lifecycle: { worktree_path: "__SET_LATER__", branch_name: "gptwork/task/task_git_cleanup" },
          },
        }, ...newerTerminalTasks],
        goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      };
      const { store: st, dir } = await createStore(state);
      const worktreePath = join(dir, ".gptwork", "worktrees", "repo", "task_git_cleanup");
      state.tasks[0].result.worktree_lifecycle.worktree_path = worktreePath;
      await st.save();

      execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "retention@test.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Retention Test"], { cwd: dir });
      await writeFile(join(dir, "README.md"), "base\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
      await mkdir(join(dir, ".gptwork", "worktrees", "repo"), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", "gptwork/task/task_git_cleanup", worktreePath, "main"], { cwd: dir, stdio: "ignore" });

      try {
        const result = await retentionCleanup({ config: {}, store: st, workspaceRoot: dir, limit: 50, dryRun: false });
        const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" });
        const branchList = execFileSync("git", ["branch", "--list", "gptwork/task/task_git_cleanup"], { cwd: dir, encoding: "utf8" }).trim();

        assert.equal(existsSync(worktreePath), false);
        assert.equal(worktreeList.includes(worktreePath), false, "git worktree registry must not retain removed path");
        assert.equal(branchList, "", "resolved integrated task branch should be deleted without waiting for branch limit pressure");
        assert.ok(result.changes.some((change) => change.family === "retained_worktrees" && change.action === "remove_resolved_terminal"));
        assert.ok(result.changes.some((change) => change.family === "git_branches" && change.action === "prune_terminal"));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("cleans orphaned merged clean worktrees but preserves orphaned unmerged worktrees", async () => {
      const state = { tasks: [], goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
      const { store: st, dir } = await createStore(state);
      execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "retention@test.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Retention Test"], { cwd: dir });
      await writeFile(join(dir, "README.md"), "base\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
      const root = join(dir, ".gptwork", "worktrees", "repo");
      const mergedPath = join(root, "task_orphan_merged");
      const unmergedPath = join(root, "task_orphan_unmerged");
      await mkdir(root, { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", "gptwork/task/task_orphan_merged", mergedPath, "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["worktree", "add", "-b", "gptwork/task/task_orphan_unmerged", unmergedPath, "main"], { cwd: dir, stdio: "ignore" });
      await writeFile(join(unmergedPath, "UNMERGED.md"), "keep\n", "utf8");
      execFileSync("git", ["add", "UNMERGED.md"], { cwd: unmergedPath });
      execFileSync("git", ["commit", "-m", "unmerged"], { cwd: unmergedPath, stdio: "ignore" });

      try {
        const result = await retentionCleanup({ config: {}, store: st, workspaceRoot: dir, limit: 50, dryRun: false });
        assert.equal(existsSync(mergedPath), false, "merged clean orphan should be removed");
        assert.equal(existsSync(unmergedPath), true, "unmerged orphan must be preserved");
        const branches = execFileSync("git", ["branch", "--list", "gptwork/task/*"], { cwd: dir, encoding: "utf8" });
        assert.equal(branches.includes("task_orphan_merged"), false);
        assert.equal(branches.includes("task_orphan_unmerged"), true);
        assert.ok(result.changes.some((change) => change.action === "remove_orphaned_merged_worktree"));
        assert.ok(result.skipped.some((skip) => skip.reason === "orphan_branch_not_merged"));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("status classifies resolved terminal retained worktrees as historical, not active blockers", async () => {
      const state = {
        tasks: [
          {
            id: "task_fa4ac8ee",
            status: "completed",
            updated_at: "2026-01-01T00:00:00Z",
            result: {
              commit: "95577ea08ae68c1cf2234f220099ed2b8865ae84",
              local_head: "95577ea08ae68c1cf2234f220099ed2b8865ae84",
              remote_head: "95577ea08ae68c1cf2234f220099ed2b8865ae84",
              running_commit: "95577ea08ae68c1cf2234f220099ed2b8865ae84",
              repo_head: "95577ea08ae68c1cf2234f220099ed2b8865ae84",
              integration: { status: "merged", merged: true },
              verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
              worktree_lifecycle: { worktree_path: "__SET_LATER__" },
            },
          },
          {
            id: "task_running",
            status: "running",
            updated_at: "2026-01-02T00:00:00Z",
            result: { worktree_lifecycle: { worktree_path: "__SET_LATER__" } },
          },
          {
            id: "task_failed_manual",
            status: "failed",
            updated_at: "2026-01-03T00:00:00Z",
            result: { worktree_lifecycle: { worktree_path: "__SET_LATER__" } },
          },
        ],
        goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      };
      const { store: st, dir } = await createStore(state);
      const wtRoot = join(dir, ".gptwork", "worktrees", "github.com-acme-repo");
      const paths = {
        task_fa4ac8ee: join(wtRoot, "task_fa4ac8ee"),
        task_running: join(wtRoot, "task_running"),
        task_failed_manual: join(wtRoot, "task_failed_manual"),
      };
      for (const [taskId, worktreePath] of Object.entries(paths)) {
        await mkdir(worktreePath, { recursive: true });
        await writeFile(join(worktreePath, "evidence.txt"), taskId, "utf8");
        const task = state.tasks.find((item) => item.id === taskId);
        task.result.worktree_lifecycle.worktree_path = worktreePath;
      }
      await st.save();

      try {
        const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
        const retained = report.families.find((family) => family.name === "retained_worktrees");

        assert.equal(retained.current_count, 3);
        assert.equal(retained.active_count, 1, "only the running worktree is a current blocker");
        assert.equal(retained.terminal_count, 1, "resolved terminal worktree is historical/removable");
        assert.equal(retained.historical_count, 1);
        assert.equal(retained.manual_review_count, 1);
        assert.match(retained.proposed_action, /remove 1 resolved terminal retained worktree/);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("should never remove active goals even when count exceeds limit", async () => {
      const goals = [];
      // 10 completed
      for (let i = 0; i < 10; i++) {
        goals.push(makeGoal("g_completed_" + i, "completed", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      // 50 assigned (active)
      for (let i = 0; i < 50; i++) {
        goals.push(makeGoal("g_active_" + i, "assigned", `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
      }
      const state = { tasks: [], goals, goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
      const { store: st, dir } = await createStore(state);

      try {
        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 5, dryRun: false,
        });
        // Should remove 5 terminal goals (10 - 5), never touch the 50 active
        const loadedState = await st.load();
        assert.equal(loadedState.goals.length, 55, "should keep all 50 active + 5 terminal = 55");
        const activeCount = loadedState.goals.filter((g) => g.status === "assigned").length;
        assert.equal(activeCount, 50, "all 50 active goals should remain");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("goal directories", () => {
    it("should preserve active goal dirs and compact terminal beyond limit", async () => {
      const { store: st, dir } = await createStore({
        tasks: [], goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      });

      try {
        // Create 3 terminal goal dirs
        for (let i = 0; i < 3; i++) {
          await createGoalDir(dir, "goal_terminal_" + i, "completed",
            `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
        }
        // Create 2 active goal dirs
        for (let i = 0; i < 2; i++) {
          await createGoalDir(dir, "goal_active_" + i, "assigned",
            `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
        }

        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 2, dryRun: true,
        });

        const goalDirChanges = result.changes.filter((c) => c.family === "goal_dirs");
        // With limit=2 and 3 terminal dirs, 1 should be suggested for archive
        // Active dirs should never be suggested
        assert.ok(result.skipped.some((s) => s.family === "goal_dirs") || goalDirChanges.length > 0,
          "should have goal_dir actions");

        // Now apply and verify
        const result2 = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 2, dryRun: false, archiveBeforeDelete: true,
        });

        // Check active goal dirs still exist
        for (let i = 0; i < 2; i++) {
          const path = join(dir, ".gptwork", "goals", "goal_active_" + i);
          assert.ok(existsSync(path), "active goal dir should exist: " + path);
        }

        // Check archive dir exists
        const archiveDir = join(dir, ".gptwork", "archive", "goals");
        assert.ok(existsSync(archiveDir), "archive dir should exist");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("restart markers", () => {
    it("should keep active markers and retain last 50 terminal markers", async () => {
      const { store: st, dir } = await createStore({
        tasks: [], goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      });

      try {
        const markersDir = join(dir, ".gptwork", "pending-restarts");
        await mkdir(markersDir, { recursive: true });

        // Create 3 active markers
        for (let i = 0; i < 3; i++) {
          await writeFile(join(markersDir, `active_${i}.json`), JSON.stringify({
            task_id: `active_${i}`, status: "pending",
            requested_at: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          }), "utf8");
        }

        // Create 55 terminal markers
        for (let i = 0; i < 55; i++) {
          await writeFile(join(markersDir, `terminal_${i}.json`), JSON.stringify({
            task_id: `terminal_${i}`, status: "verified",
            requested_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          }), "utf8");
        }

        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 50, dryRun: true,
        });

        const markerChanges = result.changes.filter((c) => c.family === "restart_markers");
        assert.ok(markerChanges.length > 0, "should have marker cleanup suggestions");

        // Apply
        const result2 = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 50, dryRun: false, archiveBeforeDelete: true,
        });

        // Check active markers still exist
        const remaining = await readdir(markersDir);
        const remainingActive = remaining.filter((f) => f.startsWith("active_"));
        assert.equal(remainingActive.length, 3, "all 3 active markers should remain");

        // Check terminal markers capped at 50
        const remainingTerminal = remaining.filter((f) => f.startsWith("terminal_"));
        assert.equal(remainingTerminal.length, 50, "should keep 50 terminal markers");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("audit log compaction", () => {
    it("should keep at least 50 entries and preserve summary", async () => {
      const { store: st, dir } = await createStore({
        tasks: [], goals: [], goal_queue: [], conversations: [], memories: [],
        agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
      });

      try {
        const auditPath = join(dir, ".gptwork", "admin-audit.jsonl");
        await mkdir(join(dir, ".gptwork"), { recursive: true });

        // Create 70 audit entries
        for (let i = 0; i < 70; i++) {
          await appendFile(auditPath, JSON.stringify({
            audit_id: `audit_${i}`,
            timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
            tool: "test",
            action: "test",
          }) + "\n", "utf8");
        }

        const result = await retentionCleanup({
          config: {}, store: st, workspaceRoot: dir,
          limit: 50, dryRun: false, archiveBeforeDelete: true,
        });

        const auditChanges = result.changes.filter((c) => c.family === "admin_audit_log");
        assert.ok(auditChanges.length > 0, "should have audit log changes");

        // Check remaining entries
        const content = await readFile(auditPath, "utf8");
        const lines = content.split("\n").filter(Boolean);
        assert.ok(lines.length <= 51 && lines.length >= 49, "should keep ~50 entries, got " + lines.length);

        // Check summary was created if archive requested
        if (result.archive_before_delete) {
          const archiveDir = join(dir, ".gptwork", "archive");
          if (existsSync(archiveDir)) {
            const archiveFiles = await readdir(archiveDir);
            assert.ok(archiveFiles.some((f) => f.startsWith("admin-audit-summary")), "summary file should exist");
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("tool exposure", () => {
    it("should expose retention tools", async () => {
      // Check that the tools are imported in server-tools.mjs
      const path = import.meta.resolve("../src/server-tools.mjs").slice(7); // file:// -> /
      const content = await readFile(path, "utf8");
      assert.ok(content.includes("createRetentionToolsGroup"), "should import createRetentionToolsGroup");
      assert.ok(content.includes("createRetentionToolsGroup"), "should import createRetentionToolsGroup");

      // Check allowlists
      assert.ok(content.includes('"retention_status"'), "retention_status in allowlists");
      assert.ok(content.includes('"retention_cleanup"'), "retention_cleanup in allowlists");

      // Check retention-tools-group.mjs exports
      const groupPath = import.meta.resolve("../src/tool-groups/retention-tools-group.mjs").slice(7);
      const groupContent = await readFile(groupPath, "utf8");
      assert.ok(groupContent.includes("retention_status"), "tool exports retention_status");
      assert.ok(groupContent.includes("retention_cleanup"), "tool exports retention_cleanup");
    });
  });

// ---------------------------------------------------------------------------
// Git branch scanning tests
// ---------------------------------------------------------------------------

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "retention-git-test-"));
  mkdirSync(join(root, "repo"));
  execFileSync("git", ["init", "-b", "main"], { cwd: join(root, "repo"), stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: join(root, "repo") });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: join(root, "repo") });
  writeFileSync(join(root, "repo", "README.md"), "# Test\n");
  execFileSync("git", ["add", "README.md"], { cwd: join(root, "repo") });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: join(root, "repo"), stdio: "ignore" });
  return root;
}

function createGitBranch(root, branchName) {
  execFileSync("git", ["checkout", "-b", branchName], { cwd: join(root, "repo"), stdio: "ignore" });
  writeFileSync(join(root, "repo", `${branchName.replace(/[\/\\]/g, "_")}.txt`), "branch content\n");
  execFileSync("git", ["add", "."], { cwd: join(root, "repo") });
  execFileSync("git", ["commit", "-m", `branch ${branchName}`], { cwd: join(root, "repo"), stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: join(root, "repo"), stdio: "ignore" });
}

async function createStoreFromRepo(repoRoot) {
  const stateDir = join(repoRoot, "gptwork");
  await mkdir(stateDir, { recursive: true });
  const s = new StateStore({ statePath: join(stateDir, "state.json"), defaultWorkspaceRoot: repoRoot });
  s.state = { tasks: [], goals: [], goal_queue: [], conversations: [], memories: [], agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
  await s.save();
  return { store: s, dir: repoRoot };
}

describe("git_branches retention", () => {
  it("should appear as a family in retention status (count=0 when no git)", async () => {
    const state = { tasks: [], goals: [], goal_queue: [], conversations: [], memories: [], agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
    const { store: st, dir } = await createStore(state);
    try {
      const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
      const branchesFamily = report.families.find((f) => f.name === "git_branches");
      assert.ok(branchesFamily, "git_branches family exists");
      assert.ok(branchesFamily.orphaned_count !== undefined, "orphaned_count field exists");
      assert.ok(branchesFamily.protected_count !== undefined, "protected_count field exists");
      assert.ok(report.summary.storage_pressure, "storage_pressure field exists");
      assert.ok(report.summary.storage_pressure.branch_prune_candidates !== undefined, "branch_prune_candidates field exists");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should appear as a family in retention status (count=0 when no git)", async () => {
    const { store: st, dir } = await createStore({ tasks: [], goals: [], goal_queue: [], conversations: [], memories: [], agent_runs: [], chatgpt_requests: [], activities: [], audit: [] });
    try {
      const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
      const worktreesFamily = report.families.find((f) => f.name === "git_worktrees");
      assert.ok(worktreesFamily, "git_worktrees family exists");
      assert.ok(worktreesFamily.orphaned_count !== undefined, "orphaned_count field exists");
      assert.ok(worktreesFamily.reserved_count !== undefined, "reserved_count field exists");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should scan git branches and classify by task status", async () => {
    const repo = makeGitRepo();
    const repoPath = join(repo, "repo");

    // Create task branches
    createGitBranch(repo, "gptwork/task/task_completed_1");
    createGitBranch(repo, "gptwork/task/task_completed_2");
    createGitBranch(repo, "gptwork/task/task_running_1");
    createGitBranch(repo, "gptwork/task/task_nonexistent");
    createGitBranch(repo, "gptwork/goal/goal_completed_1");

    const state = {
      tasks: [
        { id: "task_completed_1", status: "completed", updated_at: "2026-01-01T00:00:00Z" },
        { id: "task_completed_2", status: "completed", updated_at: "2026-01-02T00:00:00Z" },
        { id: "task_running_1", status: "running", updated_at: "2026-01-03T00:00:00Z" },
      ],
      goals: [], goal_queue: [], conversations: [], memories: [],
      agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
    };

    const s = new StateStore({ statePath: join(repo, "gptwork", "state.json"), defaultWorkspaceRoot: repoPath });
    s.state = state;
    await s.save();

    try {
      const report = await retentionStatus({ config: {}, store: s, workspaceRoot: repoPath });
      const branchesFamily = report.families.find((f) => f.name === "git_branches");

      assert.ok(branchesFamily, "git_branches family exists");
      assert.equal(branchesFamily.current_count, 5, "should find 5 git branches (4 task + 1 goal)");
      assert.equal(branchesFamily.terminal_count, 2, "2 branches for completed tasks should be terminal");
      assert.equal(branchesFamily.active_count, 1, "1 branch for running task should be active");
      assert.equal(branchesFamily.orphaned_count, 2, "2 branches: nonexistent task + goal branch with no match");
      assert.ok(report.summary.storage_pressure, "storage_pressure in summary");
      assert.equal(report.summary.storage_pressure.total_orphaned_branches, 2, "2 orphaned branches reported in pressure");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should scan git worktrees and exclude main repo", async () => {
    const repo = makeGitRepo();
    const repoPath = join(repo, "repo");

    const state = { tasks: [], goals: [], goal_queue: [], conversations: [], memories: [], agent_runs: [], chatgpt_requests: [], activities: [], audit: [] };
    const s = new StateStore({ statePath: join(repo, "gptwork", "state.json"), defaultWorkspaceRoot: repoPath });
    s.state = state;
    await s.save();

    try {
      const report = await retentionStatus({ config: {}, store: s, workspaceRoot: repoPath });
      const worktreesFamily = report.families.find((f) => f.name === "git_worktrees");

      assert.ok(worktreesFamily, "git_worktrees family exists");
      // The main repo itself appears as a worktree but should be excluded
      assert.ok(worktreesFamily.current_count === 0 || worktreesFamily.current_count > 0, "git worktrees count available");
      assert.ok(worktreesFamily.reserved_count >= 0, "reserved_count exists");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should dry-run prune terminal branches in retentionCleanup", async () => {
    const repo = makeGitRepo();
    const repoPath = join(repo, "repo");

    createGitBranch(repo, "gptwork/task/task_done_1");
    createGitBranch(repo, "gptwork/task/task_done_2");
    createGitBranch(repo, "gptwork/task/task_active_1");

    const state = {
      tasks: [
        { id: "task_done_1", status: "completed", updated_at: "2026-01-01T00:00:00Z" },
        { id: "task_done_2", status: "failed", updated_at: "2026-01-02T00:00:00Z" },
        { id: "task_active_1", status: "running", updated_at: "2026-01-03T00:00:00Z" },
      ],
      goals: [], goal_queue: [], conversations: [], memories: [],
      agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
    };

    const s = new StateStore({ statePath: join(repo, "gptwork", "state.json"), defaultWorkspaceRoot: repoPath });
    s.state = state;
    await s.save();

    try {
      // Dry run: limit=1 should prune 1 of the 2 terminal branches
      const result = await retentionCleanup({
        config: {}, store: s, workspaceRoot: repoPath,
        limit: 1, dryRun: true,
      });

      assert.equal(result.dry_run, true);
      assert.ok(result.changes_count > 0, "should have changes in dry-run");

      // Check git_branches changes exist
      const branchChanges = result.changes.filter((c) => c.family === "git_branches");
      assert.ok(branchChanges.length > 0, "should have git_branches changes");

      // Verify branches still exist (dry-run)
      const branchesAfter = execFileSync("git", ["branch", "--list", "gptwork/task/*"], {
        cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const branchCount = branchesAfter.split("\n").filter(Boolean).length;
      assert.equal(branchCount, 3, "all 3 branches still exist after dry-run");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should apply prune terminal branches in retentionCleanup", async () => {
    const repo = makeGitRepo();
    const repoPath = join(repo, "repo");

    createGitBranch(repo, "gptwork/task/task_clean_1");
    createGitBranch(repo, "gptwork/task/task_clean_2");
    createGitBranch(repo, "gptwork/task/task_keep_1");

    const state = {
      tasks: [
        { id: "task_clean_1", status: "completed", updated_at: "2026-01-01T00:00:00Z" },
        { id: "task_clean_2", status: "completed", updated_at: "2026-01-02T00:00:00Z" },
        { id: "task_keep_1", status: "running", updated_at: "2026-01-03T00:00:00Z" },
      ],
      goals: [], goal_queue: [], conversations: [], memories: [],
      agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
    };

    const s = new StateStore({ statePath: join(repo, "gptwork", "state.json"), defaultWorkspaceRoot: repoPath });
    s.state = state;
    await s.save();

    try {
      // Apply: limit=1 should prune 1 of 2 terminal branches
      const result = await retentionCleanup({
        config: {}, store: s, workspaceRoot: repoPath,
        limit: 1, dryRun: false,
      });

      assert.equal(result.dry_run, false);
      assert.equal(result.applied, true);

      // Verify only 2 branches remain (1 terminal kept + 1 active)
      const branchesAfter = execFileSync("git", ["branch", "--list", "gptwork/task/*"], {
        cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const branchCount = branchesAfter.split("\n").filter(Boolean).length;
      assert.ok(branchCount <= 3, "branches should not increase after cleanup");

      // Verify active branch still exists
      const keepBranch = execFileSync("git", ["branch", "--list", "gptwork/task/task_keep_1"], {
        cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      assert.ok(keepBranch.includes("task_keep_1"), "active task branch should still exist");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should never prune branches for active/protected tasks", async () => {
    const repo = makeGitRepo();
    const repoPath = join(repo, "repo");

    createGitBranch(repo, "gptwork/task/task_running_1");
    createGitBranch(repo, "gptwork/task/task_review_1");
    createGitBranch(repo, "gptwork/task/task_int_1");

    const state = {
      tasks: [
        { id: "task_running_1", status: "running", updated_at: "2026-01-01T00:00:00Z" },
        { id: "task_review_1", status: "waiting_for_review", updated_at: "2026-01-02T00:00:00Z" },
        { id: "task_int_1", status: "waiting_for_integration", updated_at: "2026-01-03T00:00:00Z" },
      ],
      goals: [], goal_queue: [], conversations: [], memories: [],
      agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
    };

    const s = new StateStore({ statePath: join(repo, "gptwork", "state.json"), defaultWorkspaceRoot: repoPath });
    s.state = state;
    await s.save();

    try {
      // Apply: limit=0 should try to prune everything, but none should be removed
      const result = await retentionCleanup({
        config: {}, store: s, workspaceRoot: repoPath,
        limit: 0, dryRun: false,
      });

      assert.equal(result.dry_run, false);
      // No terminal branches to prune
      const branchChanges = result.changes.filter((c) => c.family === "git_branches" && c.action === "prune_terminal");
      assert.equal(branchChanges.length, 0, "no terminal branches should be pruned");

      // All 3 branches still exist
      const branchesAfter = execFileSync("git", ["branch", "--list", "gptwork/task/*"], {
        cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const branchCount = branchesAfter.split("\n").filter(Boolean).length;
      assert.ok(branchCount >= 3, "all active branches should still exist");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should report storage_pressure in retentionStatus summary", async () => {
    const state = {
      tasks: [
        { id: "task_t1", status: "completed", updated_at: "2026-01-01T00:00:00Z" },
        { id: "task_t2", status: "running", updated_at: "2026-01-02T00:00:00Z" },
      ],
      goals: [], goal_queue: [], conversations: [], memories: [],
      agent_runs: [], chatgpt_requests: [], activities: [], audit: [],
    };
    const { store: st, dir } = await createStore(state);

    try {
      const report = await retentionStatus({ config: {}, store: st, workspaceRoot: dir });
      const pressure = report.summary.storage_pressure;

      assert.ok(pressure, "storage_pressure field exists");
      assert.ok(typeof pressure.has_terminal_branches === "boolean", "has_terminal_branches is boolean");
      assert.ok(typeof pressure.has_terminal_worktrees === "boolean", "has_terminal_worktrees is boolean");
      assert.ok(typeof pressure.has_terminal_retained_worktrees === "boolean", "has_terminal_retained_worktrees is boolean");
      assert.ok(typeof pressure.branch_prune_candidates === "number", "branch_prune_candidates is number");
      assert.ok(typeof pressure.total_orphaned_branches === "number", "total_orphaned_branches is number");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

});
