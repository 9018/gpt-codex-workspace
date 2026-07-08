import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectCodexTuiCompletion } from "./codex-tui-completion-collector.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the TUI evidence collection cycle: poll for result.json, then collect
 * durable evidence via collectCodexTuiCompletion.
 *
 * Returns { evidence_ready, reason, finding?, collected? }.
 */
export async function runCodexTuiEvidenceCycle({
  task,
  goal,
  sessionId,
  workspaceRoot,
  collectFn = collectCodexTuiCompletion,
  now = Date.now,
  sleepFn = sleep,
  maxWaitMs = 120_000,
  pollMs = 5_000,
} = {}) {
  if (!goal?.id) throw new Error("goal.id is required");
  if (!sessionId) throw new Error("sessionId is required");

  const resultJsonPath = join(workspaceRoot, ".gptwork", "goals", goal.id, "result.json");
  const deadline = now() + maxWaitMs;

  while (now() < deadline) {
    if (existsSync(resultJsonPath)) break;
    await sleepFn(pollMs);
  }

  const collected = await collectFn({ sessionId, workspaceRoot });

  if (!collected?.result_json && !collected?.result?.result_json_valid) {
    return {
      evidence_ready: false,
      reason: "tui_result_json_missing",
      status: "not_ready",
      session_id: sessionId,
      goal_id: goal.id,
      task_id: task?.id || null,
      expected_result_json: resultJsonPath,
      expected_result_md: join(workspaceRoot, ".gptwork", "goals", goal.id, "result.md"),
      finding: {
        severity: "major",
        code: "tui_result_json_missing",
        message: `Missing durable result file: ${resultJsonPath}`,
      },
      collected,
    };
  }

  return {
    evidence_ready: true,
    reason: "tui_result_json_collected",
    status: "ready",
    session_id: sessionId,
    goal_id: goal.id,
    task_id: task?.id || null,
    collected,
  };
}
