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



// ===========================================================================
// P0: Context entry-first ordering — codex.entry.md before goal.md/transcript.md
// ===========================================================================

test('buildCodexPrompt references codex.entry.md first before goal.md/transcript.md', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_entry_first', title: 'Entry first', description: '' },
    goal: { id: 'goal_entry_first' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_entry_first/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_entry_first/context.bundle.md',
      context_json: '.gptwork/goals/goal_entry_first/context.json',
      goal_md: '.gptwork/goals/goal_entry_first/goal.md',
      transcript_md: '.gptwork/goals/goal_entry_first/transcript.md',
      result_md: '.gptwork/goals/goal_entry_first/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  // codex.entry.md must appear FIRST in the goal context section
  const entryIdx = fullPrompt.indexOf('codex.entry.md');
  const goalIdx = fullPrompt.indexOf('goal.md');
  const contextIdx = fullPrompt.indexOf('context.json');
  const transcriptIdx = fullPrompt.indexOf('transcript.md');
  const bundleIdx = fullPrompt.indexOf('context.bundle.md');

  assert.ok(entryIdx >= 0, 'codex.entry.md must be referenced');
  assert.ok(entryIdx < goalIdx || goalIdx < 0, 'codex.entry.md must appear before goal.md');
  assert.ok(entryIdx < contextIdx || contextIdx < 0, 'codex.entry.md must appear before context.json');
  assert.ok(entryIdx < transcriptIdx || transcriptIdx < 0, 'codex.entry.md must appear before transcript.md');
  assert.ok(bundleIdx > entryIdx, 'context.bundle.md should come after codex.entry.md');
});

test('buildCodexPrompt: context.bundle.md is preferred over transcript.md', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_bundle_first', title: 'Bundle first', description: '' },
    goal: { id: 'goal_bundle' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_bundle/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_bundle/context.bundle.md',
      context_manifest_json: '.gptwork/goals/goal_bundle/context.manifest.json',
      context_json: '.gptwork/goals/goal_bundle/context.json',
      goal_md: '.gptwork/goals/goal_bundle/goal.md',
      transcript_md: '.gptwork/goals/goal_bundle/transcript.md',
      result_md: '.gptwork/goals/goal_bundle/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  // The prompt must instruct Codex to prefer context.bundle.md over goal.md/transcript.md
  assert.ok(fullPrompt.includes('Prefer'), 'Should have "Prefer" directive');
  assert.ok(fullPrompt.includes('context.bundle.md'), 'context.bundle.md must be referenced');
  assert.ok(fullPrompt.includes('supporting context when present'), 'Should say "supporting context when present"');
  assert.ok(fullPrompt.includes('Use codex.entry.md plus context.bundle.md as the default execution context'),
    'Should explicitly define codex.entry.md + context.bundle.md as the default execution context');
  assert.ok(fullPrompt.includes('context.manifest.json'), 'Should reference context manifest diagnostics');
  assert.ok(fullPrompt.includes('Do not read context.json, goal.md, or transcript.md wholesale by default'),
    'Should explicitly forbid default wholesale reads of deep lookup files');
});

test('buildCodexPrompt: transcript.md is only for explicit deep lookup', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_transcript_lookup', title: 'Transcript lookup', description: '' },
    goal: { id: 'goal_transcript' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_transcript/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_transcript/context.bundle.md',
      context_json: '.gptwork/goals/goal_transcript/context.json',
      goal_md: '.gptwork/goals/goal_transcript/goal.md',
      transcript_md: '.gptwork/goals/goal_transcript/transcript.md',
      result_md: '.gptwork/goals/goal_transcript/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  // transcript.md should only be for explicit lookup, not force-read
  assert.ok(fullPrompt.includes('only for explicit conversation lookup'), 'transcript.md must be for explicit lookup only');
  assert.ok(fullPrompt.includes('when required'), 'transcript.md should only be read when required');
});

test('buildCodexPrompt: do not force long transcript reads unless bundle is insufficient', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_no_force_transcript', title: 'No force transcript', description: '' },
    goal: { id: 'goal_nt' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_nt/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_nt/context.bundle.md',
      context_json: '.gptwork/goals/goal_nt/context.json',
      goal_md: '.gptwork/goals/goal_nt/goal.md',
      transcript_md: '.gptwork/goals/goal_nt/transcript.md',
      result_md: '.gptwork/goals/goal_nt/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  // The prompt should never say "read the entire transcript" or force long reads
  assert.equal(fullPrompt.includes('read the entire transcript'), false, 'Must not force reading the entire transcript');
  assert.equal(fullPrompt.includes('force-read'), false, 'Must not use force-read language');
  // The context.bundle.md should be described as the preferred bounded context
  assert.ok(fullPrompt.includes('bounded entrypoint'), 'Should reference bounded entrypoint');
});

