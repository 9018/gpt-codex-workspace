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
 * Returns { evidence_ready, reason, finding?, collected? } with a terminal
 * status when the evidence deadline is reached without durable artifacts.
 *
 * P0: When the poll loop times out, the result is a terminal evidence failure
 * (status=timed_out), NOT a transient waiting_for_review. Callers must use
 * the returned status to determine whether to transition to failed/timed_out.
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
  let timedOut = true;

  while (now() < deadline) {
    if (existsSync(resultJsonPath)) { timedOut = false; break; }
    await sleepFn(pollMs);
  }

  const collected = await collectFn({ sessionId, workspaceRoot });

  if (timedOut) {
    return {
      evidence_ready: false,
      reason: "tui_result_json_missing",
      status: "timed_out",
      timed_out: true,
      session_id: sessionId,
      goal_id: goal.id,
      task_id: task?.id || null,
      expected_result_json: resultJsonPath,
      expected_result_md: join(workspaceRoot, ".gptwork", "goals", goal.id, "result.md"),
      finding: {
        severity: "blocker",
        code: "tui_result_json_timeout",
        message: `TUI session timed out waiting for result file: ${resultJsonPath} after ${maxWaitMs}ms. No durable evidence was produced.`,
      },
      collected,
    };
  }

  if (!collected?.result_json && !collected?.result?.result_json_valid) {
    return {
      evidence_ready: false,
      reason: "tui_result_json_collected_invalid",
      status: "failed",
      session_id: sessionId,
      goal_id: goal.id,
      task_id: task?.id || null,
      expected_result_json: resultJsonPath,
      expected_result_md: join(workspaceRoot, ".gptwork", "goals", goal.id, "result.md"),
      finding: {
        severity: "blocker",
        code: "tui_result_json_collected_invalid",
        message: `Result file exists at ${resultJsonPath} but could not be parsed or lacks valid content.`,
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
