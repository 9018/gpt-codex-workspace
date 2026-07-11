import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state-store.mjs";
import {
  createWorkstreamRecord,
  normalizeLegacyGoalWorkstream,
  normalizeLegacyTaskWorkstream,
} from "../src/workstream/workstream-model.mjs";
import {
  createWorkstream,
  getWorkstream,
  listWorkstreams,
  updateWorkstream,
} from "../src/workstream/workstream-service.mjs";
import {
  linkWorkstreamContext,
  listWorkstreamLinks,
  resolveWorkstreamsByContext,
} from "../src/workstream/workstream-context-links.mjs";

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-workstream-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
  });
  await store.load();
  return store;
}

test("default state initializes independent workstream record families", async (t) => {
  const store = await makeStore(t);

  assert.deepEqual(store.state.workstreams, []);
  assert.deepEqual(store.state.context_links, []);
  assert.deepEqual(store.state.goals, []);
  assert.deepEqual(store.state.conversations, []);
});

test("workstream records use stable defaults and reject duplicate ids", async (t) => {
  const store = await makeStore(t);
  const created = await createWorkstream(store, {
    id: "ws_productization",
    title: "TUI productization",
    project_id: "default",
    workspace_id: "hosted-default",
    root_goal_id: "goal_root",
    workflow_id: "wf_productization",
  });

  assert.deepEqual(created.execution_policy, {
    max_parallel_tasks: 3,
    max_tui_sessions: 3,
    max_subagents_per_task: 4,
    max_subagent_depth: 1,
    max_repair_iterations: 2,
  });
  assert.deepEqual(created.acceptance_policy, {
    require_clean_worktree: true,
    require_commit: true,
    require_tests: true,
    require_documentation_update: true,
  });
  assert.equal(created.status, "planned");

  await assert.rejects(
    () => createWorkstream(store, { id: created.id, title: "duplicate" }),
    /workstream already exists/i,
  );
});

test("workstream CRUD round-trips without changing identity", async (t) => {
  const store = await makeStore(t);
  const created = await createWorkstream(store, {
    title: "Context identity",
    project_id: "default",
    workspace_id: "hosted-default",
    repo_id: "default",
  });

  assert.match(created.id, /^ws_/);
  assert.equal((await getWorkstream(store, created.id)).title, "Context identity");

  const updated = await updateWorkstream(store, created.id, {
    status: "active",
    summary: "Identity layer is active",
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.status, "active");
  assert.equal(updated.summary, "Identity layer is active");

  const listed = await listWorkstreams(store, { status: "active" });
  assert.deepEqual(listed.map((item) => item.id), [created.id]);
  await assert.rejects(
    () => updateWorkstream(store, created.id, { id: "ws_replaced" }),
    /cannot update workstream field: id/i,
  );
});

test("workstream policy updates preserve unspecified custom values", async (t) => {
  const store = await makeStore(t);
  const created = await createWorkstream(store, {
    title: "Policy patch",
    execution_policy: {
      max_parallel_tasks: 6,
      max_tui_sessions: 5,
    },
  });

  const updated = await updateWorkstream(store, created.id, {
    execution_policy: { max_parallel_tasks: 2 },
  });

  assert.equal(updated.execution_policy.max_parallel_tasks, 2);
  assert.equal(updated.execution_policy.max_tui_sessions, 5);
});

test("multiple external contexts link to one workstream and resolve back", async (t) => {
  const store = await makeStore(t);
  const workstream = await createWorkstream(store, { title: "Linked contexts" });

  const chatOne = await linkWorkstreamContext(store, {
    workstream_id: workstream.id,
    kind: "chatgpt_conversation",
    external_id: "chat-conversation-1",
    relation: "originates",
    goal_id: "goal_1",
  });
  await linkWorkstreamContext(store, {
    workstream_id: workstream.id,
    kind: "chatgpt_conversation",
    external_id: "chat-conversation-2",
    relation: "continues",
  });
  await linkWorkstreamContext(store, {
    workstream_id: workstream.id,
    kind: "codex_thread",
    external_id: "thread_abc",
    task_id: "task_1",
  });

  assert.match(chatOne.id, /^link_/);
  assert.equal((await listWorkstreamLinks(store, { workstream_id: workstream.id })).length, 3);
  const resolved = await resolveWorkstreamsByContext(store, "chatgpt_conversation", "chat-conversation-1");
  assert.deepEqual(resolved.workstreams.map((item) => item.id), [workstream.id]);
  assert.deepEqual(resolved.links.map((item) => item.id), [chatOne.id]);
});

test("legacy Goal and Task normalization returns copies and preserves conv identity", () => {
  const goal = {
    id: "goal_legacy",
    conversation_id: "conv_legacy",
    title: "Legacy goal",
  };
  const task = {
    id: "task_legacy",
    goal_id: goal.id,
    conversation_id: goal.conversation_id,
  };

  const goalView = normalizeLegacyGoalWorkstream(goal);
  const taskView = normalizeLegacyTaskWorkstream(task, goal);

  assert.notEqual(goalView, goal);
  assert.notEqual(taskView, task);
  assert.equal(goalView.conversation_id, "conv_legacy");
  assert.equal(taskView.conversation_id, "conv_legacy");
  assert.deepEqual({
    workstream_id: goalView.workstream_id,
    root_goal_id: goalView.root_goal_id,
    parent_goal_id: goalView.parent_goal_id,
    phase: goalView.phase,
    iteration: goalView.iteration,
    shard_key: goalView.shard_key,
    workflow_id: goalView.workflow_id,
  }, {
    workstream_id: null,
    root_goal_id: "goal_legacy",
    parent_goal_id: null,
    phase: null,
    iteration: 0,
    shard_key: null,
    workflow_id: null,
  });
  assert.equal(taskView.root_goal_id, "goal_legacy");
  assert.equal("workstream_id" in goal, false);
  assert.equal("root_goal_id" in task, false);
});

test("record factory rejects invalid identifiers", () => {
  assert.throws(() => createWorkstreamRecord({ id: "workstream_1", title: "Bad" }), /must start with ws_/i);
  assert.throws(() => createWorkstreamRecord({ title: "" }), /title is required/i);
});
