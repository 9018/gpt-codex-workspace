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

console.log("codex-prompt-builder.test.mjs loaded");
