import { randomUUID } from "node:crypto";

export const EXECUTION_ATTEMPT_SCHEMA_VERSION = 1;
export const EXECUTION_ATTEMPT_STATES = Object.freeze([
  "starting",
  "running",
  "evidence_ready",
  "completed",
  "failed",
  "timed_out",
  "provider_unavailable",
  "waiting_for_supervisor",
]);

export const ACTIVE_EXECUTION_ATTEMPT_STATES = new Set(["starting", "running", "evidence_ready"]);
export const TERMINAL_EXECUTION_ATTEMPT_STATES = new Set([
  "completed",
  "failed",
  "timed_out",
  "provider_unavailable",
  "waiting_for_supervisor",
]);

const PROVIDERS = new Set(["codex_exec", "codex_tui"]);

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function validateExecutionAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") throw new Error("execution attempt must be an object");
  requiredString(attempt.id, "attempt.id");
  requiredString(attempt.task_id, "attempt.task_id");
  if (!PROVIDERS.has(attempt.provider)) throw new Error(`unsupported execution provider: ${attempt.provider}`);
  if (!EXECUTION_ATTEMPT_STATES.includes(attempt.state)) throw new Error(`invalid execution attempt state: ${attempt.state}`);
  if (!Number.isInteger(attempt.attempt_number) || attempt.attempt_number < 1) {
    throw new Error("attempt.attempt_number must be a positive integer");
  }
  return attempt;
}

export function createExecutionAttempt({
  id = `attempt_${randomUUID()}`,
  taskId,
  goalId = null,
  provider,
  providerRevision = null,
  attemptNumber,
  pathContext = null,
  inputSnapshot = null,
  checkpoint = null,
  now = new Date().toISOString(),
} = {}) {
  return validateExecutionAttempt({
    schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
    id,
    task_id: requiredString(taskId, "taskId"),
    goal_id: goalId ? String(goalId) : null,
    provider: requiredString(provider, "provider"),
    provider_revision: providerRevision ? String(providerRevision) : null,
    state: "starting",
    path_context: pathContext && typeof pathContext === "object" ? structuredClone(pathContext) : null,
    input_snapshot: inputSnapshot && typeof inputSnapshot === "object" ? structuredClone(inputSnapshot) : null,
    checkpoint: checkpoint && typeof checkpoint === "object" ? structuredClone(checkpoint) : null,
    provider_handle: null,
    evidence: null,
    failure: null,
    attempt_number: Number(attemptNumber),
    created_at: now,
    updated_at: now,
  });
}
