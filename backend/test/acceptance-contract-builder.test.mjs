import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptanceContract } from "../src/acceptance/contract-builder.mjs";

test("infers code_change contracts with commit and integration requirements", () => {
  const contract = buildAcceptanceContract({
    user_request: "Fix the task verifier bug and add tests",
    goal_prompt: "Modify backend code, verify changed files, commit the result."
  });

  assert.equal(contract.intent.operation_kind, "code_change");
  assert.equal(contract.intent.mutation_scope, "repo");
  assert.equal(contract.intent.execution_mode, "worktree");
  assert.equal(contract.requirements.requires_commit, true);
  assert.equal(contract.requirements.requires_integration, true);
  assert.equal(contract.verification_plan.profile, "changed");
  assert.ok(contract.blocking_requirements.some((item) => item.id === "commit_present"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "changed_files_reported"));
  assert.ok(contract.non_blocking_quality_expectations.some((item) => /followup/i.test(item.id)));
});

test("infers restart contracts without commit or integration requirements", () => {
  const contract = buildAcceptanceContract({
    user_request: "Restart GPTWork service safely and verify health",
    goal_prompt: "Restart the running service, report process status and health check evidence.",
    mode: "admin"
  });

  assert.equal(contract.intent.operation_kind, "restart");
  assert.equal(contract.intent.mutation_scope, "runtime");
  assert.equal(contract.intent.execution_mode, "admin");
  assert.equal(contract.requirements.requires_commit, false);
  assert.equal(contract.requirements.requires_integration, false);
  assert.equal(contract.requirements.requires_restart, true);
  assert.ok(contract.blocking_requirements.some((item) => item.id === "runtime_health_evidence"));
  assert.ok(!contract.blocking_requirements.some((item) => item.id === "changed_files_reported"));
});

test("infers file_write contracts with file evidence and commit requirements", () => {
  const contract = buildAcceptanceContract({
    user_request: "Write a new configuration example file under docs/examples",
    goal_prompt: "Create the file, report path and checksum, commit it."
  });

  assert.equal(contract.intent.operation_kind, "file_write");
  assert.equal(contract.requirements.requires_commit, true);
  assert.equal(contract.requirements.requires_integration, true);
  assert.ok(contract.blocking_requirements.some((item) => item.id === "file_exists"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "file_checksum"));
});

test("infers admin_command contracts with pre/post/audit evidence", () => {
  const contract = buildAcceptanceContract({
    user_request: "Run the queue recovery command and report the result",
    goal_prompt: "Capture pre-state, execute the management command, capture post-state and audit evidence."
  });

  assert.equal(contract.intent.operation_kind, "admin_command");
  assert.equal(contract.intent.mutation_scope, "runtime");
  assert.equal(contract.intent.execution_mode, "admin");
  assert.ok(contract.blocking_requirements.some((item) => item.id === "pre_state_snapshot"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "post_state_snapshot"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "audit_evidence"));
});

test("infers diagnostic contracts as readonly with report artifact and no commit", () => {
  const contract = buildAcceptanceContract({
    user_request: "Diagnose why workers are stuck and summarize findings",
    goal_prompt: "Inspect status only. Do not mutate state. Produce a diagnostic report."
  });

  assert.equal(contract.intent.operation_kind, "diagnostic");
  assert.equal(contract.intent.mutation_scope, "none");
  assert.equal(contract.intent.execution_mode, "readonly");
  assert.equal(contract.requirements.requires_commit, false);
  assert.equal(contract.requirements.requires_integration, false);
  assert.ok(contract.blocking_requirements.some((item) => item.id === "no_mutation_evidence"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "diagnostic_report"));
});

test("infers docs_only contracts without full gate requirements", () => {
  const contract = buildAcceptanceContract({
    user_request: "Update README documentation for release verification",
    goal_prompt: "Edit docs only and run lightweight documentation checks."
  });

  assert.equal(contract.intent.operation_kind, "docs_only");
  assert.equal(contract.requirements.requires_commit, true);
  assert.equal(contract.requirements.requires_integration, false);
  assert.equal(contract.verification_plan.profile, "docs");
  assert.ok(!contract.verification_plan.required_commands.includes("full_gate"));
  assert.ok(!contract.blocking_requirements.some((item) => item.id === "integration_completed"));
});

