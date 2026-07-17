import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexTuiEvidenceCycle } from "../src/codex-tui-evidence-cycle.mjs";

test("TUI evidence cycle repairs the same session once before timing out", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-"));
  const goal = { id: "goal_missing" };
  const sent = [];
  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_missing" },
    goal,
    sessionId: "session_missing",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    collectFn: async () => ({ result_json: null }),
    sendInputFn: async (sessionId, input) => sent.push({ sessionId, input }),
  });

  assert.equal(out.evidence_ready, false);
  assert.equal(out.reason, "tui_result_json_missing");
  assert.equal(out.timed_out, true);
  assert.equal(out.repair_attempted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "session_missing");
  assert.match(sent[0].input, /result\.json/);
  assert.match(sent[0].input, /continue/i);
  assert.equal(out.finding.code, "tui_result_json_timeout");
});

test("TUI evidence cycle accepts evidence produced by the same-session repair", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-evidence-repair-"));
  const goal = { id: "goal_repaired" };
  const dir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  const resultPath = join(dir, "result.json");
  await mkdir(dir, { recursive: true });
  let sends = 0;

  const out = await runCodexTuiEvidenceCycle({
    task: { id: "task_repaired" },
    goal,
    sessionId: "session_repaired",
    workspaceRoot,
    maxWaitMs: 1,
    pollMs: 1,
    sleepFn: async () => {},
    sendInputFn: async () => {
      sends += 1;
      await writeFile(resultPath, JSON.stringify({
        status: "completed",
        summary: "repaired evidence",
        changed_files: [],
        tests: [],
        commit: null,
        remote_head: null,
        warnings: [],
        followups: [],
        verification: { passed: true, commands: [] },
      }));
    },
    collectFn: async () => ({ result_json: { status: "completed" } }),
  });

  assert.equal(sends, 1);
  assert.equal(out.evidence_ready, true);
  assert.equal(out.repair_attempted, true);
  assert.equal(out.reason, "tui_result_json_collected_after_repair");
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
