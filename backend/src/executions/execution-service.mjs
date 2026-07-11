/**
 * execution-service.mjs — Orchestrate task execution within isolated worktrees.
 *
 * Startup flow:
 *   1. resolve plan (no git mutation)
 *   2. materialize worktree (git worktree add)
 *   3. verify task worktree is valid
 *   4. cwd = task_worktree_path
 *   5. create execution record
 *   6. start TUI session within worktree
 *
 * Session/Task/Execution persistence includes:
 *   workstream_id, goal_id, task_id, worktree_path, branch,
 *   base_commit, head_commit, session_id, optional codex_thread_id.
 *
 * All results and lock releases operate on the task worktree path.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createExecutionStore } from "./execution-store.mjs";

/**
 * Create an execution service for orchestrating worktree-based TUI execution.
 *
 * @param {object} options
 * @param {object} options.store - State store for tasks/goals (must have .load())
 * @param {object} options.config - Configuration object
 * @param {Function} options.resolveTaskRepositoryPlanFn - resolveTaskRepositoryPlan
 * @param {Function} options.materializeTaskWorktreeFn - materializeTaskWorktree from task-repo-resolution
 * @param {Function} options.acquireRepoLockFn - Repo lock acquire function
 * @param {Function} options.releaseRepoLockFn - Repo lock release function
 * @param {Function} options.createExecutionStoreFn - Factory for execution store
 * @param {Function} options.createTuiPtyAdapterFn - Factory for PTY adapter
 * @param {Function} options.buildBootstrapMessagesFn - Build TUI bootstrap prompt
 * @param {Function} options.startTuiSessionFn - Start TUI session (injectable)
 * @param {string} [options.workstreamId] - Workstream identifier for execution records
 * @returns {object} Execution service API
 */
