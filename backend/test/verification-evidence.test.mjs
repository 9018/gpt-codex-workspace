/**
 * verification-evidence.test.mjs
 *
 * Tests that collectVerificationEvidence collects git status, diff stat,
 * changed files, result json, patch evidence, and saves evidence files.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectVerificationEvidence, quickGitStatus } from "../src/verification-evidence.mjs";

test("collectVerificationEvidence returns evidence object with default fields", async () => {
  const evidence = await collectVerificationEvidence({});

  assert.ok(evidence, "should return an evidence object");
  assert.ok(typeof evidence.implementation_diff_patch === "string" || evidence.implementation_diff_patch === null);
  assert.ok(typeof evidence.verification_log === "string" || evidence.verification_log === null);
  assert.ok(typeof evidence.acceptance_evidence_json === "string" || evidence.acceptance_evidence_json === null);
  assert.ok(typeof evidence.evidence_paths === "object");
  assert.ok(Array.isArray(evidence.changed_files));
});

test("collectVerificationEvidence with outputDir saves evidence files", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: tmpDir,
    });

    // Check that verification.log was created
    assert.ok(existsSync(join(tmpDir, "verification.log")), "verification.log should exist");
    assert.ok(existsSync(join(tmpDir, "acceptance.evidence.json")), "acceptance.evidence.json should exist");
    assert.ok(existsSync(join(tmpDir, "events.jsonl")), "events.jsonl should exist");

    // Check evidence_paths
    assert.ok(evidence.evidence_paths.verification_log, "should have verification_log path");
    assert.ok(evidence.evidence_paths.acceptance_evidence_json, "should have acceptance_evidence_json path");
    assert.ok(evidence.evidence_paths.events_jsonl, "should have events_jsonl path");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectVerificationEvidence writes run events that point to artifacts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-events-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: tmpDir,
      acceptanceFindings: [{ severity: "followup", code: "docs", message: "Document evidence" }],
    });

    const eventsPath = join(tmpDir, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.ok(events.length >= 6, "critical evidence steps should be logged");
    assert.deepEqual(events.map((event) => event.type), [
      "run_evidence.workflow",
      "run_evidence.context",
      "run_evidence.verification_log",
      "run_evidence.acceptance_evidence",
      "run_evidence.queue",
      "run_evidence.card",
    ]);
    assert.equal(events[2].artifact.path, evidence.evidence_paths.verification_log);
    assert.equal(events[3].artifact.path, evidence.evidence_paths.acceptance_evidence_json);
    assert.equal(events[5].artifact.path, evidence.evidence_paths.events_jsonl);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectVerificationEvidence with resultJsonPath reads and parses result.json", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-rj-"));
  try {
    const resultJsonPath = join(tmpDir, "result.json");
    const resultData = {
      status: "completed",
      summary: "Test result",
      changed_files: ["src/foo.js"],
      tests: "npm test: passed",
      commit: "abc123",
    };
    writeFileSync(resultJsonPath, JSON.stringify(resultData, null, 2), "utf8");

    const evidence = await collectVerificationEvidence({
      outputDir: tmpDir,
      resultJsonPath,
    });

    assert.ok(evidence.result_json, "should have parsed result_json");
    assert.equal(evidence.result_json.status, "completed");
    assert.deepEqual(evidence.result_json.changed_files, ["src/foo.js"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectVerificationEvidence with acceptanceFindings includes them in acceptance.evidence.json", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-af-"));
  try {
    const findings = [
      { severity: "major", code: "test_finding", message: "Test finding", source: "test" },
    ];

    await collectVerificationEvidence({
      outputDir: tmpDir,
      acceptanceFindings: findings,
    });

    const evidenceJsonPath = join(tmpDir, "acceptance.evidence.json");
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(evidenceJsonPath, "utf8"));
    assert.equal(content.acceptance_findings.length, 1);
    assert.equal(content.acceptance_findings[0].code, "test_finding");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectVerificationEvidence saves implementation-diff.patch when git diff available", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-diff-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: tmpDir,
      repoPath: process.cwd(),
    });

    // If we're in a git repo, there might be a diff
    if (evidence.implementation_diff_patch) {
      assert.ok(existsSync(join(tmpDir, "implementation-diff.patch")), "implementation-diff.patch should exist");
      assert.ok(evidence.evidence_paths.implementation_diff_patch, "should have patch path");
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("quickGitStatus returns clean for valid git path", () => {
  const status = quickGitStatus(process.cwd());
  assert.ok(typeof status.isClean === "boolean");
  assert.ok(Array.isArray(status.dirtyFiles));
});

test("quickGitStatus handles null path gracefully", () => {
  const status = quickGitStatus(null);
  assert.equal(status.isClean, true);
});

test("collectVerificationEvidence collects git status and diff stat from repo", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gptwork-evidence-git-"));
  try {
    const evidence = await collectVerificationEvidence({
      outputDir: tmpDir,
      repoPath: process.cwd(),
    });

    // git_status may be null if no changes, but shouldn't throw
    if (evidence.git_status !== null) {
      assert.ok(typeof evidence.git_status === "string");
    }
    if (evidence.diff_stat !== null) {
      assert.ok(typeof evidence.diff_stat === "string");
    }
    assert.ok(Array.isArray(evidence.changed_files));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log("verification-evidence.test.mjs loaded");
