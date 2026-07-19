import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  goalWorkspaceFiles,
  publicGoalWorkspaceFiles,
  internalGoalWorkspaceFiles,
  hasGoalBundles,
  renderGoalMarkdown,
  renderCodexEntryMarkdown,
  renderTranscriptMarkdown,
  codexInstruction,
  safeBundleName
} from "../src/goal-files.mjs";

test("goalWorkspaceFiles returns correct paths for a goal", () => {
  const goal = { id: "goal_test_123" };
  const files = goalWorkspaceFiles(goal);
  assert.equal(files.dir, ".gptwork/goals/goal_test_123");
  assert.equal(files.goal_md, ".gptwork/goals/goal_test_123/goal.md");
  assert.equal(files.context_json, ".gptwork/goals/goal_test_123/context.json");
  assert.equal(files.transcript_md, ".gptwork/goals/goal_test_123/transcript.md");
  assert.equal(files.result_md, ".gptwork/goals/goal_test_123/result.md");
  assert.equal(files.payload_json, ".gptwork/goals/goal_test_123/payload.json");
  assert.equal(files.payload_base64, ".gptwork/goals/goal_test_123/payload.base64");
  assert.equal(files.bundle_zip, ".gptwork/goals/goal_test_123/bundle.zip");
  assert.equal(files.attachments_dir, ".gptwork/goals/goal_test_123/attachments");
  assert.equal(files.context_bundle_md, ".gptwork/goals/goal_test_123/context.bundle.md");
  assert.equal(files.context_retrieval_json, ".gptwork/goals/goal_test_123/context.retrieval.json");
  assert.equal(files.context_manifest_json, ".gptwork/goals/goal_test_123/context.manifest.json");
  assert.equal(files.result_json, ".gptwork/goals/goal_test_123/result.json");
  assert.equal(files.reviewer_decision_json, ".gptwork/goals/goal_test_123/reviewer_decision.json");
  assert.equal(files.artifact_contract_json, ".gptwork/goals/goal_test_123/artifact.contract.json");
  assert.equal(files.codex_entry_md, ".gptwork/goals/goal_test_123/codex.entry.md");
});

test("publicGoalWorkspaceFiles returns visible subset", () => {
  const goal = { id: "goal_public_1" };
  const visible = publicGoalWorkspaceFiles(goal);
  assert.equal(visible.dir, ".gptwork/goals/goal_public_1");
  assert.equal(visible.goal_md, ".gptwork/goals/goal_public_1/goal.md");
  assert.equal(visible.result_md, ".gptwork/goals/goal_public_1/result.md");
  assert.equal(visible.context_json, undefined);
  assert.equal(visible.transcript_md, undefined);
  assert.equal(visible.payload_json, undefined);
  assert.equal(visible.payload_base64, undefined);
  assert.equal(visible.bundle_zip, undefined);
  assert.equal(visible.attachments_dir, undefined);
});

test("publicGoalWorkspaceFiles includes attachments_dir when bundles present", () => {
  const goal = { id: "goal_bundled" };
  const visible = publicGoalWorkspaceFiles(goal, { bundles: [{ zip_base64: "AAAA" }] });
  assert.equal(visible.attachments_dir, ".gptwork/goals/goal_bundled/attachments");
});

test("internalGoalWorkspaceFiles returns internal-only subset", () => {
  const goal = { id: "goal_internal_1" };
  const internal = internalGoalWorkspaceFiles(goal);
  assert.equal(internal.context_json, ".gptwork/goals/goal_internal_1/context.json");
  assert.equal(internal.transcript_md, ".gptwork/goals/goal_internal_1/transcript.md");
  assert.equal(internal.context_bundle_md, ".gptwork/goals/goal_internal_1/context.bundle.md");
  assert.equal(internal.context_retrieval_json, ".gptwork/goals/goal_internal_1/context.retrieval.json");
  assert.equal(internal.context_manifest_json, ".gptwork/goals/goal_internal_1/context.manifest.json");
  assert.equal(internal.artifact_contract_json, ".gptwork/goals/goal_internal_1/artifact.contract.json");
  assert.equal(internal.codex_entry_md, ".gptwork/goals/goal_internal_1/codex.entry.md");
  assert.equal(internal.payload_json, ".gptwork/goals/goal_internal_1/payload.json");
  assert.equal(internal.payload_base64, ".gptwork/goals/goal_internal_1/payload.base64");
  assert.equal(internal.dir, undefined);
  assert.equal(internal.goal_md, undefined);
  assert.equal(internal.result_md, undefined);
  assert.equal(internal.attachments_dir, undefined);
});

test("hasGoalBundles detects bundles in payload", () => {
  assert.equal(hasGoalBundles({ bundles: [{ zip_base64: "AAAA" }] }), true);
  assert.equal(hasGoalBundles({ bundles: [] }), false);
  assert.equal(hasGoalBundles({}), false);
  assert.equal(hasGoalBundles(), false);
  assert.equal(hasGoalBundles({ bundles: [{ something: "else" }] }), false);
});

