import { buildProgressionCommands } from "./progression-command-builder.mjs";
import {
  createProgressionCommandInState,
  supersedeStaleProgressionCommandsInState,
} from "./progression-command-store.mjs";

export function reconcileProgressionCommandsInState({ state, decisions = [], now, idFactory } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("state is required");
  const report = { created: 0, replayed: 0, commands: [] };
  for (const decision of decisions) {
    supersedeStaleProgressionCommandsInState(state, {
      taskId: decision.task_id,
      decisionRevision: decision.revision ?? decision.decision_revision,
      now,
    });
    for (const input of buildProgressionCommands(decision)) {
      const result = createProgressionCommandInState(state, input, { now, idFactory });
      report[result.created ? "created" : "replayed"] += 1;
      report.commands.push(result.command);
    }
  }
  return report;
}

export async function reconcileProgressionCommands({ commandStore, decisions = [] } = {}) {
  if (!commandStore) throw new TypeError("commandStore is required");
  const report = { created: 0, replayed: 0, commands: [] };
  for (const decision of decisions) {
    await commandStore.supersedeStaleCommands({
      taskId: decision.task_id,
      decisionRevision: decision.revision ?? decision.decision_revision,
    });
    for (const input of buildProgressionCommands(decision)) {
      const result = await commandStore.createCommand(input);
      report[result.created ? "created" : "replayed"] += 1;
      report.commands.push(result.command);
    }
  }
  return report;
}
