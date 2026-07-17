/**
 * supervisor-command-executor.mjs — Execute SupervisorCommands with guard and route.
 *
 * Takes a claimed command, validates it through the action guard,
 * routes to the appropriate service, and manages state transitions
 * (applying → applied | retryable_failed | terminal_failed).
 *
 * @module supervisor-review/supervisor-command-executor
 */

/**
 * Create the command executor.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.revisionReader - Revision reader
 * @param {object} deps.actionGuard - Action guard (validateCommand)
 * @param {object} deps.leaseStore - Controller lease store
 * @param {object} deps.planStore - Supervisor plan store
 * @param {object} deps.commandStore - Command store
 * @param {object} [deps.tuiCorrectionService] - TUI correction service
 * @param {object} [deps.quiescenceService] - Quiescence service
 * @param {object} [deps.takeoverService] - Takeover service
 * @param {object} [deps.terminalService] - Terminal evaluation service
 * @param {object} deps.failureClassifier - { classify(error) => { retryable, message } }
 * @returns {object} { execute }
 */
export function createSupervisorCommandExecutor(deps) {
  async function execute(command) {
    const [run, currentRevision, lease, plan] = await Promise.all([
      deps.runStore.readRun(command.run_id),
      deps.revisionReader.current(command.run_id),
      deps.leaseStore.read(command.run_id),
      deps.planStore.readPlan(null).catch(() => ({})),
    ]);

    // 1. Validate through action guard
    const guardResult = deps.actionGuard.validateCommand({
      command, run, currentRevision, lease, plan,
    });
    if (!guardResult.valid) {
      throw new Error(
        `Action guard rejected command ${command.id}: ${guardResult.errors.join("; ")}`
      );
    }

    // 2. Mark as applying
    await deps.commandStore.markApplying(command.id);

    // 3. Route and execute
    try {
      const result = await route(command, run);
      await deps.commandStore.markApplied(command.id, result);
      return result;
    } catch (error) {
      const failure = deps.failureClassifier.classify(error);
      if (failure.retryable) {
        await deps.commandStore.markRetryableFailure(command.id, failure);
      } else {
        await deps.commandStore.markTerminalFailure(command.id, failure);
      }
      throw error;
    }
  }

  async function route(command, run) {
    switch (command.action) {
      case "send_correction":
        if (!deps.tuiCorrectionService) throw new Error("tuiCorrectionService not configured");
        return deps.tuiCorrectionService.apply(command, run);

      case "pause_codex":
        if (!deps.quiescenceService) throw new Error("quiescenceService not configured");
        return deps.quiescenceService.pause(command, run);

      case "chatgpt_takeover":
        if (!deps.takeoverService) throw new Error("takeoverService not configured");
        return deps.takeoverService.apply(command, run);

      case "evaluate_terminal":
        if (!deps.terminalService) throw new Error("terminalService not configured");
        return deps.terminalService.evaluate(command, run);

      case "wait":
        return { no_op: true };

      default:
        throw new Error(`unsupported command action: ${command.action}`);
    }
  }

  return { execute };
}
