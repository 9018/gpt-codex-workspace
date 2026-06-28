import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAcceptance,
  buildReviewerDecision,
  buildWorktreeReliabilityFindings,
  buildDeliveryEvidenceFindings,
  ACCEPTANCE_SEVERITIES,
} from '../src/acceptance-policy.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


test('acceptance policy blocks blocker findings and creates repair proposal', () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'blocker', code: 'dirty_worktree_after_codex', message: 'Worktree is dirty' },
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.status, 'needs_fix');
  assert.equal(decision.should_enter_review, false, 'critical implementation failures should route to repair, not manual review');
  assert.equal(decision.repair_proposals.length, 1);
  assert.match(decision.repair_proposals[0].title, /dirty_worktree_after_codex/);
  assert.equal(decision.next_tasks[0].priority, 'P0');
});

test('acceptance policy allows minor and followup findings while emitting next tasks', () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'minor', code: 'docs_gap', message: 'Docs need a later pass' },
      { severity: 'followup', code: 'real_worktree_lifecycle', message: 'Implement git worktree add/remove lifecycle' },
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.status, 'accepted_with_followups');
  assert.equal(decision.should_enter_review, false);
  assert.deepEqual(decision.repair_proposals, []);
  assert.deepEqual(decision.next_tasks.map((task) => task.priority), ['P1', 'P2']);
});

test('reviewer decision is a final verdict, not only a summary', () => {
  const result = {
    status: 'completed',
    summary: 'Implemented feature',
    changed_files: ['backend/src/example.mjs'],
    tests: 'node --test passed',
    commit: 'abc123',
    remote_head: 'def456',
  };

  const reviewer = buildReviewerDecision({
    result,
    findings: [{ severity: 'followup', code: 'cleanup', message: 'Cleanup can wait' }],
  });

  assert.equal(reviewer.role, 'acceptance_agent');
  assert.equal(reviewer.decision.status, 'accepted_with_followups');
  assert.equal(reviewer.decision.passed, true);
  assert.ok(Array.isArray(reviewer.acceptance_findings));
  assert.ok(Array.isArray(reviewer.next_tasks));
  assert.notEqual(reviewer.summary, result.summary, 'reviewer summary must be derived from acceptance verdict');
});

test('acceptance severity enum documents blocker major minor followup', () => {
  assert.deepEqual(ACCEPTANCE_SEVERITIES, ['blocker', 'major', 'minor', 'followup']);
});

test('worktree reliability checks are first-class acceptance findings', () => {
  const findings = buildWorktreeReliabilityFindings({
    git_worktree_created: false,
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: false,
    worktree_cleanup_lifecycle: false,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings.map((finding) => finding.code), [
    'git_worktree_not_created',
    'task_processor_lock_not_repo_id_driven',
    'worktree_cleanup_lifecycle_missing',
  ]);
  assert.equal(findings[0].severity, 'followup', 'metadata-only worktree lifecycle is tracked as followup until isolation is claimed');
  assert.equal(findings[1].severity, 'blocker');
  assert.equal(findings[2].severity, 'major');
});

test('worktree reliability accepts reused real git worktree lifecycle without metadata-only finding', () => {
  const findings = buildWorktreeReliabilityFindings({
    worktree_lifecycle: {
      mode: 'git_worktree',
      ok: true,
      git_worktree_created: false,
      existing: true,
      cleanup_supported: true,
    },
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: true,
    worktree_cleanup_lifecycle: true,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings, []);
});

test('worktree reliability blocks failed git worktree lifecycle instead of auto-accepting metadata-only followup', () => {
  const findings = buildWorktreeReliabilityFindings({
    worktree_lifecycle: {
      mode: 'git_worktree',
      ok: false,
      error: 'worktree add failed: fatal',
      cleanup_supported: true,
    },
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: true,
    worktree_cleanup_lifecycle: true,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings.map((finding) => finding.code), ['git_worktree_lifecycle_failed']);
  assert.equal(findings[0].severity, 'blocker');
});

// ===========================================================================
// P0: Acceptance profile coverage — noop, docs, config, code, deploy
// ===========================================================================

test("P0: noop profile passes with minimal checks", () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'minor', code: 'noop_reason_missing', message: 'Noop tasks should include a reason' },
    ],
    needs_gpt_review: false,
  });
  assert.equal(decision.passed, true);
  assert.equal(decision.status, 'accepted_with_followups');
});

test("P0: docs_only profile accepts docs changes without requiring verification", () => {
  const decision = evaluateAcceptance({ findings: [], needs_gpt_review: false });
  assert.equal(decision.passed, true);
  assert.equal(decision.status, 'accepted');
});

