import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { validateAutonomyResult, parseResultJson, parseCodexResult } from "../src/codex-result-parser.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-autonomy-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

// ---------------------------------------------------------------------------
// validateAutonomyResult unit tests
// ---------------------------------------------------------------------------

test("validateAutonomyResult: passes when no policy is set", () => {
  const result = { status: "completed" };
  const goal = {}; // no autonomy_policy or subagent_policy
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, true);
});

test("validateAutonomyResult: passes when subagent_policy mode is not required", () => {
  const result = { status: "completed", subagents_used: false };
  const goal = {
    subagent_policy: { mode: "optional" },
    autonomy_policy: { gpt_question_budget: 0 }
  };
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, true);
});

test("validateAutonomyResult: fails when subagent mode required but not used", () => {
  const result = { status: "completed", subagents_used: false };
  const goal = {
    subagent_policy: { mode: "required" },
    autonomy_policy: { gpt_question_budget: 0 }
  };
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "subagents_required_but_not_used");
});

test("validateAutonomyResult: fails when subagents report missing", () => {
  const result = { status: "completed", subagents_used: true, subagents: undefined };
  const goal = {
    subagent_policy: { mode: "required" },
    autonomy_policy: { gpt_question_budget: 0 }
  };
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "missing_subagent_report");
});

test("validateAutonomyResult: passes with valid subagents report", () => {
  const result = {
    status: "completed",
    subagents_used: true,
    subagents: [{ role: "analyst", status: "completed", summary: "..." }],
    gpt_questions_used: 0
  };
  const goal = {
    subagent_policy: { mode: "required" },
    autonomy_policy: { gpt_question_budget: 0 }
  };
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, true);
});

test("validateAutonomyResult: fails when GPT question budget exceeded", () => {
  const result = {
    status: "completed",
    subagents_used: true,
    subagents: [{ role: "analyst", status: "completed", summary: "..." }],
    gpt_questions_used: 3
  };
  const goal = {
    subagent_policy: { mode: "required" },
    autonomy_policy: { gpt_question_budget: 1 }
  };
  const validation = validateAutonomyResult(result, goal);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "gpt_question_budget_exceeded");
});

// ---------------------------------------------------------------------------
// Default policy injection tests
// ---------------------------------------------------------------------------

test("createGoal injects default autonomy_policy and subagent_policy", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Test user request",
    goal_prompt: "Test goal prompt",
    workspace_id: "hosted-default",
    mode: "builder",
    assign_to_codex: false
  });

  // Verify policy fields exist with defaults
  assert.ok(created.goal.autonomy_policy, "autonomy_policy should exist");
  assert.equal(created.goal.autonomy_policy.mode, "subagent_first");
  assert.equal(created.goal.autonomy_policy.gpt_question_budget, 0);
  assert.equal(created.goal.autonomy_policy.allow_autonomous_defaults, true);
  assert.equal(created.goal.autonomy_policy.default_decision_rule, "choose_smallest_reversible_goal_aligned_change");

  assert.ok(created.goal.subagent_policy, "subagent_policy should exist");
  assert.equal(created.goal.subagent_policy.mode, "required");
  assert.deepEqual(created.goal.subagent_policy.roles, ["analyst", "architect", "implementer", "tester", "reviewer", "escalation_judge"]);
  assert.equal(created.goal.subagent_policy.require_review_before_completion, true);
  assert.equal(created.goal.subagent_policy.require_test_or_verification, true);
});

