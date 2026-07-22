import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexTuiEvidenceCycle } from "../src/codex-tui-evidence-cycle.mjs";

test("TUI result.json missing does not re-enter session, retry, repair, or create follow-up", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-"));
  const sent = [];
  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_missing" },
    goal: { id: "goal_missing" },
    sessionId: "session_missing",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    collectFn: async () => ({
      result_json: null,
      result_json_valid: false,
      ready_for_review: false,
      changed_files: [],
      tests: null,
      commit: null,
      worktree_clean: true,
    }),
    sendInputFn: async (sessionId, input) => sent.push({ sessionId, input }),
  });

  assert.equal(out.evidence_ready, false);
  assert.equal(out.reason, "tui_result_json_missing_reconstructed");
  assert.equal(out.status, "waiting_for_review");
  assert.equal(out.requires_human_review, true);
  assert.equal(out.retry_original_task, false);
  assert.equal(out.create_repair_task, false);
  assert.equal(out.create_followup, false);
  assert.equal(out.repair_attempted, false);
  assert.equal(sent.length, 0);
  assert.equal(out.finding.code, "tui_result_json_missing_reconstructed");
});

test("TUI result.json missing uses reconstructed evidence when closure is provable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-reconstructed-"));
  const reconstructed = {
    status: null,
    outcome: "unknown",
    changed_files: ["backend/src/example.mjs"],
    tests: [{ command: "node --test", exit_code: 0 }],
    commit: "abcdef1",
    verification: { passed: null },
    source: "tui_evidence_reconstruction",
  };
  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_reconstructed" },
    goal: { id: "goal_reconstructed" },
    sessionId: "session_reconstructed",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    collectFn: async () => ({
      result_json: null,
      result_json_valid: false,
      ready_for_review: true,
      reconstructed_result: reconstructed,
    }),
  });

  assert.equal(out.evidence_ready, true);
  assert.equal(out.status, "ready");
  assert.equal(out.requires_human_review, false);
  assert.equal(out.retry_original_task, false);
  assert.equal(out.create_repair_task, false);
  assert.equal(out.create_followup, false);
  assert.deepEqual(out.reconstructed_result, reconstructed);
  const persisted = JSON.parse(await readFile(join(workspaceRoot, ".gptwork", "goals", "goal_reconstructed", "result.json"), "utf8"));
  assert.deepEqual(persisted, reconstructed);
  assert.equal(out.finding.severity, "warning");
});

test("TUI evidence cycle returns ready when valid result.json exists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-"));
  const goal = { id: "goal_ready" };
  const dir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.json"), JSON.stringify({
    changed_files: ["backend/src/example.mjs"],
    tests: "node --test passed",
    commit: "abcdef1",
    verification: { passed: true },
  }));

  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_ready" },
    goal,
    sessionId: "session_ready",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    collectFn: async () => ({ result_json: { ok: true }, result_json_valid: true }),
  });

  assert.equal(out.evidence_ready, true);
  assert.equal(out.reason, "tui_result_json_collected");
  assert.equal(out.retry_original_task, false);
  assert.equal(out.create_repair_task, false);
  assert.equal(out.create_followup, false);
});

test("TUI evidence cycle throws when goal.id is missing", async () => {
  await assert.rejects(
    () => runCodexTuiEvidenceCycle({ task: {}, goal: {}, sessionId: "s" }),
    /goal\.id is required/,
  );
});

test("TUI evidence cycle throws when sessionId is missing", async () => {
  await assert.rejects(
    () => runCodexTuiEvidenceCycle({ task: {}, goal: { id: "g" }, sessionId: "" }),
    /sessionId is required/,
  );
});


test("TUI partial result while session active continues waiting instead of human review", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-partial-active-"));
  const goal = { id: "goal_partial_active" };
  const dir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.partial.json"), JSON.stringify({ status: "running", phase: "building" }));

  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_partial_active" },
    goal,
    sessionId: "session_partial_active",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    postTerminalGraceMs: 0,
    sleepFn: async () => {},
    getSessionStatusFn: async () => ({ status: "running" }),
    collectFn: async () => ({
      result_json: null,
      result_json_valid: false,
      ready_for_review: false,
    }),
  });

  assert.equal(out.evidence_ready, false);
  assert.equal(out.continue_waiting, true);
  assert.equal(out.status, "running");
  assert.equal(out.requires_human_review, false);
  assert.equal(out.reason, "tui_result_partial_session_active");
  assert.equal(out.retry_original_task, false);
  assert.equal(out.create_repair_task, false);
});

test("TUI partial result after session finished parks human review", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-partial-done-"));
  const goal = { id: "goal_partial_done" };
  const dir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.partial.json"), JSON.stringify({ status: "running", phase: "building" }));

  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_partial_done" },
    goal,
    sessionId: "session_partial_done",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    postTerminalGraceMs: 0,
    sleepFn: async () => {},
    getSessionStatusFn: async () => ({ status: "stopped" }),
    collectFn: async () => ({
      result_json: null,
      result_json_valid: false,
      ready_for_review: false,
    }),
  });

  assert.equal(out.evidence_ready, false);
  assert.equal(out.continue_waiting, false);
  assert.equal(out.status, "waiting_for_review");
  assert.equal(out.reason, "tui_result_partial_only_reconstructed");
  assert.equal(out.requires_human_review, true);
});