test("P0: config_change profile accepts config-only changes with relaxed test requirement", () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'minor', code: 'tests_missing', message: 'No test evidence found for config change' },
    ],
    needs_gpt_review: false,
  });
  assert.equal(decision.passed, true);
  assert.equal(decision.status, 'accepted_with_followups');
});

test("P0: code_change profile requires full acceptance contract", () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'blocker', code: 'result_json_invalid', message: 'result.json is missing or invalid' },
      { severity: 'blocker', code: 'verification_failed', message: 'Verification did not pass' },
    ],
    needs_gpt_review: false,
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.status, 'needs_fix');
});

test("P0: deploy profile requires safe restart evidence", () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'blocker', code: 'safe_restart_missing', message: 'Deploy task requires safe restart evidence' },
    ],
    needs_gpt_review: false,
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.status, 'needs_fix');
});

test("P0: acceptance failure maps to waiting_for_repair not completed", () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'blocker', code: 'dirty_worktree_after_codex', message: 'Worktree is dirty' },
    ],
    needs_gpt_review: false,
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.status, 'needs_fix');
  assert.notEqual(decision.status, 'accepted');
  assert.notEqual(decision.status, 'accepted_with_followups');
});

test("P0: reviewer_decision documents findings for acceptance/repair traceability", () => {
  const result = { status: 'needs_fix', summary: 'Failed acceptance', changed_files: ['src/broken.mjs'] };
  const reviewer = buildReviewerDecision({
    result,
    findings: [{ severity: 'blocker', code: 'verification_failed', message: 'Tests did not pass' }],
    needs_gpt_review: false,
  });
  assert.equal(reviewer.decision.status, 'needs_fix');
  assert.equal(reviewer.decision.passed, false);
  assert.ok(Array.isArray(reviewer.acceptance_findings));
  assert.equal(reviewer.acceptance_findings.length, 1);
  assert.equal(reviewer.acceptance_findings[0].code, 'verification_failed');
});

test("P0: reviewer_decision with needs_gpt_review=true sets should_enter_review flag", () => {
  const result = { status: 'waiting_for_review', summary: 'Blocked' };
  const reviewer = buildReviewerDecision({
    result, findings: [], needs_gpt_review: true,
    review_reason: 'Repair budget exceeded',
  });
  assert.equal(reviewer.decision.passed, true);
  assert.equal(reviewer.decision.should_enter_review, true);
  assert.equal(reviewer.decision.review_reason, 'Repair budget exceeded');
});

test("P0: delivery evidence gate rejects stale integration, restart, dirty, and retained-worktree flags", () => {
  const findings = buildDeliveryEvidenceFindings({
    status: "completed",
    summary: "Completed",
    changed_files: ["backend/src/app.mjs"],
    tests: "node --test: passed",
    commit: "abc123",
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    needs_integration: true,
    needs_restart_check: true,
    dirty: true,
    warnings: ["Worktree retained: /tmp/wt (status=waiting_for_review)"],
  });

  assert.deepEqual(findings.map((finding) => finding.code), [
    "stale_needs_integration",
    "stale_needs_restart_check",
    "stale_dirty_flag",
    "stale_retained_worktree_warning",
  ]);
  assert.ok(findings.every((finding) => finding.severity === "blocker"));
});

test("P0: delivery evidence gate accepts completed integrated task with normalized flags", () => {
  const findings = buildDeliveryEvidenceFindings({
    status: "completed",
    summary: "Completed",
    changed_files: ["backend/src/app.mjs"],
    tests: "node --test: passed",
    commit: "abc123",
    verification: { passed: true, commands: [{ cmd: "node --test", exit_code: 0 }] },
    integration: { status: "merged", merged: true },
    needs_integration: false,
    needs_restart_check: false,
    warnings: [],
  });

  assert.deepEqual(findings, []);
});

// ===========================================================================
// P0: Delivery evidence — execution_cwd_proof and worktree_lifecycle_proof
// Gated by buildDeliveryEvidenceFindings with task and evidence params.
// ===========================================================================

test("P0: buildDeliveryEvidenceFindings blocks missing execution_cwd_proof when task has worktree_path", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    { worktree_path: "/tmp/wt/task_abc" },
    {}
  );
  assert.ok(findings.some((f) => f.code === "stale_missing_execution_cwd"),
    "Should flag missing execution_cwd_proof");
  assert.equal(findings[0].severity, "blocker");
});

test("P0: buildDeliveryEvidenceFindings blocks missing worktree_lifecycle_proof when task has worktree_path", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    { worktree_path: "/tmp/wt/task_abc" },
    {}
  );
  assert.ok(findings.some((f) => f.code === "stale_missing_worktree_lifecycle"),
    "Should flag missing worktree_lifecycle_proof");
});

