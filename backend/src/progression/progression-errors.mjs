export class ProgressionCommandError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProgressionCommandError";
    this.code = code;
    this.details = details;
  }
}

export const PROGRESSION_ERROR_CODES = Object.freeze({
  INVALID_COMMAND: "progression_command_invalid",
  NOT_FOUND: "progression_command_not_found",
  LEASE_CONFLICT: "progression_command_lease_conflict",
  HANDLER_MISSING: "progression_command_handler_missing",
  PRECONDITION_FAILED: "progression_command_precondition_failed",
});
