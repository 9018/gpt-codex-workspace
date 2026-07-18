import test from "node:test";
import assert from "node:assert/strict";
import {
  humanGoalDirName,
  humanReadableWorkspaceView,
  humanStatusText,
  humanTaskDirName,
  sanitizeDisplayName,
} from "../src/human-readable-identity.mjs";

test("builds readable goal and task directories with stable short ids", () => {
  const goal = { id: "goal_43dce365-1234", title: "完成总体方案的全自动闭环" };
  const task = { id: "task_6701bbc2-1234", title: "执行第一阶段" };
  assert.equal(humanGoalDirName(goal), "完成总体方案的全自动闭环--g43dce365");
  assert.equal(humanTaskDirName(task, goal), "执行第一阶段--t6701bbc2");
  const view = humanReadableWorkspaceView(goal, task);
  assert.equal(view.goal_dir, ".gptwork/views/goals/完成总体方案的全自动闭环--g43dce365");
  assert.equal(view.task_dir, `${view.goal_dir}/tasks/执行第一阶段--t6701bbc2`);
});

test("sanitizes filesystem-reserved characters without exposing full UUID", () => {
  assert.equal(sanitizeDisplayName("修复项目服务: 502 / API"), "修复项目服务- 502 - API");
});

test("maps task lifecycle to human status text", () => {
  assert.equal(humanStatusText("running"), "Codex 正在运行");
  assert.equal(humanStatusText("queued"), "等待执行");
  assert.equal(humanStatusText("completed"), "已完成");
});
