/**
 * context-contract-diagnostics.test.mjs — P0-C9 Context Contract Stress Tests.
 *
 * Required coverage:
 * - normal code-change task context availability;
 * - readonly/no-op task context availability;
 * - repair task inherits root failure evidence/context pointers;
 * - fallback path when retrieval/index is unavailable;
 * - compact review bundle path does not require full transcript.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runContextContractDiagnostics,
  checkEntryContext,
  checkContextFiles,
  checkTranscript,
  checkRetrievalFallback,
  checkRepairContextInheritance,
  checkCompactReviewBundle,
  checkHelperTools,
  checkContextIndex,
} from "../src/context-contract-diagnostics.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withGoalDir(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "ctx-contract-test-"));
  const goalDir = join(tmp, ".gptwork", "goals", "goal_test");
  mkdirSync(goalDir, { recursive: true });
  try {
    return fn(goalDir, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeFileInDir(dir, filename, content) {
  writeFileSync(join(dir, filename), content, "utf8");
}

function fakeGoal(overrides = {}) {
  return {
    id: "goal_test",
    title: "Test Goal",
    user_request: "Implement feature X",
    goal_prompt: "A test goal for context contract validation",
    workspace_id: "ws-test",
    project_id: "proj-test",
    ...overrides,
  };
}

function fakeTask(overrides = {}) {
  return {
    id: "task_test",
    status: "completed",
    title: "Test Task",
    goal_id: "goal_test",
    workspace_id: "ws-test",
    changed_files: ["src/feature.mjs"],
    result: {
      status: "completed",
      summary: "Implemented feature X",
      verification: { passed: true, commands: [] },
    },
    ...overrides,
  };
}

// ===========================================================================
// Individual check function tests
// ===========================================================================

describe("checkEntryContext", () => {
  it("returns ok when codex.entry.md exists", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "codex.entry.md", "# Entry\n\nTest entry");
      const result = checkEntryContext(goalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].file, "codex.entry.md");
      assert.equal(result[0].exists, true);
      assert.equal(result[0].status, "ok");
    });
  });

  it("returns missing when codex.entry.md does not exist", () => {
    withGoalDir((goalDir) => {
      const result = checkEntryContext(goalDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].file, "codex.entry.md");
      assert.equal(result[0].exists, false);
      assert.equal(result[0].status, "missing");
    });
  });

  it("returns missing when goalDir is null", () => {
    const result = checkEntryContext(null);
    assert.equal(result[0].exists, false);
    assert.equal(result[0].status, "missing");
  });
});

describe("checkContextFiles", () => {
  it("returns ok when all context files exist and are valid", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "context.bundle.md", "# Bundle\n\nContext bundle content");
      writeFileInDir(goalDir, "context.retrieval.json", JSON.stringify({ chunks: [], retrieval_mode: "auto" }));
      writeFileInDir(goalDir, "context.json", JSON.stringify({ memories: [], conversations: [] }));

      const result = checkContextFiles(goalDir);
      assert.equal(result.length, 3);
      for (const c of result) {
        assert.equal(c.exists, true, `${c.file} should exist`);
        assert.equal(c.status, "ok", `${c.file} should be ok`);
      }
    });
  });

  it("returns missing for absent context files", () => {
    withGoalDir((goalDir) => {
      const result = checkContextFiles(goalDir);
      for (const c of result) {
        assert.equal(c.exists, false, `${c.file} should be missing`);
        assert.equal(c.status, "missing");
      }
    });
  });

  it("detects invalid JSON in context files", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "context.retrieval.json", "not valid json");
      writeFileInDir(goalDir, "context.json", "{ broken json }");

      const result = checkContextFiles(goalDir);
      const retrievalCheck = result.find((c) => c.file === "context.retrieval.json");
      const contextCheck = result.find((c) => c.file === "context.json");

      assert.equal(retrievalCheck.exists, true);
      assert.equal(retrievalCheck.valid, false);
      assert.equal(retrievalCheck.status, "invalid");

      assert.equal(contextCheck.exists, true);
      assert.equal(contextCheck.valid, false);
      assert.equal(contextCheck.status, "invalid");
    });
  });

  it("returns missing when goalDir is null", () => {
    const result = checkContextFiles(null);
    for (const c of result) {
      assert.equal(c.exists, false);
      assert.equal(c.status, "missing");
    }
  });
});

describe("checkTranscript", () => {
  it("detects huge transcript risk", () => {
    withGoalDir((goalDir) => {
      // Write transcript > 100KB with enough messages
      const bigContent = "## message\n\n" + "# ".repeat(200) + "\n\ncontent\n";
      const padded = bigContent.padEnd(110 * 1024, "x\n");
      writeFileInDir(goalDir, "transcript.md", padded);

      const result = checkTranscript(goalDir);
      assert.equal(result.exists, true);
      assert.ok(result.size > 100 * 1024, `expected size > 100KB, got ${result.size}`);
      assert.equal(result.huge_risk, true);
    });
  });

  it("reports no risk for small transcript", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "transcript.md", "## message 1\n\nContent\n## message 2\n\nMore content");

      const result = checkTranscript(goalDir);
      assert.equal(result.exists, true);
      assert.equal(result.huge_risk, false);
    });
  });

  it("handles missing transcript gracefully", () => {
    withGoalDir((goalDir) => {
      const result = checkTranscript(goalDir);
      assert.equal(result.exists, false);
      assert.equal(result.huge_risk, false);
    });
  });

  it("handles null goalDir gracefully", () => {
    const result = checkTranscript(null);
    assert.equal(result.exists, false);
    assert.equal(result.huge_risk, false);
  });
});

describe("checkRetrievalFallback", () => {
  it("reports retrieval available when context.retrieval.json has chunks", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "context.retrieval.json", JSON.stringify({
        chunks: [{ id: "c1", text: "test", score: 0.9 }],
        retrieval_mode: "auto",
      }));

      const result = checkRetrievalFallback(goalDir, fakeTask());
      assert.equal(result.retrieval_available, true);
      assert.equal(result.retrieval_chunk_count, 1);
      assert.equal(result.status, "ok");
    });
  });

  it("falls back to durable sources when retrieval is unavailable", () => {
    withGoalDir((goalDir) => {
      // Write some durable files but no retrieval
      writeFileInDir(goalDir, "goal.md", "# Goal\n\nTest goal");
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "completed" }));

      const result = checkRetrievalFallback(goalDir, fakeTask());
      assert.equal(result.retrieval_available, false);
      assert.equal(result.retrieval_chunk_count, 0);
      assert.equal(result.has_durable_fallback, true);
      assert.ok(result.fallback_sources.length >= 2, "should have at least 2 fallback sources");
      assert.ok(result.fallback_sources.includes("goal.md"), "should include goal.md");
      assert.ok(result.fallback_sources.includes("result.json"), "should include result.json");
      assert.equal(result.status, "fallback");
    });
  });

  it("reports degraded when no retrieval and no durable fallback", () => {
    withGoalDir((goalDir) => {
      // No files at all
      const result = checkRetrievalFallback(goalDir, null);
      assert.equal(result.retrieval_available, false);
      assert.equal(result.has_durable_fallback, false);
      assert.equal(result.fallback_sources.length, 0);
      // task_fields contributes when task is not null, but here task is null
      assert.equal(result.status, "degraded");
    });
  });

  it("includes task_fields as fallback when task is provided", () => {
    withGoalDir((goalDir) => {
      const result = checkRetrievalFallback(goalDir, fakeTask());
      assert.equal(result.has_durable_fallback, true);
      assert.ok(result.fallback_sources.includes("task_fields"));
    });
  });
});

describe("checkRepairContextInheritance", () => {
  it("detects repair task and checks parent evidence", () => {
    withGoalDir((parentGoalDir) => {
      // Parent has result evidence
      writeFileInDir(parentGoalDir, "result.json", JSON.stringify({ status: "failed" }));
      writeFileInDir(parentGoalDir, "result.md", "# Failed\n\nTask failed with error");

      const repairTask = fakeTask({ title: "Repair: fix context contract" });
      const repairGoal = fakeGoal({ title: "P0-C9 Repair: Context Contract" });

      const result = checkRepairContextInheritance(repairTask, repairGoal, null, parentGoalDir);
      assert.equal(result.is_repair_task, true);
      assert.equal(result.parent_result_json, true);
      assert.equal(result.parent_result_md, true);
      assert.equal(result.assessment, "inherited");
    });
  });

  it("returns missing_parent_evidence when parent has no result", () => {
    withGoalDir((parentGoalDir) => {
      const repairTask = fakeTask({ title: "Repair something" });
      const repairGoal = fakeGoal({ title: "Repair goal" });

      const result = checkRepairContextInheritance(repairTask, repairGoal, null, parentGoalDir);
      assert.equal(result.is_repair_task, true);
      assert.equal(result.parent_result_json, false);
      assert.equal(result.parent_result_md, false);
      assert.equal(result.assessment, "missing_parent_evidence");
    });
  });

  it("returns not_applicable for non-repair tasks", () => {
    const normalTask = fakeTask({ title: "Implement feature" });
    const normalGoal = fakeGoal({ title: "Feature Goal" });

    const result = checkRepairContextInheritance(normalTask, normalGoal, null, null);
    assert.equal(result.is_repair_task, false);
    assert.equal(result.assessment, "not_applicable");
  });
});

describe("checkCompactReviewBundle", () => {
  it("is viable when result.json and changed_files exist", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "completed", summary: "done" }));

      const task = fakeTask({
        changed_files: ["src/feature.mjs"],
        result: { status: "completed", summary: "done", verification: { passed: true } },
      });

      const result = checkCompactReviewBundle(task, goalDir);
      assert.equal(result.result_json_exists, true);
      assert.equal(result.changed_files_available, true);
      assert.equal(result.verification_available, true);
      assert.equal(result.viable_without_full_transcript, true);
      assert.equal(result.assessment, "ok");
    });
  });

  it("is viable with only result.md if changed_files available", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "result.md", "# Result\n\nFeature completed");

      const task = fakeTask({
        changed_files: ["src/feature.mjs"],
        result: { status: "completed", summary: "done" },
      });

      // No result.json, but result.md exists
      const result = checkCompactReviewBundle(task, goalDir);
      assert.equal(result.result_json_exists, false);
      assert.equal(result.result_md_exists, true);
      assert.equal(result.changed_files_available, true);
      assert.equal(result.viable_without_full_transcript, true);
    });
  });

  it("needs transcript fallback when no result evidence", () => {
    withGoalDir((goalDir) => {
      const task = fakeTask({ changed_files: [], result: null });
      const result = checkCompactReviewBundle(task, goalDir);
      assert.equal(result.viable_without_full_transcript, false);
      assert.equal(result.assessment, "needs_transcript_fallback");
    });
  });

  it("needs transcript fallback when no changed_files and no verification", () => {
    withGoalDir((goalDir) => {
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "failed" }));

      const task = fakeTask({
        changed_files: [],
        result: { status: "failed", summary: "failed" },
      });

      const result = checkCompactReviewBundle(task, goalDir);
      assert.equal(result.result_json_exists, true);
      assert.equal(result.changed_files_available, false);
      assert.equal(result.verification_available, false);
      assert.equal(result.viable_without_full_transcript, false);
    });
  });
});

describe("checkHelperTools", () => {
  it("returns config_based status for @zvec/zvec", () => {
    const result = checkHelperTools({ contextVectorStore: "auto" });
    assert.equal(result.length, 1);
    assert.equal(result[0].tool, "@zvec/zvec");
    assert.equal(result[0].configured, true);
    assert.equal(result[0].status, "config_based");
  });

  it("reports not configured when vector store is local", () => {
    const result = checkHelperTools({ contextVectorStore: "local" });
    assert.equal(result[0].configured, false);
  });
});

describe("checkContextIndex", () => {
  it("returns ok when no warnings", () => {
    const result = checkContextIndex({
      configured_store: "auto",
      effective_store: "local-json-store",
      zvec_optional_dependency: "unavailable",
    });
    assert.equal(result.status, "ok");
  });

  it("returns degraded when effective is unknown and zvec unavailable", () => {
    const result = checkContextIndex({
      configured_store: "zvec",
      effective_store: "unknown",
      zvec_optional_dependency: "unavailable",
    });
    assert.equal(result.status, "degraded");
    assert.ok(result.warnings.length > 0);
  });

  it("returns not_checked for empty input", () => {
    const result = checkContextIndex({});
    assert.equal(result.status, "not_checked");
  });
});

// ===========================================================================
// Integration: runContextContractDiagnostics
// ===========================================================================

describe("runContextContractDiagnostics — integration", () => {
  it("normal code-change task: all checks pass", async () => {
    await withGoalDir(async (goalDir) => {
      // Set up a realistic goal workspace with all required files
      writeFileInDir(goalDir, "codex.entry.md", "# Entry\n\nTask context");
      writeFileInDir(goalDir, "context.bundle.md", "# Bundle\n\nContext bundle content");
      writeFileInDir(goalDir, "context.retrieval.json", JSON.stringify({
        chunks: [{ id: "c1", text: "relevant chunk", score: 0.9 }],
        retrieval_mode: "auto",
      }));
      writeFileInDir(goalDir, "context.json", JSON.stringify({ memories: [] }));
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "completed" }));
      writeFileInDir(goalDir, "transcript.md", "## msg 1\n\nContent");

      const result = await runContextContractDiagnostics({
        task: fakeTask(),
        goal: fakeGoal(),
        config: { contextVectorStore: "auto" },
        goalDir,
        workspaceRoot: "/tmp",
        contextIndexStatus: {
          configured_store: "auto",
          effective_store: "local-json-store",
          zvec_optional_dependency: "unavailable",
        },
      });

      // Should not be degraded or warnings-only
      assert.equal(result.status, "ok", `expected ok, got ${result.status}: ${JSON.stringify(result.warnings)}`);
      assert.equal(result.checks.entry_context[0].status, "ok");
      assert.ok(result.checks.context_files.every((c) => c.status === "ok"));
      assert.equal(result.checks.transcript.huge_risk, false);
      assert.equal(result.checks.retrieval_fallback.status, "ok");
      assert.equal(result.checks.repair_context_inheritance.assessment, "not_applicable");
      assert.equal(result.checks.compact_review_bundle.assessment, "ok");
    });
  });

  it("readonly/no-op task: still has entry context but no changed files", async () => {
    await withGoalDir(async (goalDir) => {
      writeFileInDir(goalDir, "codex.entry.md", "# Entry\n\nReadonly task");
      writeFileInDir(goalDir, "context.bundle.md", "# Bundle\n\nBundle content");
      writeFileInDir(goalDir, "context.json", JSON.stringify({ memories: [] }));
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "failed" }));

      const result = await runContextContractDiagnostics({
        task: fakeTask({
          changed_files: [],           // no-op: no changed files
          result: { status: "failed" }, // no verification
        }),
        goal: fakeGoal(),
        config: {},
        goalDir,
        workspaceRoot: "/tmp",
        contextIndexStatus: {
          configured_store: "auto",
          effective_store: "local-json-store",
          zvec_optional_dependency: "unavailable",
        },
      });

      // Entry context should still be available
      assert.equal(result.checks.entry_context[0].status, "ok");

      // Compact review bundle may not be viable without verification/changed_files
      // This is expected for failed/no-op tasks
      assert.equal(result.checks.compact_review_bundle.viable_without_full_transcript, false);

      // Should have a relevant warning
      const bundleWarning = result.warnings.find((w) => w.code === "compact_bundle_not_viable");
      assert.ok(bundleWarning, "should warn about compact bundle not being viable");
    });
  });

  it("repair task inherits root failure evidence", async () => {
    await withGoalDir(async (parentGoalDir) => {
      // Set up parent goal failure evidence
      writeFileInDir(parentGoalDir, "result.json", JSON.stringify({
        status: "failed",
        summary: "Original C9 task failed with codex_failed/result_missing",
      }));
      writeFileInDir(parentGoalDir, "result.md", "# Failed\n\nOriginal failure evidence");

      // Create a separate "repair" goal dir
      const repairGoalDir = mkdtempSync(join(tmpdir(), "ctx-repair-"));
      const repairDir = join(repairGoalDir, ".gptwork", "goals", "goal_repair");
      mkdirSync(repairDir, { recursive: true });
      try {
        writeFileInDir(repairDir, "codex.entry.md", "# Repair entry\n\nFixing context contract");

        const repairTask = fakeTask({
          id: "task_repair",
          title: "P0-C9 Repair: Context Contract Stress Test",
          goal_id: "goal_repair",
        });
        const repairGoal = fakeGoal({
          id: "goal_repair",
          title: "P0-C9 Repair: Context Contract Stress Test",
        });

        const result = await runContextContractDiagnostics({
          task: repairTask,
          goal: repairGoal,
          config: {},
          goalDir: repairDir,
          parentGoalDir,
          workspaceRoot: "/tmp",
          contextIndexStatus: {
            configured_store: "auto",
            effective_store: "local-json-store",
            zvec_optional_dependency: "unavailable",
          },
        });

        assert.equal(result.checks.repair_context_inheritance.is_repair_task, true);
        assert.equal(result.checks.repair_context_inheritance.parent_result_json, true);
        assert.equal(result.checks.repair_context_inheritance.parent_result_md, true);
        assert.equal(result.checks.repair_context_inheritance.assessment, "inherited");
      } finally {
        rmSync(repairGoalDir, { recursive: true, force: true });
      }
    });
  });

  it("fallback path when retrieval/index is unavailable", async () => {
    await withGoalDir(async (goalDir) => {
      // Only durable sources, no context.retrieval.json
      writeFileInDir(goalDir, "codex.entry.md", "# Entry");
      writeFileInDir(goalDir, "goal.md", "# Goal\n\nDurable goal context");
      writeFileInDir(goalDir, "result.json", JSON.stringify({ status: "completed" }));

      const result = await runContextContractDiagnostics({
        task: fakeTask(),
        goal: fakeGoal(),
        config: {},
        goalDir,
        workspaceRoot: "/tmp",
        contextIndexStatus: {
          configured_store: "auto",
          effective_store: "local-json-store",
          zvec_optional_dependency: "unavailable",
        },
      });

      // Retrieval should show fallback
      assert.equal(result.checks.retrieval_fallback.retrieval_available, false);
      assert.equal(result.checks.retrieval_fallback.status, "fallback");
      assert.ok(result.checks.retrieval_fallback.has_durable_fallback);
      assert.ok(result.fallback_sources.length > 0);

      // Warning should be info-level, not warning-level
      const fallbackWarning = result.warnings.find((w) => w.code === "retrieval_unavailable_fallback");
      assert.ok(fallbackWarning, "should report retrieval_unavailable_fallback");
      assert.equal(fallbackWarning.severity, "info");
    });
  });

  it("compact review bundle does not require full transcript", async () => {
    await withGoalDir(async (goalDir) => {
      // Set up result evidence without transcript
      writeFileInDir(goalDir, "result.json", JSON.stringify({
        status: "completed",
        summary: "Feature implemented",
      }));
      writeFileInDir(goalDir, "result.md", "# Result\n\nFeature completed successfully");

      const task = fakeTask({
        changed_files: ["src/feature.mjs", "test/feature.test.mjs"],
        result: {
          status: "completed",
          summary: "done",
          verification: { passed: true, commands: ["npm test"] },
        },
      });

      // Do NOT create transcript.md

      const result = await runContextContractDiagnostics({
        task,
        goal: fakeGoal(),
        config: {},
        goalDir,
        workspaceRoot: "/tmp",
        contextIndexStatus: {
          configured_store: "auto",
          effective_store: "local-json-store",
          zvec_optional_dependency: "unavailable",
        },
      });

      // Compact review bundle should be viable without transcript
      assert.equal(result.checks.compact_review_bundle.viable_without_full_transcript, true);
      assert.equal(result.checks.compact_review_bundle.assessment, "ok");
      assert.equal(result.checks.transcript.exists, false, "transcript should not exist");

      // Should not have transcript-related warnings
      const transcriptWarning = result.warnings.find((w) => w.code === "huge_transcript");
      assert.equal(transcriptWarning, undefined, "should not warn about transcript when it doesn't exist");
    });
  });
});