test("renderGoalMarkdown produces well-formed goal.md", () => {
  const goal = { id: "goal_md_test", title: "Test Goal", status: "assigned", mode: "builder", workspace_id: "ws-1", user_request: "Do something", goal_prompt: "Just do it", context_summary: "A summary", preview_text: "Preview text", autonomy_policy: { mode: "subagent_first", gpt_question_budget: 2 }, subagent_policy: { roles: ["analyst"] } };
  const conversation = { messages: [] };
  const memories = [];
  const task = { id: "task_123" };
  const files = goalWorkspaceFiles(goal);
  const md = renderGoalMarkdown(goal, conversation, memories, task, files);

  assert.match(md, /# GPTWork Goal goal_md_test/);
  assert.match(md, /Title: Test Goal/);
  assert.match(md, /Status: assigned/);
  assert.match(md, /Mode: builder/);
  assert.match(md, /Task: task_123/);
  assert.match(md, /Do something/);
  assert.match(md, /Just do it/);
  assert.match(md, /Preview text/);
  assert.match(md, /A summary/);
  assert.match(md, /subagent_first/);
  assert.match(md, /analyst/);
  assert.match(md, /codex\.entry\.md/);
});

test("renderGoalMarkdown handles missing fields", () => {
  const goal = { id: "goal_minimal", title: "Minimal", status: "open", mode: "chat", workspace_id: "ws-2" };
  const conversation = { messages: [] };
  const memories = [];
  const files = goalWorkspaceFiles(goal);
  const md = renderGoalMarkdown(goal, conversation, memories, null, files);

  assert.match(md, /Task: none/);
  assert.match(md, /\(none\)/);
});

test("renderCodexEntryMarkdown renders bounded entry", () => {
  const goal = { id: "goal_entry", title: "Entry", workspace_id: "ws", user_request: "Do x", goal_prompt: "Implement x", context_summary: "Summary" };
  const files = goalWorkspaceFiles(goal);
  const md = renderCodexEntryMarkdown(goal, { messages: [{ role: "user" }] }, [], { id: "task_1" }, files);
  assert.match(md, /# Codex Entry for goal_entry/);
  assert.match(md, /Do x/);
  assert.match(md, /Implement x/);
  assert.match(md, /Preferred bounded context/);
  assert.match(md, /Context manifest/);
  assert.match(md, /Metadata-only lookup/);
  assert.match(md, /payload files/);
  assert.match(md, /Conversation messages available: 1/);
});

test("renderTranscriptMarkdown renders messages", () => {
  const goal = { id: "goal_transcript" };
  const conversation = {
    messages: [
      { role: "user", content: "Hello", created_at: "2025-01-01T00:00:00Z" },
      { role: "assistant", content: "Hi there", created_at: "2025-01-01T00:01:00Z" }
    ]
  };
  const md = renderTranscriptMarkdown(goal, conversation);
  assert.match(md, /# Transcript for goal_transcript/);
  assert.match(md, /## user - 2025-01-01T00:00:00Z/);
  assert.match(md, /Hello/);
  assert.match(md, /## assistant - 2025-01-01T00:01:00Z/);
  assert.match(md, /Hi there/);
});

test("renderTranscriptMarkdown handles empty conversation", () => {
  const goal = { id: "goal_empty" };
  const md = renderTranscriptMarkdown(goal, {});
  assert.match(md, /# Transcript for goal_empty/);
});

test("codexInstruction contains entry-first execution instructions", () => {
  const goal = { id: "goal_codex_instr", autonomy_policy: { mode: "subagent_first", gpt_question_budget: 3 } };
  const instr = codexInstruction(goal);
  assert.match(instr, /parent Codex executor/);
  assert.match(instr, /you may start subagents/);
  assert.match(instr, /smallest reversible goal-aligned change/);
  assert.match(instr, /You must not ask ChatGPT for/);
  assert.match(instr, /- code navigation/);
  assert.match(instr, /- implementation choices/);
  assert.match(instr, /Only ask ChatGPT for/);
  assert.match(instr, /- credential\/account\/billing access/);
  assert.match(instr, /Read \.gptwork\/goals\/goal_codex_instr\/codex\.entry\.md first/);
  assert.match(instr, /context\.json only for metadata lookup/);
  assert.match(instr, /payload files only for explicit deep lookup/);
  assert.doesNotMatch(instr, /Read \.gptwork\/goals\/goal_codex_instr\/goal\.md and \.gptwork\/goals\/goal_codex_instr\/context\.json before acting/);
  assert.doesNotMatch(instr, /transcript\.md before acting/);
});

test("safeBundleName sanitizes bundle names", () => {
  assert.equal(safeBundleName("normal.zip"), "normal.zip");
  assert.equal(safeBundleName("../evil.zip"), "evil.zip");
  assert.equal(safeBundleName("a<b>c?.zip"), "a_b_c_.zip");
  assert.equal(safeBundleName(), "bundle.zip");
  assert.equal(safeBundleName(""), "bundle.zip");
  assert.equal(safeBundleName(null), "bundle.zip");
});
