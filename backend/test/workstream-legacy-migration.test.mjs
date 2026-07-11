import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state-store.mjs";
import { listGoals } from "../src/goal-task-goals.mjs";
import { getGoalContext } from "../src/goal-task-context.mjs";
import { buildGoalTask } from "../src/goal-task-task-factory.mjs";
import { createBasicTaskToolsGroup } from "../src/tool-groups/basic-task-tools-group.mjs";
import { defaultTokenContext } from "../src/auth-context.mjs";

function fakeTool(descriptor) {
  return descriptor;
}

function fakeSchema(properties = {}, required = []) {
  return { type: "object", properties, required };
}

function legacyState(now) {
  return {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default" }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted", root: "/tmp" }],
    goals: [{
      id: "goal_legacy",
      project_id: "default",
      workspace_id: "hosted-default",
      conversation_id: "conv_legacy",
      task_id: "task_legacy",
      title: "Legacy goal",
      status: "assigned",
      assignee: "codex",
      mode: "builder",
      created_at: now,
      updated_at: now,
    }],
    conversations: [{
      id: "conv_legacy",
      goal_id: "goal_legacy",
      project_id: "default",
      workspace_id: "hosted-default",
      messages: [],
      created_at: now,
      updated_at: now,
    }],
    memories: [],
    tasks: [{
      id: "task_legacy",
      goal_id: "goal_legacy",
      project_id: "default",
      workspace_id: "hosted-default",
      conversation_id: "conv_legacy",
      title: "Legacy task",
      status: "assigned",
      assignee: "codex",
      mode: "builder",
      logs: [],
      artifacts: [],
      created_at: now,
      updated_at: now,
    }],
    chatgpt_requests: [],
    activities: [],
    audit: [],
  };
}

test("read-only legacy Goal and Task queries derive compatibility fields without writing state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-workstream-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const original = JSON.stringify(legacyState("2026-07-11T00:00:00.000Z"), null, 2);
  await writeFile(statePath, original, "utf8");

  const store = new StateStore({ statePath, defaultWorkspaceRoot: join(root, "workspace") });
  const result = await listGoals(store, {}, defaultTokenContext("test"));
  const context = await getGoalContext(
    store,
    { defaultWorkspaceRoot: join(root, "workspace") },
    { goal_id: "goal_legacy" },
    defaultTokenContext("test"),
  );
  const taskTools = createBasicTaskToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    config: {},
    store,
    createTask: async () => {},
    github: { syncTask: async () => {} },
  });
  const listedTasks = await taskTools.list_tasks.handler({});
  const fetchedTask = await taskTools.get_task.handler({ task_id: "task_legacy" });

  assert.equal(result.goals[0].workstream_id, null);
  assert.equal(result.goals[0].root_goal_id, "goal_legacy");
  assert.equal(result.goals[0].iteration, 0);
  assert.equal(result.goals[0].conversation_id, "conv_legacy");
  assert.equal(context.goal.root_goal_id, "goal_legacy");
  assert.equal(context.goal.conversation_id, "conv_legacy");
  assert.equal(context.task.root_goal_id, "goal_legacy");
  assert.equal(context.task.conversation_id, "conv_legacy");
  assert.equal(listedTasks.tasks[0].root_goal_id, "goal_legacy");
  assert.equal(fetchedTask.task.root_goal_id, "goal_legacy");
  assert.equal("workstream_id" in store.state.goals[0], false);
  assert.equal("workstream_id" in store.state.tasks[0], false);
  assert.equal("workstreams" in store.state, false);
  assert.equal(await readFile(statePath, "utf8"), original);
});

test("new Goal Task copies optional workstream identity while preserving internal conversation", () => {
  const now = "2026-07-11T00:00:00.000Z";
  const goal = {
    id: "goal_child",
    project_id: "default",
    workspace_id: "hosted-default",
    conversation_id: "conv_internal",
    title: "Child shard",
    user_request: "Implement child shard",
    goal_prompt: "Implement child shard",
    mode: "builder",
    created_at: now,
    workstream_id: "ws_root",
    root_goal_id: "goal_root",
    parent_goal_id: "goal_parent",
    phase: "implementation",
    iteration: 2,
    shard_key: "backend",
    workflow_id: "wf_root",
  };

  const task = buildGoalTask(goal, { id: "conv_internal" }, "system");

  assert.equal(task.conversation_id, "conv_internal");
  assert.equal(task.workstream_id, "ws_root");
  assert.equal(task.root_goal_id, "goal_root");
  assert.equal(task.parent_goal_id, "goal_parent");
  assert.equal(task.phase, "implementation");
  assert.equal(task.iteration, 2);
  assert.equal(task.shard_key, "backend");
  assert.equal(task.workflow_id, "wf_root");
});