export function createExecutionService({
  store,
  config,
  resolveTaskRepositoryPlanFn,
  materializeTaskWorktreeFn,
  acquireRepoLockFn,
  releaseRepoLockFn,
  createExecutionStoreFn = createExecutionStore,
  startTuiSessionFn = null,
  workstreamId = null,
} = {}) {
  if (!store) throw new Error("store is required");
  if (!config) throw new Error("config is required");
  if (!resolveTaskRepositoryPlanFn) throw new Error("resolveTaskRepositoryPlanFn is required");
  if (!materializeTaskWorktreeFn) throw new Error("materializeTaskWorktreeFn is required");
  if (!acquireRepoLockFn) throw new Error("acquireRepoLockFn is required");

  const workspaceRoot = config.defaultWorkspaceRoot || config.defaultWorkspaceRootPath;

  /**
   * Resolve the base commit SHA for a given ref.
   */
  function resolveCommitSha(repoPath, ref) {
    try {
      return execFileSync("git", ["rev-parse", ref], {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Execute the full startup flow: resolve plan -> materialize worktree ->
   * verify worktree -> set cwd = task_worktree_path -> create execution -> start TUI.
   *
   * @param {object} params
   * @param {string} params.taskId - Task ID to execute
   * @param {object} [params.context] - Request context
   * @returns {Promise<object>} Execution result including execution_id, session_id, worktree_path
   */
  async function startExecutionWithWorktree({ taskId, context = {} } = {}) {
    if (!taskId) throw new Error("taskId is required");

    // Load state
    const state = await store.load();

    // Find task
    const task = (state?.tasks || []).find((t) => t.id === taskId);
    if (!task) {
      return { status: "failed", kind: "task_not_found", task_id: taskId, error: `Task not found: ${taskId}` };
    }

    // Find or derive goal
    const goal = task.goal_id
      ? (state?.goals || []).find((g) => g.id === task.goal_id)
      : (state?.goals || []).find((g) => g.task_id === task.id);
    if (!goal?.id) {
      return { status: "failed", kind: "goal_not_found", task_id: taskId, error: `No resolvable goal for task: ${taskId}` };
    }

    // Phase 1: resolve plan (no git mutation)
    const plan = await resolveTaskRepositoryPlanFn({ task, goal, config });
    if (!plan) {
      return { status: "failed", kind: "plan_resolution_failed", task_id: taskId, goal_id: goal.id, error: "Repository plan resolution returned null" };
    }

    const canonicalRepoPath = plan.canonical_repo_path || plan.source_root;
    if (!canonicalRepoPath) {
      return { status: "failed", kind: "canonical_repo_missing", task_id: taskId, goal_id: goal.id, error: "No canonical repo path in plan" };
    }

    // Phase 2: materialize worktree (git worktree add)
    const materialized = await materializeTaskWorktreeFn(plan, { config });
    if (!materialized?.worktree_lifecycle?.ok) {
      return {
        status: "failed",
        kind: "worktree_materialization_failed",
        task_id: taskId,
        goal_id: goal.id,
        error: materialized?.worktree_lifecycle?.error || "Worktree materialization returned non-ok status",
        plan,
        materialized,
      };
    }

    const worktreePath = materialized.worktree_lifecycle.worktree_path || plan.task_worktree_path;
    const branch = materialized.worktree_lifecycle.branch_name || plan.task_branch;
    const baseCommit = materialized.worktree_lifecycle.base_sha || plan.base_sha || resolveCommitSha(canonicalRepoPath, plan.base_ref || "HEAD");

    // Phase 3: verify task worktree
    const verification = verifyTaskWorktree({ worktreePath, plan });
    if (!verification.valid) {
      return {
        status: "failed",
        kind: "worktree_verification_failed",
        task_id: taskId,
        goal_id: goal.id,
        worktree_path: worktreePath,
        verification,
        error: verification.error || "Worktree verification failed",
      };
    }

    // Phase 4: cwd = task_worktree_path, lock on worktree
    const lockResult = await acquireRepoLockFn(workspaceRoot, worktreePath, {
      taskId,
      runId: null,
      mode: task.mode || goal.mode || "builder",
    });
    if (!lockResult?.acquired) {
      return {
        status: "failed",
        kind: "worktree_lock_failed",
        task_id: taskId,
        goal_id: goal.id,
        worktree_path: worktreePath,
        held_by_task: lockResult?.heldByTask || null,
        error: lockResult?.reason || "Could not acquire lock on worktree",
      };
    }

    // Phase 5: create execution record
    const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot || worktreePath });
    const execution = await executionStore.createExecution({
      executionId: `exec_${taskId}`,
      workstreamId,
      goalId: goal.id,
      taskId,
      worktreePath,
      branch,
      baseCommit,
      headCommit: null,
      sessionId: null,
      codexThreadId: null,
      metadata: {
        canonical_repo_path: canonicalRepoPath,
        task_title: task.title || null,
        provider: "codex_tui_goal",
        plan,
      },
    });

    // Phase 6: start TUI session within worktree, cwd = task_worktree_path
    let sessionResult = null;
    if (typeof startTuiSessionFn === "function") {
      sessionResult = await startTuiSessionFn({
        task,
        goal,
        cwd: worktreePath,
        repoLockId: lockResult.lock?.safe_repo_id || null,
        execution: {
          id: execution.id,
          worktree_path: worktreePath,
          branch,
        },
      });
    }

    // Update execution with session info
    const sessionId = sessionResult?.id || sessionResult?.session_id || null;
    const updatedExecution = sessionId
      ? await executionStore.updateExecution(execution.id, {
          status: "running",
          session_id: sessionId,
        })
      : execution;

    return {
      status: "running",
      kind: "execution_started",
      task_id: taskId,
      goal_id: goal.id,
      worktree_path: worktreePath,
      canonical_repo_path: canonicalRepoPath,
      branch,
      base_commit: baseCommit,
      execution_id: execution.id,
      session_id: sessionId,
      execution: updatedExecution,
      session: sessionResult || null,
      verification,
    };
  }

  /**
   * Collect completion evidence from a task execution.
   * Checks result files from the worktree path.
   *
   * @param {object} params
   * @param {string} params.executionId - Execution record ID
   * @param {string} params.taskId - Task ID (alternative lookup)
   * @returns {Promise<object>} Completion evidence
   */
  async function collectExecutionCompletion({ executionId, taskId } = {}) {
    let executionRecord = null;

    if (executionId) {
      const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot });
      try {
        executionRecord = await executionStore.readExecution(executionId);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }

    if (!executionRecord && taskId) {
      const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot });
      const matches = await executionStore.findExecutions({ task_id: taskId });
      if (matches.length > 0) {
        executionRecord = matches[0];
      }
    }

    if (!executionRecord) {
      return { kind: "execution_not_found", status: "failed", execution_id: executionId, task_id: taskId };
    }

    const worktreePath = executionRecord.worktree_path;
    if (!worktreePath) {
      return { kind: "no_worktree_path", status: "failed", execution_id: executionRecord.id };
    }

    // Check result files from worktree
    const goalId = executionRecord.goal_id;
    let resultJson = null;
    let resultMd = null;
    try {
      const { readFile, access: asyncAccess } = await import("node:fs/promises");
      const { constants: asyncConstants } = await import("node:fs");
      const { join } = await import("node:path");
      const goalDir = join(worktreePath, ".gptwork", "goals", goalId);
      try {
        await asyncAccess(join(goalDir, "result.json"), asyncConstants.F_OK);
        resultJson = JSON.parse(await readFile(join(goalDir, "result.json"), "utf8"));
      } catch {}
      try {
        await asyncAccess(join(goalDir, "result.md"), asyncConstants.F_OK);
        resultMd = await readFile(join(goalDir, "result.md"), "utf8");
      } catch {}
    } catch {}

    // Resolve head commit from worktree
    let headCommit = null;
    try {
      headCommit = resolveCommitSha(worktreePath, "HEAD");
    } catch {}

    // Update execution record
    const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot });
    const patch = { status: resultJson ? "completed" : "no_result" };
    if (headCommit) patch.head_commit = headCommit;
    await executionStore.updateExecution(executionRecord.id, patch);

    return {
      kind: "execution_completion",
      status: patch.status,
      execution_id: executionRecord.id,
      task_id: executionRecord.task_id,
      goal_id: goalId,
      worktree_path: worktreePath,
      head_commit: headCommit,
      base_commit: executionRecord.base_commit,
      result_json: resultJson,
      result_md_present: Boolean(resultMd),
      changed_files: resultJson?.changed_files || [],
      tests: resultJson?.tests || resultJson?.verification?.commands || null,
      commit: resultJson?.commit || headCommit || executionRecord.head_commit || "none",
    };
  }

  /**
   * Verify a task worktree is valid for execution.
   *
   * @param {object} params
   * @param {string} params.worktreePath - Path to the worktree
   * @param {object} [params.plan] - Repository plan (optional)
   * @returns {object} Verification result { valid, error, details }
   */
  function verifyTaskWorktree({ worktreePath, plan } = {}) {
    const details = {};
    const errors = [];

    if (!worktreePath) {
      return { valid: false, error: "worktreePath is required", details: {} };
    }

    // Check path exists
    details.path_exists = existsSync(worktreePath);
    if (!details.path_exists) {
      errors.push("worktree path does not exist on disk");
    }

    // Check if it's a git worktree
    if (details.path_exists) {
      try {
        const isWorktree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
        details.is_git_worktree = isWorktree === "true";
        if (!details.is_git_worktree) {
          errors.push("path exists but is not a git worktree");
        }
      } catch {
        details.is_git_worktree = false;
        errors.push("cannot determine git worktree status");
      }
    }

    // Check branch is correct
    if (details.is_git_worktree && plan?.task_branch) {
      try {
        const currentBranch = execFileSync("git", ["branch", "--show-current"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
        details.current_branch = currentBranch;
        if (currentBranch !== plan.task_branch) {
          errors.push(`branch mismatch: expected ${plan.task_branch}, got ${currentBranch}`);
        }
      } catch (err) {
        errors.push(`cannot read branch: ${err.message}`);
      }
    }

    // Check worktree path is under workspace
    const wsRoot = config?.defaultWorkspaceRoot || process.cwd();
    if (!worktreePath.startsWith(wsRoot + "/") && worktreePath !== wsRoot) {
      errors.push("worktree path is not under workspace root");
      details.within_workspace = false;
    } else {
      details.within_workspace = true;
    }

    return {
      valid: errors.length === 0,
      error: errors.length > 0 ? errors.join("; ") : null,
      errors,
      details,
    };
  }

  /**
   * Release lock on a worktree associated with an execution.
   *
   * @param {object} params
   * @param {string} params.executionId - Execution record ID
   * @param {string} [params.taskId] - Task ID (alternative)
   * @returns {Promise<object>} Release result
   */
  async function releaseExecutionLock({ executionId, taskId } = {}) {
    let worktreePath = null;

    if (executionId) {
      const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot });
      try {
        const record = await executionStore.readExecution(executionId);
        worktreePath = record.worktree_path;
      } catch {}
    }

    if (!worktreePath && taskId) {
      const executionStore = createExecutionStoreFn({ workspaceRoot: config.defaultWorkspaceRoot });
      const matches = await executionStore.findExecutions({ task_id: taskId });
      if (matches.length > 0) {
        worktreePath = matches[0].worktree_path;
      }
    }

    if (!worktreePath) {
      return { ok: false, error: "no worktree path resolved from execution", execution_id: executionId, task_id: taskId };
    }

    if (typeof releaseRepoLockFn !== "function") {
      return { ok: false, error: "releaseRepoLockFn not provided", worktree_path: worktreePath };
    }

    try {
      await releaseRepoLockFn(workspaceRoot, worktreePath, taskId);
      return { ok: true, worktree_path: worktreePath, released: true };
    } catch (err) {
      return { ok: false, error: err?.message || "release failed", worktree_path: worktreePath };
    }
  }

  return {
    startExecutionWithWorktree,
    collectExecutionCompletion,
    verifyTaskWorktree,
    releaseExecutionLock,
  };
}
