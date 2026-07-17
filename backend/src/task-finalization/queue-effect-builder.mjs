import { buildProgressionCommands } from "../progression/progression-command-builder.mjs";

export function buildFinalizationCommands(decision = {}) {
  return buildProgressionCommands(decision);
}
