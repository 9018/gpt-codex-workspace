/**
 * correction-ack-reconciler.mjs — Watches for correction acknowledgment.
 *
 * After a correction is sent, the reconciler checks whether the TUI
 * session has acknowledged it (explicitly via delta ack) or implicitly
 * (via progress / diff change). On timeout without ack, it throws.
 *
 * @module supervisor-review/correction-ack-reconciler
 */

/**
 * Error thrown when a correction is not acknowledged within the timeout.
 */
export class CorrectionNotAcknowledgedError extends Error {
  constructor(commandId) {
    super(`Correction not acknowledged: ${commandId}`);
    this.name = "CorrectionNotAcknowledgedError";
    this.commandId = commandId;
  }
}

const DEFAULT_ACK_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Create the correction ack reconciler.
 *
 * @param {object} deps
 * @param {object} deps.observationService - { observe(run) => observation }
 * @param {number} [deps.ackTimeoutMs=120000] - Max wait before timeout
 * @param {Function} [deps.now] - Timestamp getter
 * @returns {object} { reconcile }
 */
export function createCorrectionAckReconciler(deps = {}) {
  const {
    observationService = null,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    now = () => new Date().toISOString(),
  } = deps;

  /**
   * Reconcile whether a correction has been acknowledged.
   *
   * @param {object} command - The sent SupervisorCommand
   * @param {object} run - Current ExecutionRun with supervision
   * @returns {Promise<{ status: string, details?: object }>}
   * @throws {CorrectionNotAcknowledgedError} On timeout
   */
  async function reconcile(command, run) {
    const supervision = run.supervision || {};

    // Already acknowledged
    if (supervision.correction_acknowledged_at) {
      return { status: "already_acknowledged" };
    }

    if (!observationService) {
      return { status: "waiting", details: { note: "no observation service" } };
    }

    const observation = await observationService.observe(run);

    // Explicit ack via delta response
    if (observation.ack_command_id === command.id) {
      return { status: "acknowledged", details: { mode: "explicit", observation } };
    }

    // Implicit ack via progress or diff change
    const hasProgressChange = observation.progress_revision > (supervision.last_progress_revision || 0);
    const hasDiffChange = observation.diff_digest && observation.diff_digest !== command.preconditions?.diff_digest;

    if (hasProgressChange || hasDiffChange) {
      return { status: "implicitly_acknowledged", details: { mode: "implicit", observation } };
    }

    // Timeout check
    if (supervision.correction_sent_at) {
      const sentTime = new Date(supervision.correction_sent_at).getTime();
      const currentTime = new Date(now()).getTime();
      if (currentTime - sentTime > ackTimeoutMs) {
        throw new CorrectionNotAcknowledgedError(command.id);
      }
    }

    return { status: "waiting" };
  }

  return { reconcile };
}
