import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAcceptanceResponse, ingestAcceptanceResponse } from "../src/gptchat-acceptance/response-ingestor.mjs";

test("parseAcceptanceResponse accepts fenced JSON decisions", () => {
  const parsed = parseAcceptanceResponse('```json\n{"decision":"accepted","summary":"ok","findings":[]}\n```');

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.decision, "accepted");
  assert.equal(parsed.summary, "ok");
});

test("ingestAcceptanceResponse writes GPTChat acceptance to portable goal result.json path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptchat-acceptance-ingestor-"));
  const goalDir = join(root, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({ task_id: "task_1", status: "waiting_for_review" }, null, 2));

  const state = {
    tasks: [{ id: "task_1", goal_id: "goal_1", status: "waiting_for_review", result: null }],
    goals: [{ id: "goal_1", task_id: "task_1", workspace_root: root }],
  };
  const store = {
    async load() { return state; },
    async mutate(fn) { fn(state); },
  };

  const result = await ingestAcceptanceResponse({
    store,
    taskId: "task_1",
    responseText: JSON.stringify({ decision: "accepted", summary: "verified by GPTChat", findings: [] }),
    task: state.tasks[0],
    goal: state.goals[0],
  });

  assert.equal(result.ingested, true);
  assert.equal(result.decision, "accepted");
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(state.tasks[0].result.acceptance.status, "accepted");

  const resultJson = JSON.parse(await readFile(join(goalDir, "result.json"), "utf8"));
  assert.equal(resultJson.gptchat_acceptance.decision, "accepted");
  assert.equal(resultJson.gptchat_acceptance.summary, "verified by GPTChat");
});
