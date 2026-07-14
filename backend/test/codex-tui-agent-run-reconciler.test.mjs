import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { createAgentRun } from "../src/agent-run-service.mjs";
import { reconcileTuiAgentRunsFromProgress } from "../src/codex-tui-agent-run-reconciler.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

test("diagnostic TUI progress reconciles matching queued formal and advisory runs", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "tui-agent-reconcile-")));
  const store = new StateStore({ statePath: join(root, ".gptwork", "state.json"), defaultWorkspaceRoot: root });
  const taskId = "task_diag";
  const goalId = "goal_diag";
  const digest = "sha256:diag";
  await store.mutate((state) => {
    state.tasks.push({ id: taskId, goal_id: goalId, pipeline_version: "task_pipeline_v2", task_context_digest: digest, acceptance_contract: { intent: { operation_kind: "diagnostic", mutation_scope: "none" }, requirements: { requires_commit: false } } });
    state.goals.push({ id: goalId, task_id: taskId, task_context: { contract_digest: digest }, acceptance_contract: { intent: { operation_kind: "diagnostic", mutation_scope: "none" }, requirements: { requires_commit: false } } });
    state.advisory_runs = ["explorer", "architect", "test_analyst"].map((role, index) => ({ id: `advisory_${index}`, task_id: taskId, goal_id: goalId, role, role_kind: "advisory", blocking: false, status: "queued", input_context_digest: digest, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  });
  const formal = [];
  for (const role of ["context_curator", "planner", "builder", "verifier", "reviewer", "finalizer"]) {
    const created = await createAgentRun(store, { task_id: taskId, goal_id: goalId, role, status: "queued", input_context_digest: digest, require_fresh_artifacts: true, role_view_path: `.gptwork/goals/${goalId}/roles/${role}.view.json`, role_view_digest: `sha256:${role}` });
    formal.push(created.agent_run);
  }
  const goalDir = join(root, ".gptwork", "goals", goalId);
  await mkdir(goalDir, { recursive: true });
  const subagents = [
    ...formal.map((run) => ({ role: run.role, agent_run_id: run.id, status: "completed", input_context_digest: digest, summary: `${run.role} complete` })),
    ...["explorer", "architect", "test_analyst"].map((role, index) => ({ role, agent_run_id: `advisory_${index}`, status: "completed", input_context_digest: digest, summary: `${role} complete` })),
  ];
  await writeFile(join(goalDir, "progress.json"), JSON.stringify({ phase: "completed", status: "completed", subagents }));
  await writeFile(join(goalDir, "result.json"), JSON.stringify({ status: "verified", execution_mode: "readonly_diagnostic", summary: "all checks pass", verification: { passed: true }, blockers: [] }));
  await writeFile(join(goalDir, "result.md"), "# Diagnostic complete\n");
  await writeFile(join(goalDir, "context.bundle.md"), "# Context\n");

  const result = await reconcileTuiAgentRunsFromProgress({ store, workspaceRoot: root, snapshot: { task_id: taskId, goal_id: goalId, result_json_valid: true, result_json: { status: "verified", execution_mode: "readonly_diagnostic", summary: "all checks pass", verification: { passed: true }, blockers: [] }, result_json_path: join(goalDir, "result.json"), result_md_path: join(goalDir, "result.md"), worktree_clean: true, commit: null, task_context_digest: digest } });
  assert.equal(result.reconciled, true);
  assert.equal(result.formal_completed, 6);
  assert.equal(result.advisory_completed, 3);
  const state = await store.load();
  const formalState = state.agent_runs.filter((run) => run.task_id === taskId);
  assert.ok(formalState.every((run) => run.status === "completed"));
  assert.ok(formalState.every((run) => run.output_artifacts.length > 0));
  assert.ok(formalState.every((run) => run.output_artifacts[0].metadata?.context_digest === digest));
  assert.ok(state.advisory_runs.every((run) => run.status === "completed"));
});

test("diagnostic reconciliation accepts passed tests and blocking acceptance criteria without verification.passed", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "tui-agent-reconcile-tests-")));
  const store = new StateStore({ statePath: join(root, ".gptwork", "state.json"), defaultWorkspaceRoot: root });
  const digest = "sha256:tests-pass";
  await store.mutate((state) => {
    state.tasks.push({ id: "task_tests", goal_id: "goal_tests", pipeline_version: "task_pipeline_v2", task_context_digest: digest, acceptance_contract: { intent: { operation_kind: "diagnostic", mutation_scope: "none" }, requirements: { requires_commit: false } } });
    state.goals.push({ id: "goal_tests", task_id: "task_tests", task_context: { contract_digest: digest } });
  });
  const created = await createAgentRun(store, { task_id: "task_tests", goal_id: "goal_tests", role: "finalizer", status: "queued", input_context_digest: digest, require_fresh_artifacts: true });
  const goalDir = join(root, ".gptwork", "goals", "goal_tests");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "progress.json"), JSON.stringify({ subagents: [{ role: "finalizer", agent_run_id: created.agent_run.id, status: "pending", input_context_digest: digest }] }));
  await writeFile(join(goalDir, "result.json"), "{}");
  await writeFile(join(goalDir, "result.md"), "# Done\n");
  const result = await reconcileTuiAgentRunsFromProgress({ store, workspaceRoot: root, snapshot: {
    task_id: "task_tests", goal_id: "goal_tests", task_context_digest: digest, result_json_valid: true, worktree_clean: true,
    result_json_path: join(goalDir, "result.json"), result_md_path: join(goalDir, "result.md"),
    result_json: { status: "verified", execution_mode: "readonly_diagnostic", tests: { passed: 4, failed: 0 }, acceptance_criteria: [{ id: "a", blocking: true, status: "pass" }], blockers: [] },
  } });
  assert.equal(result.reconciled, true);
  const state = await store.load();
  assert.equal(state.agent_runs.find((run) => run.id === created.agent_run.id).status, "completed");
});

test("reconciler refuses progress with a mismatched context digest", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "tui-agent-reconcile-mismatch-")));
  const store = new StateStore({ statePath: join(root, ".gptwork", "state.json"), defaultWorkspaceRoot: root });
  await store.mutate((state) => {
    state.tasks.push({ id: "task_x", goal_id: "goal_x", pipeline_version: "task_pipeline_v2", task_context_digest: "sha256:expected", acceptance_contract: { intent: { operation_kind: "diagnostic", mutation_scope: "none" }, requirements: { requires_commit: false } } });
    state.goals.push({ id: "goal_x", task_id: "task_x", task_context: { contract_digest: "sha256:expected" } });
  });
  const goalDir = join(root, ".gptwork", "goals", "goal_x");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "progress.json"), JSON.stringify({ status: "completed", subagents: [{ role: "builder", agent_run_id: "missing", status: "completed", input_context_digest: "sha256:wrong" }] }));
  const result = await reconcileTuiAgentRunsFromProgress({ store, workspaceRoot: root, snapshot: { task_id: "task_x", goal_id: "goal_x", result_json_valid: true, result_json: { status: "verified", execution_mode: "readonly_diagnostic", verification: { passed: true } }, worktree_clean: true, task_context_digest: "sha256:wrong" } });
  assert.equal(result.reconciled, false);
  assert.equal(result.reason, "session_context_digest_mismatch");
});
