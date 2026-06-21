import test from "node:test";
import assert from "node:assert/strict";

import { taskExecutionSnapshot } from "../src/goal-task-lifecycle.mjs";

test("taskExecutionSnapshot awaits indexed goal lookup and includes conversation tail", async () => {
  const task = {
    id: "task_snapshot",
    goal_id: "goal_snapshot",
    status: "completed",
    result: { kind: "structured", summary: "done" },
  };
  const goal = {
    id: "goal_snapshot",
    status: "completed",
    conversation_id: "conversation_snapshot",
  };
  const conversation = {
    id: "conversation_snapshot",
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
      { role: "user", content: "five" },
      { role: "assistant", content: "six" },
    ],
  };
  const store = {
    async load() {
      return { tasks: [task], goals: [goal], conversations: [conversation], memories: [], activities: [] };
    },
    async findTaskById(id) {
      return id === task.id ? task : null;
    },
    async findGoalById(id) {
      return id === goal.id ? goal : null;
    },
    findConversationById(id) {
      return id === conversation.id ? conversation : null;
    },
  };

  const snapshot = await taskExecutionSnapshot(store, { id: task.id });

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.goal_status, "completed");
  assert.deepEqual(snapshot.result, task.result);
  assert.equal(snapshot.messages_tail.length, 5);
  assert.deepEqual(snapshot.messages_tail.map((message) => message.content), ["two", "three", "four", "five", "six"]);
});
