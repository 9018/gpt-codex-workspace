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
 * @param {object} [deps.nativeResumeService] - Native session resume service
 * @param {object} [deps.handoffService] - Handoff-to-codex service
 * @param {object} deps.failureClassifier - { classify(error) => { retryable, message } }
 * @returns {object} { execute }
 */
export function createSupervisorCommandExecutor(deps) {
  async function execute(command) {
    const [run, currentRevision, lease] = await Promise.all([
      deps.runStore.readRun(command.run_id),
      deps.revisionReader.current(command.run_id),
      deps.leaseStore.read(command.run_id),
    ]);

    // Read plan with proper plan ID from run
    let plan = {};
    try {
      if (run.supervisor_plan_id) {
        plan = await deps.planStore.readPlan(run.supervisor_plan_id);
      }
    } catch {
      // plan read failure is non-fatal; proceed with empty plan
    }

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

      case "resume_and_send_correction":
        if (!deps.tuiCorrectionService) throw new Error("tuiCorrectionService not configured");
        // Resume native session then send correction
        if (!deps.nativeResumeService) throw new Error("nativeResumeService not configured");
        const resumeBinding = await deps.nativeResumeService.resume({
          run,
          nativeSessionId: command.preconditions?.expected_native_session_id,
          worktreePath: command.preconditions?.expected_worktree_path,
        });
        return deps.tuiCorrectionService.apply(
          {
            ...command,
            preconditions: {
              ...command.preconditions,
              expected_session_id: resumeBinding.control_session_id,
            },
          },
          {
            ...run,
            active_session_id: resumeBinding.control_session_id,
          }
        );

      case "handoff_to_codex":
        if (!deps.handoffService) throw new Error("handoffService not configured");
        return deps.handoffService.handoff({
          runId: command.run_id,
          receipt: command.payload,
        });

      case "start_repair_cycle":
        if (!deps.goalRelayService) {
          throw new Error("goalRelayService not configured");
        }
        return deps.goalRelayService.startRepairCycle({
          run,
          revisionId: command.review_revision_id || command.id,
          failure_summary: command.payload?.remaining_work_summary || "Remaining work",
          evidence: command.payload?.evidence || {},
        });

      case "wait":
        return { no_op: true };

      default:
        throw new Error(`unsupported command action: ${command.action}`);
    }
  }

  return { execute };
}