test("createEncodedGoal injects default policies when payload lacks them", async () => {
  const server = await makeServer();

  const payload = {
    user_request: "Encoded goal test",
    goal_prompt: "Run encoded goal prompt"
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  const created = await callTool(server, "create_encoded_goal", {
    preview_text: "Preview",
    payload_base64: payloadBase64,
    assign_to_codex: false
  });

  assert.ok(created.goal.autonomy_policy, "autonomy_policy should exist");
  assert.equal(created.goal.autonomy_policy.mode, "subagent_first");
  assert.ok(created.goal.subagent_policy, "subagent_policy should exist");
  assert.equal(created.goal.subagent_policy.mode, "required");
});

test("createEncodedGoal respects custom policies in payload", async () => {
  const server = await makeServer();

  const payload = {
    user_request: "Custom policy test",
    goal_prompt: "Test custom policies",
    autonomy_policy: {
      mode: "subagent_first",
      gpt_question_budget: 5,
      allow_autonomous_defaults: false,
      default_decision_rule: "ask_human"
    },
    subagent_policy: {
      mode: "optional",
      roles: ["analyst"],
      require_review_before_completion: false,
      require_test_or_verification: false
    }
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  const created = await callTool(server, "create_encoded_goal", {
    preview_text: "Preview",
    payload_base64: payloadBase64,
    assign_to_codex: false
  });

  assert.ok(created.goal.autonomy_policy);
  assert.equal(created.goal.autonomy_policy.gpt_question_budget, 5);
  assert.equal(created.goal.autonomy_policy.allow_autonomous_defaults, false);
  assert.equal(created.goal.autonomy_policy.default_decision_rule, "ask_human");
  assert.equal(created.goal.subagent_policy.mode, "optional");
  assert.deepEqual(created.goal.subagent_policy.roles, ["analyst"]);
  assert.equal(created.goal.subagent_policy.require_review_before_completion, false);
});

// ---------------------------------------------------------------------------
// goal.md rendering tests
// ---------------------------------------------------------------------------

test("goal.md contains Autonomy Policy and Subagent Policy sections", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Test user request",
    goal_prompt: "Test goal prompt",
    workspace_id: "hosted-default",
    mode: "builder",
    assign_to_codex: false
  });

  // Read goal.md via workspace read_text_file tool
  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  const goalMd = await callTool(server, "read_text_file", { path: context.workspace_files.goal_md });

  assert.match(goalMd.content, /## Autonomy Policy/);
  assert.match(goalMd.content, /## Subagent Policy/);
  assert.match(goalMd.content, /Mode: subagent_first/);
  assert.match(goalMd.content, /GPT question budget: 0/);
  assert.match(goalMd.content, /Do not ask ChatGPT for implementation decisions/);
  assert.match(goalMd.content, /Required roles:/);
  assert.match(goalMd.content, /- analyst/);
  assert.match(goalMd.content, /- escalation_judge/);
});

// ---------------------------------------------------------------------------
// codexInstruction rendering tests
// ---------------------------------------------------------------------------

test("codexInstruction contains subagent-first execution requirements", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Test subagent instruction",
    goal_prompt: "Test goal prompt",
    workspace_id: "hosted-default",
    mode: "builder",
    assign_to_codex: false
  });

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });

  const instruction = context.codex_instruction;
  assert.match(instruction, /parent Codex agent/);
  assert.match(instruction, /subagent-first autonomous execution/);
  assert.match(instruction, /Use internal subagents to analyze/);
  assert.match(instruction, /smallest reversible goal-aligned change/);
  // goal.md contains 'Do not ask ChatGPT for implementation decisions', not instruction
  // These are now in the codexInstruction instead of the old simpler version
  assert.match(instruction, /You must not ask ChatGPT for/);
  assert.match(instruction, /- code navigation/);
  assert.match(instruction, /- implementation choices/);
  assert.match(instruction, /- test failures/);
  assert.match(instruction, /Only ask ChatGPT for/);
  assert.match(instruction, /- product behavior decisions/);
  assert.match(instruction, /- credential\/account\/billing access/);
});

// ---------------------------------------------------------------------------
// result.json contract validation via parseResultJson
// ---------------------------------------------------------------------------

test("parseResultJson extracts autonomy fields from result.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-result-test-"));
  const resultPath = join(root, "result.json");

  const resultData = {
    status: "completed",
    summary: "Test completed",
    subagents_used: true,
    subagents: [
      { role: "analyst", status: "completed", summary: "Analysis done" },
      { role: "implementer", status: "completed", summary: "Implementation done" }
    ],
    gpt_questions_used: 1,
    decision_log: [{ step: "1", action: "analyzed" }],
    verification: { commands: ["npm test"], passed: true },
    escalation: { needed: false, reason: "All technical" }
  };

  await writeFile(resultPath, JSON.stringify(resultData, null, 2));

  const parsed = await parseResultJson(resultPath);
  assert.ok(parsed, "Should parse successfully");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.subagents_used, true);
  assert.ok(Array.isArray(parsed.subagents));
  assert.equal(parsed.subagents.length, 2);
  assert.equal(parsed.gpt_questions_used, 1);
  assert.ok(Array.isArray(parsed.decision_log));
  assert.equal(parsed.decision_log.length, 1);
  assert.ok(parsed.verification);
  assert.equal(parsed.verification.passed, true);
  assert.ok(parsed.escalation);
  assert.equal(parsed.escalation.needed, false);
});

// ---------------------------------------------------------------------------
// payload.json contains policy fields
// ---------------------------------------------------------------------------

test("payload.json includes autonomy_policy and subagent_policy", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Payload policy test",
    goal_prompt: "Test payload",
    workspace_id: "hosted-default",
    mode: "builder",
    assign_to_codex: false
  });

  const files = created.workspace_files;
  // payload.json isn't in workspace_files - need to construct the path
  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  const payloadJson = await callTool(server, "read_text_file", { path: `${context.workspace_files.dir}/payload.json` });
  const payload = JSON.parse(payloadJson.content);

  assert.ok(payload.autonomy_policy);
  assert.ok(payload.subagent_policy);
  assert.equal(payload.autonomy_policy.mode, "subagent_first");
  assert.equal(payload.subagent_policy.mode, "required");
});

// ---------------------------------------------------------------------------
// context.json includes policies in the goal object
// ---------------------------------------------------------------------------

test("context.json includes autonomy_policy and subagent_policy in goal", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Context policy test",
    goal_prompt: "Test context",
    workspace_id: "hosted-default",
    mode: "builder",
    assign_to_codex: false
  });

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.ok(context.goal.autonomy_policy);
  assert.ok(context.goal.subagent_policy);
  assert.equal(context.goal.autonomy_policy.mode, "subagent_first");
  assert.equal(context.goal.subagent_policy.mode, "required");
});
