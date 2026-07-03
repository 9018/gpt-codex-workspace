/**
 * verify-agent-run-writeback-e2e.mjs — Narrow MA3 convergence self-test.
 *
 * Proves that the AgentRun writeback path produces non-empty agent_runs
 * when exercised with the same calls as the main task pipeline (processGeneralTask).
 *
 * Run: node --test backend/test/verify-agent-run-writeback-e2e.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(dir, "..");
const statePath = resolve(repoRoot, "data/workspaces/default/.gptwork/state.json");

describe("MA3 AgentRun writeback convergence", () => {
  let store;
  let tmpStatePath;
  let tmpDir;
  let goalId;
  let taskId;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ma3-verify-"));
    tmpStatePath = join(tmpDir, "state.json");
    copyFileSync(statePath, tmpStatePath);

    const { StateStore } = await import(resolve(repoRoot, "src/state-store.mjs"));
    store = new StateStore({
      statePath: tmpStatePath,
      defaultWorkspaceRoot: resolve(repoRoot),
    });

    // Create mock goal and task
    goalId = `goal_verify_${randomUUID().slice(0, 8)}`;
    taskId = `task_verify_${randomUUID().slice(0, 8)}`;

    await store.mutate((state) => {
      state.goals.push({
        id: goalId,
        title: "Verify MA3 convergence",
        user_request: "Verify MA3 convergence after direct recovery",
        workspace_id: "hosted-default",
        project_id: "default",
        status: "assigned",
        created_at: new Date().toISOString(),
      });
      state.tasks.push({
        id: taskId,
        goal_id: goalId,
        title: "Verify MA3 agent-run writeback",
        status: "assigned",
        assignee: "codex",
        mode: "builder",
        workspace_id: "hosted-default",
        project_id: "default",
        created_at: new Date().toISOString(),
      });
      return state;
    });
  });

  after(() => {
    try { unlinkSync(tmpStatePath); } catch {}
    try { require("fs").rmdirSync(tmpDir); } catch {}
  });

  it("1) context_curator writeback creates agent_run", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const workspaceFiles = {
      codex_entry_md: `.gptwork/goals/${goalId}/codex.entry.md`,
      context_bundle_md: `.gptwork/goals/${goalId}/context.bundle.md`,
      context_manifest_json: `.gptwork/goals/${goalId}/context.manifest.json`,
    };
    const result = await mod.writeContextCuratorAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      artifacts: {
        codex_entry: { path: workspaceFiles.codex_entry_md, required: true },
        context_bundle: { path: workspaceFiles.context_bundle_md, required: true },
        context_manifest: { path: workspaceFiles.context_manifest_json, required: true },
      },
    }, {});
    assert.equal(result.created, true, `Expected created=true, got ${JSON.stringify(result)}`);
    assert.equal(result.role, "context_curator");
  });

  it("2) builder writeback creates agent_run", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const result = await mod.writeBuilderAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      taskResult: {
        status: "completed",
        changed_files: ["backend/src/agent-run-writeback.mjs"],
        commit: "686cd8f03344da0992681850963ffa9583a857e7",
      },
      summary: "AgentRun writeback integration verified",
    }, {});
    assert.equal(result.created, true, `Expected created=true, got ${JSON.stringify(result)}`);
    assert.equal(result.role, "builder");
  });

  it("3) integrator writeback creates agent_run", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const result = await mod.writeIntegratorAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      integrationResult: { status: "ff_only_merged", merged: true },
    }, {});
    assert.ok(result.created || result.updated, `Expected created/updated, got ${JSON.stringify(result)}`);
    assert.equal(result.role, "integrator");
  });

  it("4) repairer writeback creates agent_run (no parent skip)", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const result = await mod.writeRepairerAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      repairOutcome: { passed: false, repair_outcome: "skipped_no_parent", reason: "Not a repair task" },
    }, {});
    assert.equal(result.created, true, `Expected created=true, got ${JSON.stringify(result)}`);
    assert.equal(result.role, "repairer");
  });

  it("5) listAgentRuns returns non-empty with expected roles", async () => {
    const svc = await import(resolve(repoRoot, "src/agent-run-service.mjs"));
    const allRuns = await svc.listAgentRuns(store, { task_id: taskId });
    assert.ok(allRuns.agent_runs, "Missing agent_runs field");
    assert.ok(allRuns.agent_runs.length >= 4,
      `Expected at least 4 agent_runs, got ${allRuns.agent_runs.length}`);

    const roles = allRuns.agent_runs.map(r => r.role);
    const expected = ["context_curator", "builder", "integrator", "repairer"];
    for (const role of expected) {
      assert.ok(roles.includes(role),
        `Expected role "${role}" in [${roles.join(", ")}]`);
    }
  });

  it("6) duplicate context_curator writeback skips (idempotent)", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const dup = await mod.writeContextCuratorAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      artifacts: {
        codex_entry: { path: "entry.md", required: true },
      },
    }, {});
    assert.equal(dup.skipped, true, `Expected skipped=true for duplicate, got ${JSON.stringify(dup)}`);
  });

  it("7) duplicate repairer writeback updates not creates (idempotent)", async () => {
    const mod = await import(resolve(repoRoot, "src/agent-run-writeback.mjs"));
    const dup = await mod.writeRepairerAgentRun(store, {
      task_id: taskId,
      goal_id: goalId,
      repairOutcome: { passed: true, repair_outcome: "no_repair_needed", reason: "Already clean" },
    }, {});
    assert.equal(dup.created, false, `Expected no new creation, got ${JSON.stringify(dup)}`);
    assert.equal(dup.updated, true, `Expected updated=true for duplicate repair, got ${JSON.stringify(dup)}`);
  });
});
