import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-acceptance-contract-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });
}

async function callTool(server, name, args = {}) {
  const handler = server.getToolForTests(name);
  assert.equal(typeof handler, "function");
  return handler(args, { user_id: "test", scopes: ["task:create", "task:update", "task:read", "project:read", "workspace:read", "workspace:write", "files:download"], project_ids: [String.fromCharCode(42)], workspace_ids: [String.fromCharCode(42)], emitProgress() {} });
}

test("create_goal writes inferred acceptance.contract.json and references it from goal files", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Restart GPTWork service safely and verify health",
    goal_prompt: "Restart the running service, then report process, health, and runtime evidence.",
    context_summary: "Runtime operation, not a repo code change.",
    workspace_id: "hosted-default",
    mode: "admin",
    assign_to_codex: true
  });

  assert.equal(created.goal.acceptance_contract.intent.operation_kind, "restart");
  assert.equal(created.goal.acceptance_contract.requirements.requires_commit, false);
  assert.equal(created.workspace_files.acceptance_contract_json, `.gptwork/goals/${created.goal.id}/acceptance.contract.json`);

  const contractFile = await callTool(server, "read_text_file", { path: created.workspace_files.acceptance_contract_json });
  const contract = JSON.parse(contractFile.content);
  assert.equal(contract.intent.operation_kind, "restart");
  assert.ok(contract.blocking_requirements.some((item) => item.id === "runtime_health_evidence"));

  const goalMd = await callTool(server, "read_text_file", { path: created.workspace_files.goal_md });
  assert.match(goalMd.content, /acceptance\.contract\.json/);

  const codexEntry = await callTool(server, "read_text_file", { path: created.workspace_files.codex_entry_md });
  assert.match(codexEntry.content, /You must satisfy acceptance\.contract\.json/);
  assert.match(codexEntry.content, /Only blocking_requirements block closure/);
  assert.match(codexEntry.content, /Non-blocking quality concerns must be reported as followup_findings/);

  const context = await callTool(server, "get_goal_context", { goal_id: created.goal.id });
  assert.equal(context.workspace_files.acceptance_contract_json, `.gptwork/goals/${created.goal.id}/acceptance.contract.json`);
  assert.equal(context.goal.acceptance_contract.intent.operation_kind, "restart");
});

test("create_encoded_goal preserves explicit acceptance_contract and legacy callers remain compatible", async () => {
  const server = await makeServer();
  const payload = {
    user_request: "Diagnose stuck worker queue",
    goal_prompt: "Inspect the queue only and write a diagnostic report. Do not mutate state.",
    context_summary: "Readonly diagnostic task.",
    workspace_id: "hosted-default",
    acceptance_contract: {
      intent: { operation_kind: "diagnostic" },
      blocking_requirements: [{ id: "custom_report_artifact", evidence: ["report_path"] }]
    }
  };

  const encoded = await callTool(server, "create_encoded_goal", {
    preview_text: "I will diagnose the stuck worker queue.",
    payload_base64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    assign_to_codex: true
  });

  assert.equal(encoded.goal.acceptance_contract.intent.operation_kind, "diagnostic");
  assert.equal(encoded.goal.acceptance_contract.requirements.requires_commit, false);
  assert.ok(encoded.goal.acceptance_contract.blocking_requirements.some((item) => item.id === "custom_report_artifact"));
  assert.equal(encoded.internal_files.acceptance_contract_json, `.gptwork/goals/${encoded.goal.id}/acceptance.contract.json`);

  const legacy = await callTool(server, "create_goal", {
    user_request: "Update README docs",
    goal_prompt: "Edit README documentation and verify the diff.",
    assign_to_codex: false
  });

  assert.match(legacy.goal.id, /^goal_/);
  assert.ok(legacy.goal.acceptance_contract);
  assert.equal(legacy.goal.acceptance_contract.intent.operation_kind, "docs_only");
});

test("conflicting explicit acceptance_contract is marked for review instead of auto completion", async () => {
  const server = await makeServer();

  const created = await callTool(server, "create_goal", {
    user_request: "Restart GPTWork service safely",
    goal_prompt: "Restart the service and verify health.",
    assign_to_codex: true,
    acceptance_contract: {
      intent: { operation_kind: "restart" },
      requirements: { requires_commit: true },
      blocking_requirements: [{ id: "changed_files_reported", evidence: ["changed_files"] }]
    }
  });

  const contract = created.goal.acceptance_contract;
  assert.equal(contract.intent.operation_kind, "restart");
  assert.ok(contract.review_policy.requires_review_when.includes("contract_invalid"));
  assert.equal(contract.completion_policy.auto_complete_when_blocking_requirements_pass, false);
  assert.ok(contract.semantic_validation.errors.some((error) => /restart.*commit/i.test(error.message)));
});

test("create_goal accepts implementation as a product alias and creates a builder worktree task", async () => {
  const server = await makeServer();
  const created = await callTool(server, "create_goal", {
    title: "implementation alias canary",
    user_request: "Create a docs canary and test it",
    goal_prompt: "Write the file, run tests, commit, and integrate.",
    mode: "implementation",
    assign_to_codex: true,
    acceptance_contract: {
      operation_kind: "implementation",
      execution_mode: "builder",
      mutation_scope: "docs_and_tests_only",
      requires_commit: true,
      requires_integration: true,
    },
  });

  assert.equal(created.goal.mode, "builder");
  assert.equal(created.task.mode, "builder");
  assert.equal(created.task.execution_mode, "worktree");
  assert.equal(created.task.worktree.enabled, true);
  assert.equal(created.goal.acceptance_contract.intent.operation_kind, "code_change");
  assert.equal(created.goal.acceptance_contract.intent.execution_mode, "worktree");
  assert.equal(created.goal.acceptance_contract.intent.mutation_scope, "repo");
  assert.equal(created.goal.acceptance_contract.requirements.requires_commit, true);
  assert.equal(created.goal.acceptance_contract.requirements.requires_integration, true);
});
