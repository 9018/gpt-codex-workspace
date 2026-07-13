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

// ===========================================================================
// B1: Explicit interactive_tui/docs_only contract must not be replaced by
// data_migration semantic classification, even when intent block has
// corrupted character-indexed keys (serialization artifacts).
// ===========================================================================

test("B1: top-level operation_kind in explicit contract beats corrupted intent classification", () => {
  const contract = buildAcceptanceContract({
    user_request: "Continue interactive TUI: fix goal convergence and add tests",
    goal_prompt: "修复自动化收敛问题并增加测试。TUI session 完成 docs-only 闭包验收。",
    mode: "builder",
    acceptance_contract: {
      // Simulate the corrupted intent from the real bug:
      // intent has character-indexed keys + wrong data_migration classification
      intent: {
        "0": "i", "1": "m", "2": "p", "3": "l", "4": "e", "5": "m", "6": "e",
        "7": "n", "8": "t", "9": "a", "10": "t", "11": "i", "12": "o", "13": "n",
        operation_kind: "data_migration",
        mutation_scope: "external_system",
        execution_mode: "admin",
        semantic_confidence: "medium",
      },
      // Top-level fields are the CORRECT explicit contract:
      operation_kind: "code_change",
      mutation_scope: "code_tests_docs",
    },
  });

  // STORM: This currently fails — contract.intent.operation_kind is "data_migration"
  assert.equal(contract.intent.operation_kind, "code_change",
    "explicit top-level operation_kind must override corrupted intent classification");
  // mutation_scope should come from the correct explicit contract, not intent
  assert.equal(contract.intent.mutation_scope, "repo",
    "mutation_scope should be resolved correctly, not from corrupted intent external_system");
  // execution_mode should be from the correct profile, not corrupted intent's admin
  assert.equal(contract.intent.execution_mode, "worktree",
    "execution_mode should match the code_change profile, not intent's admin");

  // Must NOT have data_migration blockers (backup, dry_run, apply, counts, rollback)
  const blockerIds = contract.blocking_requirements.map((b) => b.id);
  assert.ok(!blockerIds.includes("backup_evidence"), "must not have data_migration backup_evidence blocker");
  assert.ok(!blockerIds.includes("dry_run_evidence"), "must not have data_migration dry_run_evidence blocker");
  assert.ok(!blockerIds.includes("migration_apply_evidence"), "must not have data_migration apply_evidence blocker");
  assert.ok(!blockerIds.includes("before_after_counts"), "must not have data_migration counts blocker");

  // Must have code_change blockers instead
  assert.ok(blockerIds.includes("commit_present"), "should have code_change commit_present blocker");
  assert.ok(blockerIds.includes("verification_report"), "should have verification_report blocker");

  // Character-indexed keys should be stripped from intent
  assert.equal(contract.intent["0"], undefined, "character-indexed key '0' should be stripped from intent");
  assert.equal(contract.intent["13"], undefined, "character-indexed key '13' should be stripped from intent");
});

// ===========================================================================
// B2: Explicit docs_only contract with intent enrichment should not create
// data_migration blockers even when text also mentions "migration"
// ===========================================================================

test("B2: explicit docs_only contract must not be replaced even when text mentions migration", () => {
  const contract = buildAcceptanceContract({
    user_request: "Accept docs-only commit after TUI session: migration_fixer.md was wrong classification",
    goal_prompt: "Fix classification for docs-only commit. Previous misclassification as data_migration caused blockers.",
    mode: "builder",
    acceptance_contract: {
      intent: {
        "0": "i",
        operation_kind: "docs_only",
        mutation_scope: "repo",
        execution_mode: "worktree",
        semantic_confidence: "high",
      },
    },
  });

  // Should be docs_only, NOT data_migration
  assert.equal(contract.intent.operation_kind, "docs_only",
    "explicit docs_only contract must be respected");
  assert.equal(contract.requirements.requires_commit, true, "docs_only requires commit");
  assert.equal(contract.requirements.requires_integration, false, "docs_only does not require integration");

  // Should NOT have data_migration blockers
  const blockerIds = contract.blocking_requirements.map((b) => b.id);
  assert.ok(!blockerIds.includes("backup_evidence"), "no backup blocker for docs_only");
  assert.ok(!blockerIds.includes("dry_run_evidence"), "no dry_run blocker for docs_only");

  // Should have docs_only blockers
  assert.ok(blockerIds.includes("docs_changed"), "docs_only should have docs_changed blocker");
  assert.ok(blockerIds.includes("commit_present"), "docs_only should have commit_present blocker");

  // Character-indexed key should be stripped
  assert.equal(contract.intent["0"], undefined, "character-indexed key '0' should be stripped");
});

// ===========================================================================
// B3: When intent has ONLY character-indexed keys (no valid enrichment),
// the inference from user_request/goal_prompt should determine the contract
// ===========================================================================

test("B3: intent with only character-indexed keys falls through to semantic inference", () => {
  const contract = buildAcceptanceContract({
    user_request: "修复后端自动推进问题并增加测试",
    goal_prompt: "Implement runtime-fix for goal convergence and add tests.",
    mode: "builder",
    acceptance_contract: {
      intent: {
        "0": "i", "1": "m", "2": "p", "3": "l", "4": "e", "5": "m", "6": "e",
        "7": "n", "8": "t", "9": "a", "10": "t", "11": "i", "12": "o", "13": "n",
      },
      // No operation_kind at top level or in intent enrichment
    },
  });

  // Should fall through to inference (code_change because of "修复" + "implement")
  assert.equal(contract.intent.operation_kind, "code_change",
    "should infer code_change from user_request when intent has only character keys");
  assert.equal(contract.requirements.requires_commit, true, "code_change requires commit");
  assert.equal(contract.requirements.requires_integration, true, "code_change requires integration");

  // Character-indexed keys should be stripped
  assert.equal(contract.intent["0"], undefined, "character-indexed key '0' must be stripped");
  assert.equal(contract.intent["13"], undefined, "character-indexed key '13' must be stripped");
});