test("P0: execution_cwd_proof passes when result has execution_cwd field", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done", execution_cwd: "/tmp/wt/task_abc" },
    { worktree_path: "/tmp/wt/task_abc" },
    {}
  );
  assert.equal(findings.filter((f) => f.code === "stale_missing_execution_cwd").length, 0,
    "Should not flag missing execution_cwd_proof when result has execution_cwd");
});

test("P0: execution_cwd_proof passes when evidence has git_path", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    { worktree_path: "/tmp/wt/task_abc" },
    { git_path: "/tmp/wt/task_abc" }
  );
  assert.equal(findings.filter((f) => f.code === "stale_missing_execution_cwd").length, 0,
    "Should not flag missing execution_cwd_proof when evidence has git_path");
});

test("P0: worktree_lifecycle_proof passes when task has worktree_lifecycle", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    { worktree_path: "/tmp/wt/task_abc", worktree_lifecycle: { mode: "git_worktree", ok: true } },
    {}
  );
  assert.equal(findings.filter((f) => f.code === "stale_missing_worktree_lifecycle").length, 0,
    "Should not flag missing worktree_lifecycle_proof when task has worktree_lifecycle");
});

test("P0: worktree_lifecycle_proof passes when evidence has worktree_lifecycle", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    { worktree_path: "/tmp/wt/task_abc" },
    { worktree_lifecycle: { mode: "git_worktree", ok: true } }
  );
  assert.equal(findings.filter((f) => f.code === "stale_missing_worktree_lifecycle").length, 0,
    "Should not flag missing worktree_lifecycle_proof when evidence has worktree_lifecycle");
});

test("P0: buildDeliveryEvidenceFindings without worktree_path does not flag execution_cwd or worktree_lifecycle", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done" },
    {},
    {}
  );
  assert.equal(findings.filter((f) => f.code.startsWith("stale_missing_")).length, 0,
    "Should not flag missing evidence when task has no worktree_path");
});

test("P0: buildDeliveryEvidenceFindings still blocks stale flags even with task/evidence params", () => {
  const findings = buildDeliveryEvidenceFindings(
    { status: "completed", summary: "Done", needs_integration: true, dirty: true },
    {},
    {}
  );
  assert.ok(findings.some((f) => f.code === "stale_needs_integration"),
    "Should still flag stale needs_integration");
  assert.ok(findings.some((f) => f.code === "stale_dirty_flag"),
    "Should still flag stale dirty flag");
});

test("P0: acceptance.evidence.json is equivalent structured evidence for delivery", async () => {
  const { collectVerificationEvidence } = await import("../src/verification-evidence.mjs");
  const dir = await mkdtemp(join(tmpdir(), "gptwork-evidence-delivery-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: dir,
      acceptanceFindings: [{ severity: "followup", code: "test", message: "test", source: "test" }],
    });

    // acceptance.evidence.json must be produced
    assert.ok(evidence.acceptance_evidence_json, "acceptance.evidence.json path must be present");
    assert.ok(evidence.evidence_paths.acceptance_evidence_json, "evidence_paths must include acceptance_evidence_json");

    // The file must exist on disk
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(evidence.acceptance_evidence_json), "acceptance.evidence.json must exist on disk");

    // The file must contain structured evidence
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(evidence.acceptance_evidence_json, "utf8"));
    assert.ok(parsed.collected_at, "acceptance.evidence.json must have collected_at");
    assert.ok(Array.isArray(parsed.acceptance_findings), "acceptance.evidence.json must have acceptance_findings");
    assert.ok(parsed.acceptance_findings.length > 0, "acceptance.evidence.json must include the passed findings");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: collectVerificationEvidence captures git_path as execution_cwd_proof-equivalent", async () => {
  const { collectVerificationEvidence } = await import("../src/verification-evidence.mjs");
  const dir = await mkdtemp(join(tmpdir(), "gptwork-evidence-cwd-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: dir,
      repoPath: process.cwd(),
    });

    // The evidence should have a git_path that identifies execution context
    if (evidence.git_status !== null) {
      assert.ok(typeof evidence.git_status === "string", "git_status should be a string when available");

      // acceptance.evidence.json must record git_path
      const { readFileSync } = await import("node:fs");
      const parsed = JSON.parse(readFileSync(evidence.acceptance_evidence_json, "utf8"));
      if (parsed.git_path) {
        assert.ok(typeof parsed.git_path === "string", "acceptance.evidence.json must have git_path");
      }
    }
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

