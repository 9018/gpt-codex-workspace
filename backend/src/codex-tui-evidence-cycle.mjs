import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { collectCodexTuiCompletion } from "./codex-tui-completion-collector.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult({ resultJsonPath, now, sleepFn, maxWaitMs, pollMs }) {
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    if (existsSync(resultJsonPath)) return true;
    await sleepFn(pollMs);
  }
  return existsSync(resultJsonPath);
}

async function writeJsonAtomic(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Run the TUI evidence collection cycle. Missing or invalid result.json is
 * reconstructed from existing TUI/session/Git/result.md evidence. A surviving
 * result.partial.json is progress evidence only and is never treated as task
 * completion. This function never re-enters the TUI session, creates repair or
 * follow-up work, or reruns the task. Insufficient evidence goes to review.
 */
export async function runCodexTuiEvidenceCycle({
  task,
  goal,
  sessionId,
  workspaceRoot,
  collectFn = collectCodexTuiCompletion,
  now = Date.now,
  sleepFn = sleep,
  // Retained for backwards-compatible callers. Intentionally never invoked.
  sendInputFn = null,
  maxWaitMs = 120_000,
  pollMs = 5_000,
} = {}) {
  if (!goal?.id) throw new Error("goal.id is required");
  if (!sessionId) throw new Error("sessionId is required");

  const goalDir = join(workspaceRoot, ".gptwork", "goals", goal.id);
  const resultJsonPath = join(goalDir, "result.json");
  const partialResultJsonPath = join(goalDir, "result.partial.json");
  const resultJsonObserved = await waitForResult({ resultJsonPath, now, sleepFn, maxWaitMs, pollMs });
  const partialResultObserved = existsSync(partialResultJsonPath);
  const collected = await collectFn({ sessionId, workspaceRoot });
  const reconstructed = collected?.reconstructed_result || null;
  const resultJsonUsable = Boolean(collected?.result_json && collected?.result_json_valid !== false);
  const closureProvable = collected?.ready_for_review === true;

  if (!resultJsonUsable) {
    if (closureProvable && reconstructed) {
      await writeJsonAtomic(resultJsonPath, reconstructed);
    }
    const code = resultJsonObserved
      ? "tui_result_json_invalid_reconstructed"
      : partialResultObserved
        ? "tui_result_partial_only_reconstructed"
        : "tui_result_json_missing_reconstructed";
    return {
      evidence_ready: closureProvable,
      reason: code,
      status: closureProvable ? "ready" : "waiting_for_review",
      requires_human_review: !closureProvable,
      retry_original_task: false,
      create_followup: false,
      create_repair_task: false,
      repair_attempted: false,
      session_id: sessionId,
      goal_id: goal.id,
      task_id: task?.id || null,
      expected_result_json: resultJsonPath,
      observed_partial_result_json: partialResultObserved ? partialResultJsonPath : null,
      expected_result_md: join(goalDir, "result.md"),
      finding: {
        severity: closureProvable ? "warning" : "blocker",
        code,
        message: closureProvable
          ? "The final result.json was unavailable, but existing TUI session, Git/worktree, command and result.md evidence was sufficient to reconstruct reviewable structured evidence."
          : partialResultObserved
            ? "Only result.partial.json was present. It is progress evidence, not completion evidence; route to human review without retrying or creating repair/follow-up work."
            : "result.json was unavailable and existing evidence could not prove closure; route to human review without retrying or creating repair/follow-up work.",
      },
      reconstructed_result: reconstructed,
      collected,
    };
  }

  return {
    evidence_ready: true,
    reason: "tui_result_json_collected",
    status: "ready",
    repair_attempted: false,
    retry_original_task: false,
    create_followup: false,
    create_repair_task: false,
    session_id: sessionId,
    goal_id: goal.id,
    task_id: task?.id || null,
    observed_partial_result_json: partialResultObserved ? partialResultJsonPath : null,
    collected,
  };
}
