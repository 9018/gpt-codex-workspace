import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexTuiEvidenceCycle } from "../src/codex-tui-evidence-cycle.mjs";

test("TUI evidence cycle returns missing when result.json is absent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-"));
  const goal = { id: "goal_missing" };
  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_missing" },
    goal,
    sessionId: "session_missing",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    collectFn: async () => ({ result_json: null }),
  });

  assert.equal(out.evidence_ready, false);
  assert.equal(out.reason, "tui_result_json_missing");
  assert.equal(out.finding.code, "tui_result_json_missing");
});

test("TUI evidence cycle returns ready when result.json exists", async () => {
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
    collectFn: async () => ({ result_json: { ok: true } }),
  });

  assert.equal(out.evidence_ready, true);
  assert.equal(out.reason, "tui_result_json_collected");
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
