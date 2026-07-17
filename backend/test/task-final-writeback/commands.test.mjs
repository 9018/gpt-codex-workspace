import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalizationCommands } from "../../src/task-finalization/queue-effect-builder.mjs";

test("buildFinalizationCommands returns progression commands without mutating decision", () => {
  const decision = {
    task_id: "task_1",
    goal_id: "goal_1",
    revision: 7,
    status: "completed",
    safe_to_auto_advance: true,
    queue_effect: { unblock_dependents: true, hold_queue: false },
    goal_effect: { complete_goal: true },
    integration_effect: { required: false, terminal: true, satisfied: true },
  };
  const before = JSON.stringify(decision);

  const commands = buildFinalizationCommands(decision);

  assert.deepEqual(commands.map((command) => command.action), ["complete_task", "propagate_goal", "advance_queue"]);
  assert.deepEqual(commands.map((command) => command.decision_revision), [7, 7, 7]);
  assert.equal(JSON.stringify(decision), before);
});
