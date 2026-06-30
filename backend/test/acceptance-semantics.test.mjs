import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptanceContract } from "../src/acceptance/contract-builder.mjs";
import { validateContractSemantics } from "../src/acceptance/semantics.mjs";

test("accepts a default code_change contract", () => {
  const contract = buildAcceptanceContract({ user_request: "Fix backend code", goal_prompt: "Modify code, test and commit." });
  const result = validateContractSemantics(contract);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.review_policy.requires_review_when.includes("contract_invalid"), false);
});

test("marks unknown operation kinds invalid", () => {
  const result = validateContractSemantics({
    schema_version: 1,
    intent: { operation_kind: "magic", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: {},
    blocking_requirements: []
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /unknown operation_kind/.test(error.message)));
  assert.ok(result.normalized.review_policy.requires_review_when.includes("contract_invalid"));
});

test("detects diagnostic contracts that require commit or integration", () => {
  const contract = buildAcceptanceContract({ user_request: "Diagnose queue state", goal_prompt: "Read only and report." });
  contract.requirements.requires_commit = true;
  contract.requirements.requires_integration = true;

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /diagnostic.*commit/i.test(error.message)));
  assert.ok(result.errors.some((error) => /diagnostic.*integration/i.test(error.message)));
  assert.equal(result.normalized.completion_policy.auto_complete_when_blocking_requirements_pass, false);
});

test("detects restart contracts that require changed files or commit", () => {
  const contract = buildAcceptanceContract({ user_request: "Restart the service", goal_prompt: "Restart and verify health." });
  contract.requirements.requires_commit = true;
  contract.blocking_requirements.push({ id: "changed_files_reported", evidence: ["changed_files"] });

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /restart.*commit/i.test(error.message)));
  assert.ok(result.errors.some((error) => /restart.*changed_files/i.test(error.message)));
});

test("detects deploy contracts missing health or runtime evidence", () => {
  const contract = buildAcceptanceContract({ user_request: "Deploy the service", goal_prompt: "Build and deploy." });
  contract.blocking_requirements = contract.blocking_requirements.filter((item) => item.id !== "deployment_health" && item.id !== "runtime_version_evidence");

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /deploy.*health/i.test(error.message)));
  assert.ok(result.errors.some((error) => /deploy.*runtime/i.test(error.message)));
});

test("detects cleanup contracts without dry-run or explicit exemption", () => {
  const contract = buildAcceptanceContract({ user_request: "Clean old goal files", goal_prompt: "Remove stale files and report counts." });
  contract.blocking_requirements = contract.blocking_requirements.filter((item) => item.id !== "dry_run_evidence");
  contract.state_assertions = contract.state_assertions.filter((item) => item.id !== "dry_run_not_needed_reason");

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /cleanup.*dry-run/i.test(error.message)));
});

test("ambiguous closure-only fields cannot decide completion", () => {
  const contract = buildAcceptanceContract({ user_request: "Fix backend code", goal_prompt: "Modify code, test and commit." });
  contract.blocking_requirements = [{ id: "done", evidence: ["ok", "passed"] }];

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /ambiguous closure field/i.test(error.message)));
});

test("branch_pushed and pr_opened are not treated as integration", () => {
  const contract = buildAcceptanceContract({ user_request: "Fix backend code", goal_prompt: "Modify code, test and commit." });
  contract.state_assertions.push({ id: "branch_pushed", means: "merged" });
  contract.state_assertions.push({ id: "pr_opened", means: "merged" });

  const result = validateContractSemantics(contract);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /branch_pushed.*merged/i.test(error.message)));
  assert.ok(result.errors.some((error) => /pr_opened.*merged/i.test(error.message)));
});
