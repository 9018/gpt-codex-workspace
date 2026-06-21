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

test("taskExecutionSnapshot includes log metadata (log_bytes, last_log_age_ms)", async () => {
  const now = new Date().toISOString();
  const task = {
    id: "task_log_meta",
    goal_id: "goal_log_meta",
    status: "running",
    logs: [
      { time: new Date(Date.now() - 60000).toISOString(), message: "started" },
      { time: new Date(Date.now() - 30000).toISOString(), message: "processing step 1" },
      { time: now, message: "step 2 complete" },
    ],
    result: null,
  };
  const goal = {
    id: "goal_log_meta",
    status: "assigned",
    conversation_id: "conv_log_meta",
  };
  const conversation = {
    id: "conv_log_meta",
    messages: [
      { role: "user", content: "do work" },
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

  assert.equal(snapshot.status, "running");
  assert.ok(typeof snapshot.log_bytes === "number", "log_bytes must be a number");
  assert.ok(snapshot.log_bytes > 0, "log_bytes must be positive for logs with content");
  assert.ok(typeof snapshot.last_log_age_ms === "number", "last_log_age_ms must be a number");
  assert.ok(snapshot.last_log_age_ms >= 0, "last_log_age_ms must be >= 0");
  assert.ok(snapshot.last_log_age_ms < 5000, "last_log_age_ms must be small for a just-added log");
});

test("taskExecutionSnapshot returns null last_log_age_ms and 0 log_bytes when task has no logs", async () => {
  const task = {
    id: "task_no_logs",
    goal_id: "goal_no_logs",
    status: "assigned",
    logs: [],
    result: null,
  };
  const goal = {
    id: "goal_no_logs",
    status: "assigned",
    conversation_id: "conv_no_logs",
  };
  const conversation = {
    id: "conv_no_logs",
    messages: [],
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
  assert.equal(snapshot.log_bytes, 0);
  assert.equal(snapshot.last_log_age_ms, null);
});