test('buildCodexPrompt: preserves zvec/ZEVc quota and diagnostics behavior', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_zvec', title: 'Zvec test', description: '' },
    goal: null,
    workspaceFiles: null,
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  // The prompt must not force redesign of zvec/ZEVc
  assert.equal(fullPrompt.includes('reimplement zvec'), false, 'Must not contain reimplement zvec');
  assert.equal(fullPrompt.includes('Do not reimplement'), false, 'Must not reference internal tool constraints in prompt');
});

// ===========================================================================
// P0: Context degradation signals — bundle/retrieval missing
// ===========================================================================

test('buildCodexPrompt with degradationNotes about missing bundle warns clearly', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_degraded', title: 'Degraded bundle', description: '' },
    goal: { id: 'goal_degraded' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_degraded/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_degraded/context.bundle.md',
      context_json: '.gptwork/goals/goal_degraded/context.json',
      goal_md: '.gptwork/goals/goal_degraded/goal.md',
      transcript_md: '.gptwork/goals/goal_degraded/transcript.md',
      result_md: '.gptwork/goals/goal_degraded/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
    degradationNotes: [
      '**WARNING: context.bundle.md is missing**. Codex will rely on codex.entry.md and explicit deep-lookup files only.',
      'Reason: Context index unavailable — check context_status diagnostics.',
    ],
  });

  assert.ok(fullPrompt.includes('WARNING: context.bundle.md is missing'), 'Should warn about missing bundle');
  assert.ok(fullPrompt.includes('Context index unavailable'), 'Should mention the degradation reason');
  // The prompt should still be entry-first
  assert.ok(fullPrompt.includes('Start by reading only this bounded entrypoint'), 'Entry-first directive must be present even with degradation');
  assert.ok(fullPrompt.includes('codex.entry.md'), 'codex.entry.md must still be referenced');
});

test('buildCodexPrompt with degradationNotes about retrieval failure instructs fallback', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_retrieval_fail', title: 'Retrieval failure', description: '' },
    goal: { id: 'goal_retrieval' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_retrieval/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_retrieval/context.bundle.md',
      context_json: '.gptwork/goals/goal_retrieval/context.json',
      goal_md: '.gptwork/goals/goal_retrieval/goal.md',
      transcript_md: '.gptwork/goals/goal_retrieval/transcript.md',
      result_md: '.gptwork/goals/goal_retrieval/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
    degradationNotes: [
      '**WARNING: Context retrieval is unavailable**. Falling back to durable sources (goal.md, result.json, task fields).',
      'context.retrieval.json exists but contains no retrieved chunks — it is diagnostic only.',
    ],
  });

  assert.ok(fullPrompt.includes('Context retrieval is unavailable'), 'Should warn about retrieval failure');
  assert.ok(fullPrompt.includes('diagnostic only'), 'Should describe retrieval as diagnostic only');
  assert.ok(fullPrompt.includes('bounded entrypoint'), 'Entry-first model preserved');
});

test('buildCodexPrompt without degradationNotes avoids degradation language', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_no_deg', title: 'Clean prompt', description: '' },
    goal: { id: 'goal_no_deg' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_no_deg/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_no_deg/context.bundle.md',
      context_json: '.gptwork/goals/goal_no_deg/context.json',
      goal_md: '.gptwork/goals/goal_no_deg/goal.md',
      transcript_md: '.gptwork/goals/goal_no_deg/transcript.md',
      result_md: '.gptwork/goals/goal_no_deg/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
  });

  assert.equal(fullPrompt.includes('WARNING'), false, 'Should not contain WARNING');
  assert.equal(fullPrompt.includes('degradation'), false, 'Should not contain degradation language');
});

test('buildCodexPrompt degradationNotes with large transcript warns Codex about size', () => {
  const { fullPrompt } = buildCodexPrompt({
    task: { id: 'task_large_transcript', title: 'Large transcript', description: '' },
    goal: { id: 'goal_large' },
    workspaceFiles: {
      codex_entry_md: '.gptwork/goals/goal_large/codex.entry.md',
      context_bundle_md: '.gptwork/goals/goal_large/context.bundle.md',
      context_json: '.gptwork/goals/goal_large/context.json',
      goal_md: '.gptwork/goals/goal_large/goal.md',
      transcript_md: '.gptwork/goals/goal_large/transcript.md',
      result_md: '.gptwork/goals/goal_large/result.md',
    },
    workspaceRoot: '/tmp/ws',
    defaultRepoPath: null,
    degradationNotes: [
      '**WARNING: Transcript is 125.0 KB (12 messages).** Large transcripts may degrade Codex reasoning quality.',
      'Do not read transcript.md by default. Rely on context.bundle.md and codex.entry.md.',
    ],
  });

  assert.ok(fullPrompt.includes('Transcript is 125.0 KB'), 'Should warn about transcript size');
  assert.ok(fullPrompt.includes('Do not read transcript.md'), 'Should explicitly tell Codex not to read large transcript by default');
});

console.log("codex-prompt-builder.test.mjs loaded");
