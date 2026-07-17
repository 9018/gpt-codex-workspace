/**
 * supervisor-errors.mjs — Supervisor domain errors.
 *
 * @module supervisor-errors
 */

export class SupervisorError extends Error {
  constructor(message, { code = "SUPERVISOR_ERROR", details = null } = {}) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.details = details;
  }
}

export class SupervisorPlanNotFoundError extends SupervisorError {
  constructor(planId) {
    super(`SupervisorPlan not found: ${planId}`, { code: "PLAN_NOT_FOUND", details: { planId } });
    this.name = "SupervisorPlanNotFoundError";
  }
}

export class SupervisorCheckpointNotFoundError extends SupervisorError {
  constructor(checkpointId) {
    super(`SupervisorCheckpoint not found: ${checkpointId}`, { code: "CHECKPOINT_NOT_FOUND", details: { checkpointId } });
    this.name = "SupervisorCheckpointNotFoundError";
  }
}

export class SupervisorTakeoverError extends SupervisorError {
  constructor(message, details = {}) {
    super(message, { code: "TAKEOVER_ERROR", details });
    this.name = "SupervisorTakeoverError";
  }
}

export class SupervisorPolicyError extends SupervisorError {
  constructor(message, details = {}) {
    super(message, { code: "POLICY_ERROR", details });
    this.name = "SupervisorPolicyError";
  }
}
