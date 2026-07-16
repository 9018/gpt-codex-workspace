import { ProgressionCommandError, PROGRESSION_ERROR_CODES } from "./progression-errors.mjs";

export function createProgressionCommandActuator({
  commandStore,
  handlers = {},
  owner,
  leaseMs = 60_000,
  getCurrentDecisionRevision,
  assertPreconditions,
  retryDelayMs = 5_000,
  now,
} = {}) {
  if (!commandStore) throw new TypeError("commandStore is required");
  if (!owner) throw new TypeError("owner is required");
  const nowIso = now || (() => new Date().toISOString());

  async function runOnce() {
    await commandStore.releaseExpiredLeases();
    const command = await commandStore.claimNextCommand({ owner, leaseMs });
    if (!command) return { claimed: 0, applied: 0, failed: 0, superseded: 0, command: null };

    try {
      if (typeof getCurrentDecisionRevision === "function") {
        const currentRevision = await getCurrentDecisionRevision(command.task_id, command);
        if (currentRevision !== undefined && currentRevision !== null
          && String(currentRevision) !== String(command.decision_revision)) {
          const superseded = await commandStore.markSuperseded({
            id: command.id,
            owner,
            reason: `decision revision changed from ${command.decision_revision} to ${currentRevision}`,
          });
          return { claimed: 1, applied: 0, failed: 0, superseded: 1, command: superseded };
        }
      }
      if (typeof assertPreconditions === "function") {
        const allowed = await assertPreconditions(command);
        if (allowed === false) {
          throw new ProgressionCommandError(
            PROGRESSION_ERROR_CODES.PRECONDITION_FAILED,
            `Preconditions failed for ${command.id}`,
          );
        }
      }
      const handler = handlers[command.action];
      if (typeof handler !== "function") {
        throw new ProgressionCommandError(
          PROGRESSION_ERROR_CODES.HANDLER_MISSING,
          `No handler registered for progression action ${command.action}`,
        );
      }
      const result = await handler(command);
      const applied = await commandStore.markApplied({ id: command.id, owner, result });
      return { claimed: 1, applied: 1, failed: 0, superseded: 0, command: applied };
    } catch (error) {
      const retryAt = command.attempt < command.max_attempts
        ? new Date(Date.parse(nowIso()) + retryDelayMs).toISOString()
        : null;
      const failed = await commandStore.markFailed({ id: command.id, owner, error, retryAt });
      return { claimed: 1, applied: 0, failed: 1, superseded: 0, command: failed, error };
    }
  }

  async function drain({ maxCommands = 100 } = {}) {
    const total = { claimed: 0, applied: 0, failed: 0, superseded: 0 };
    for (let index = 0; index < Math.max(1, Number(maxCommands) || 100); index += 1) {
      const result = await runOnce();
      for (const key of Object.keys(total)) total[key] += result[key] || 0;
      if (!result.claimed) break;
    }
    return total;
  }

  return { runOnce, drain };
}
