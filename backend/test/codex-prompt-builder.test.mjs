/**
 * Tests for codex-prompt-builder.mjs
 *
 * Verifies that buildCodexPrompt produces correct prompts and that
 * preview_codex_context exposes actual_prompt_bytes.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexPrompt } from "../src/codex-prompt-builder.mjs";
import "../src/gptwork-server.mjs";

// ---------------------------------------------------------------------------
// Unit tests: buildCodexPrompt
// ---------------------------------------------------------------------------

test("buildCodexPrompt returns promptBytes > 0 with goal", () => {
  const { fullPrompt, promptBytes } = buildCodexPrompt({
    task: { id: "task_g1", title: "Goal task", description: "A task with a goal" },
    goal: { id: "goal_1" },
    workspaceFiles: {
      goal_md: ".gptwork/goals/goal_1/goal.md",
      context_json: ".gptwork/goals/goal_1/context.json",
      transcript_md: ".gptwork/goals/goal_1/transcript.md",
      result_md: ".gptwork/goals/goal_1/result.md",
    },
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: "/tmp/repo",
  });

  assert.ok(promptBytes > 0, "promptBytes should be > 0");
  assert.ok(fullPrompt.length > 0, "fullPrompt should not be empty");
  assert.ok(fullPrompt.includes("Goal task"), "prompt should contain task title");
  assert.ok(fullPrompt.includes("A task with a goal"), "prompt should contain task description");
});

test("buildCodexPrompt contains GPTWork Goal Context section when goal is present", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_goal", title: "Goal test", description: "" },
    goal: { id: "goal_demo" },
    workspaceFiles: {
      goal_md: ".gptwork/goals/goal_demo/goal.md",
      context_json: ".gptwork/goals/goal_demo/context.json",
      transcript_md: ".gptwork/goals/goal_demo/transcript.md",
      result_md: ".gptwork/goals/goal_demo/result.md",
    },
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(fullPrompt.includes("GPTWork Goal Context"), "should contain goal context heading");
  assert.ok(fullPrompt.includes(".gptwork/goals/goal_demo/goal.md"), "should reference goal.md");
  assert.ok(fullPrompt.includes(".gptwork/goals/goal_demo/context.json"), "should reference context.json");
  assert.ok(fullPrompt.includes(".gptwork/goals/goal_demo/transcript.md"), "should reference transcript.md");
  assert.ok(fullPrompt.includes(".gptwork/goals/goal_demo/result.md"), "should reference result.md");
  assert.ok(fullPrompt.includes("result.json"), "should mention result.json output format");
  assert.ok(fullPrompt.includes("Stdout structured report"), "should mention stdout report format");
});

test("buildCodexPrompt does NOT include goal context when goal is null", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_nog", title: "No goal", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.equal(fullPrompt.includes("GPTWork Goal Context"), false, "should NOT contain goal context heading");
});

test("buildCodexPrompt contains Safe Restart Rule section", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_sr", title: "Safe restart test", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(fullPrompt.includes("Safe Restart Rule"), "should contain Safe Restart Rule heading");
  assert.ok(fullPrompt.includes("MUST NOT run"), "should contain MUST NOT run");
  assert.ok(fullPrompt.includes("MUST NOT run"), "should forbid direct restart");
  assert.ok(fullPrompt.includes("schedule_service_restart"), "should recommend schedule_service_restart");
  assert.ok(fullPrompt.includes("schedule_service_restart"), "should mention schedule_service_restart tool");
});

test("buildCodexPrompt contains execution instruction section", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_exec", title: "Exec test", description: "desc" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/my-workspace",
    defaultRepoPath: "/tmp/canonical-repo",
  });

  assert.ok(fullPrompt.includes("/tmp/my-workspace"), "should reference workspace root");
  assert.ok(fullPrompt.includes("/tmp/canonical-repo"), "should reference canonical repo path");
  assert.ok(fullPrompt.includes("Execute the EXACT steps above"), "should contain exec instructions");
  assert.ok(fullPrompt.includes("Write result.json to"), "should mention result.json output");
});

test("buildCodexPrompt uses correct result.json path with goal", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_r1", title: "Result path test", description: "" },
    goal: { id: "goal_result" },
    workspaceFiles: {
      goal_md: ".gptwork/goals/goal_result/goal.md",
      context_json: ".gptwork/goals/goal_result/context.json",
      transcript_md: ".gptwork/goals/goal_result/transcript.md",
      result_md: ".gptwork/goals/goal_result/result.md",
    },
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(fullPrompt.includes("/tmp/ws/.gptwork/goals/goal_result/result.json"), "should use goal-based result path");
});

test("buildCodexPrompt uses task-based result.json path when goal is null", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_no_goal_result", title: "No goal result", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(fullPrompt.includes("/tmp/ws/.gptwork/goals/task_no_goal_result/result.json"), "should use task-based result path");
});

test("buildCodexPrompt returns consistent promptBytes", () => {
  const result1 = buildCodexPrompt({
    task: { id: "task_cons", title: "Consistent bytes", description: "test desc" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  const result2 = buildCodexPrompt({
    task: { id: "task_cons", title: "Consistent bytes", description: "test desc" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.equal(result1.promptBytes, result2.promptBytes, "promptBytes should be consistent between calls");
  assert.equal(result1.fullPrompt, result2.fullPrompt, "fullPrompt should be identical between calls");
});

test("buildCodexPrompt with empty description works", () => {
  const { fullPrompt, promptBytes } = buildCodexPrompt({
    task: { id: "task_empty_desc", title: "Empty desc", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(promptBytes > 0, "promptBytes should be > 0");
  assert.ok(fullPrompt.includes("Empty desc"), "should contain task title");
});

test("buildCodexPrompt with '(not configured)' when defaultRepoPath is null", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "task_no_repo", title: "No repo", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: null,
  });

  assert.ok(fullPrompt.includes("(not configured)"), "should show (not configured) for missing repo");
});

// ---------------------------------------------------------------------------
// Integration: buildCodexPrompt and actual prompt bytes
// ---------------------------------------------------------------------------

test("promptBytes matches Buffer.byteLength of fullPrompt", () => {
  const { fullPrompt, promptBytes } = buildCodexPrompt({
    task: { id: "task_byte_check", title: "Byte check", description: "desc" },
    goal: { id: "goal_byte" },
    workspaceFiles: {
      goal_md: ".gptwork/goals/goal_byte/goal.md",
      context_json: ".gptwork/goals/goal_byte/context.json",
      transcript_md: ".gptwork/goals/goal_byte/transcript.md",
      result_md: ".gptwork/goals/goal_byte/result.md",
    },
    workspaceRoot: "/tmp/ws",
    defaultRepoPath: "/tmp/repo",
  });

  assert.equal(promptBytes, Buffer.byteLength(fullPrompt, "utf8"), "promptBytes should match Buffer.byteLength");
});

// ---------------------------------------------------------------------------
// Verification: processGeneralTask still works through the builder module
// (Source-level verification that the prompt construction was extracted)
// ---------------------------------------------------------------------------

test("processGeneralTask no longer contains inline prompt template", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const serverSource = await readFile(join(process.cwd(), "src/gptwork-server.mjs"), "utf8");
  const processorSource = await readFile(join(process.cwd(), "src/task-general-processor.mjs"), "utf8");

  // The inline separator definition should not exist in processGeneralTask anymore
  // The separator should only be in codex-prompt-builder.mjs
  assert.equal(serverSource.includes('const separator = "=".repeat(60)'), false,
    "separator definition should not remain inline in gptwork-server.mjs");
  assert.equal(processorSource.includes('const separator = "=".repeat(60)'), false,
    "separator definition should not move into task-general-processor.mjs");

  // processGeneralTask should now delegate prompt/run setup to the setup helper.
  assert.ok(processorSource.includes("prepareCodexTaskRunFn({"),
    "processGeneralTask should use the run setup helper");
});

test("codex-prompt-builder.mjs exports buildCodexPrompt", async () => {
  const mod = await import("../src/codex-prompt-builder.mjs");
  assert.equal(typeof mod.buildCodexPrompt, "function", "buildCodexPrompt should be exported");
});

// ---------------------------------------------------------------------------
// P0 Result Path Contract tests
// ---------------------------------------------------------------------------

test("buildCodexPrompt uses passed executionRepoPath in Execution Path Contract", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path1", title: "Path1", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
    executionRepoPath: "/my/custom/exec/path",
  });
  assert.ok(fullPrompt.includes("/my/custom/exec/path"), "should use passed executionRepoPath");
  assert.ok(fullPrompt.includes("Edit code only under"), "should have Edit code only under");
});

test("buildCodexPrompt uses passed resultJsonPath instead of workspaceRoot derivation", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path2", title: "Path2", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
    resultJsonPath: "/custom/result.json",
  });
  assert.ok(fullPrompt.includes("/custom/result.json"), "should use passed resultJsonPath");
  assert.equal(fullPrompt.includes("/ws/.gptwork/goals/t_path2/result.json"), false, "should NOT use workspaceRoot derivation");
});

test("buildCodexPrompt uses passed resultMdPath in Execution Path Contract", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path3", title: "Path3", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
    resultMdPath: "/custom/result.md",
  });
  assert.ok(fullPrompt.includes("/custom/result.md"), "should use passed resultMdPath");
  assert.ok(fullPrompt.includes("Write result.md to"), "should have Write result.md to");
});

test("buildCodexPrompt uses passed goalStateDir", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path4", title: "Path4", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
    goalStateDir: "/my/goal/state",
  });
  assert.ok(fullPrompt.includes("/my/goal/state"), "should use passed goalStateDir");
  assert.ok(fullPrompt.includes("Read goal/state files from"), "should have Read goal/state files from");
});

test("buildCodexPrompt does not contain conflicting workspaceRoot base directory instruction", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path5", title: "Path5", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
  });
  assert.equal(fullPrompt.includes("Use /ws as the base directory"), false, "should NOT contain Use workspaceRoot");
});

test("buildCodexPrompt includes task worktree path when passed", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path6", title: "Path6", description: "" },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: "/ws",
    defaultRepoPath: null,
    taskWorktreePath: "/my/worktree",
  });
  assert.ok(fullPrompt.includes("/my/worktree"), "should include task worktree path");
  assert.ok(fullPrompt.includes("Task worktree path"), "should have Task worktree path label");
});

test("buildCodexPrompt: no conflicting instructions with all new params passed", () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: "t_path7", title: "Path7", description: "desc" },
    goal: { id: "g_path7" },
    workspaceFiles: {
      goal_md: ".gptwork/goals/g_path7/goal.md",
      context_json: ".gptwork/goals/g_path7/context.json",
      transcript_md: ".gptwork/goals/g_path7/transcript.md",
      result_md: ".gptwork/goals/g_path7/result.md",
    },
    workspaceRoot: "/ws",
    defaultRepoPath: "/repo",
    executionRepoPath: "/exec",
    goalStateDir: "/state",
    resultJsonPath: "/rj.json",
    resultMdPath: "/rm.md",
    canonicalRepoPath: "/canonical",
    taskWorktreePath: "/worktree",
  });
  assert.ok(fullPrompt.includes("/exec"), "executionRepoPath");
  assert.ok(fullPrompt.includes("/state"), "goalStateDir");
  assert.ok(fullPrompt.includes("/rj.json"), "resultJsonPath");
  assert.ok(fullPrompt.includes("/rm.md"), "resultMdPath");
  assert.ok(fullPrompt.includes("/canonical"), "canonicalRepoPath");
  assert.ok(fullPrompt.includes("/worktree"), "taskWorktreePath");
  assert.equal(fullPrompt.includes("Use /ws as the base directory"), false, "no workspaceRoot base dir");
  assert.equal(fullPrompt.includes("/ws/.gptwork/goals/g_path7/result.json"), false, "no workspaceRoot derived result.json");
  assert.ok(fullPrompt.includes("Execution Path Contract"), "has contract section");
  assert.ok(fullPrompt.includes("All code changes must be made within"), "has execution instruction");
});

console.log("codex-prompt-builder.test.mjs loaded");