test("ambiguous requests remain low confidence and require review", () => {
  const contract = buildAcceptanceContract({
    user_request: "Handle it",
    goal_prompt: "Do the necessary thing."
  });

  assert.equal(contract.intent.semantic_confidence, "low");
  assert.ok(contract.review_policy.requires_review_when.includes("semantic_ambiguity"));
  assert.equal(contract.completion_policy.auto_complete_when_blocking_requirements_pass, false);
});

test("builder optimization repair requests are not inferred as noop", () => {
  const contract = buildAcceptanceContract({
    user_request: "优化修复后端自动推进",
    goal_prompt: "修复自动推进问题并增加测试。",
    mode: "builder"
  });

  assert.notEqual(contract.intent.operation_kind, "noop");
  assert.equal(contract.intent.operation_kind, "code_change");
});



test("builder runtime-fix tasks mentioning cleanup/admin misclassification remain code_change", () => {
  const contract = buildAcceptanceContract({
    user_request: "Continue: fix the R3 acceptance contract cleanup/admin misclassification and converge blockers",
    goal_prompt: "Implement a runtime-fix in backend acceptance contract classification. The task mentions cleanup/admin only as the wrong contract that must not block a code-change apply path.",
    mode: "builder"
  });

  assert.equal(contract.intent.operation_kind, "code_change");
  assert.equal(contract.intent.mutation_scope, "repo");
  assert.equal(contract.intent.execution_mode, "worktree");
  assert.equal(contract.requirements.requires_commit, true);
  assert.equal(contract.requirements.requires_integration, true);
  assert.ok(!contract.verification_plan.required_reports.includes("dry_run"));
  assert.ok(!contract.blocking_requirements.some((item) => item.id === "dry_run_evidence"));
});

test("vague builder requests do not auto-complete", () => {
  const contract = buildAcceptanceContract({
    user_request: "Task 1",
    goal_prompt: "First task for same repo",
    mode: "builder"
  });

  assert.notEqual(contract.intent.operation_kind, "noop");
  assert.equal(contract.intent.semantic_confidence, "low");
  assert.ok(contract.review_policy.requires_review_when.includes("semantic_ambiguity"));
  assert.equal(contract.completion_policy.auto_complete_when_blocking_requirements_pass, false);
});

test("explicit builder no-op requests remain noop", () => {
  const contract = buildAcceptanceContract({
    user_request: "No-op: this task is already done, do nothing",
    goal_prompt: "无需操作，报告无需改动即可。",
    mode: "builder"
  });

  assert.equal(contract.intent.operation_kind, "noop");
  assert.equal(contract.intent.semantic_confidence, "high");
});

test("explicit Chinese builder noop requests remain noop", () => {
  const contract = buildAcceptanceContract({
    user_request: "无需操作",
    goal_prompt: "无需改动，报告现状即可。",
    mode: "builder"
  });

  assert.equal(contract.intent.operation_kind, "noop");
  assert.equal(contract.intent.semantic_confidence, "high");
});

test("normalizes an explicit contract while preserving caller intent", () => {
  const contract = buildAcceptanceContract({
    user_request: "Restart the service",
    goal_prompt: "Restart and verify health.",
    acceptance_contract: {
      intent: { operation_kind: "restart" },
      blocking_requirements: [{ id: "custom_health_probe", evidence: ["http_200"] }]
    }
  });

  assert.equal(contract.schema_version, 1);
  assert.equal(contract.intent.operation_kind, "restart");
  assert.equal(contract.requirements.requires_restart, true);
  assert.ok(contract.blocking_requirements.some((item) => item.id === "custom_health_probe"));
  assert.ok(contract.blocking_requirements.some((item) => item.id === "runtime_health_evidence"));
});
