/**
 * p0-readiness-smoke.mjs — P0 Readiness Smoke Test (test runner compatible)
 *
 * Verifies that all 10 P0 areas from the GPTWork delivery pipeline are
 * functional.  This smoke test is designed to run from the worktree root
 * (backend/) with: node --test test/p0-readiness-smoke.mjs
 */
import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(TEST_DIR, "../..");

// Helper: run git from repo root
function git(args) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

test("P0-1: task lifecycle functions", async (t) => {
  const { deriveTaskStatusFromTaskResult, validateResultContract, isP0TaskTitle, DIAGNOSIS_CODES } = await import("../src/task-result-status.mjs");
  assert.equal(deriveTaskStatusFromTaskResult({ kind: "codex_executed" }), "completed");
  assert.equal(deriveTaskStatusFromTaskResult({ kind: "noop" }), "completed");
  assert.equal(deriveTaskStatusFromTaskResult({ kind: "codex_timeout" }), "timed_out");
  const good = validateResultContract({ status: "completed", tests: "pass", changed_files: [], summary: "done" }, { skipWorktreeCheck: true });
  assert.equal(good.valid, true);
  assert.equal(isP0TaskTitle("P0: fix"), true);
  assert.equal(isP0TaskTitle("P1: fix"), false);
});

test("P0-2: resolveRepoDir handles worktrees", async (t) => {
  // resolveRepoDir is the original name; diagnostics-service re-exports as "n"
  const { resolveRepoDir } = await import("../src/diagnostics-runtime.mjs");
  const dir = resolveRepoDir();
  assert.ok(dir, "resolveRepoDir should return a path in the current git worktree");
});

test("P0-2: sanitizeTaskBranchName works", async (t) => {
  const { sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
  assert.ok(sanitizeTaskBranchName("task_abc-123"));
});

test("P0-3: acceptance agent exports", async (t) => {
  const { hasCodeOrConfigOrRuntimeChanges, ACCEPTANCE_PROFILES } = await import("../src/acceptance-agent.mjs");
  assert.equal(typeof hasCodeOrConfigOrRuntimeChanges, "function");
  assert.ok(ACCEPTANCE_PROFILES.DOCS_ONLY);
});

test("P0-4: buildEvidence works", async (t) => {
  const { buildEvidence } = await import("../src/acceptance-agent.mjs");
  const evidence = await buildEvidence({ repoPath: REPO_ROOT });
  assert.ok(evidence.git_status);
  assert.ok(Array.isArray(evidence.changed_files));
});

test("P0-4: runAcceptanceAgent returns reviewerDecision", async (t) => {
  const mod = await import("../src/acceptance-agent.mjs");
  const result = await mod.runAcceptanceAgent({
    task: { id: "t1" },
    result: { status: "completed", summary: "T", changed_files: ["src/a.mjs"], verification: { commands: [], passed: true } },
    repoPath: REPO_ROOT,
    evidence: { result_json_valid: true, result_summary: "T", changed_files: [], git_status: "clean", verification_log_exists: true, commit_exists: false },
  });
  assert.equal(result.passed, true);
  assert.equal(typeof result.reviewer_decision, "object");
});

test("P0-5: DIAGNOSIS_CODES defined", async (t) => {
  const { DIAGNOSIS_CODES } = await import("../src/task-result-status.mjs");
  assert.ok(DIAGNOSIS_CODES.TESTS_MISSING);
  assert.ok(DIAGNOSIS_CODES.COMMIT_MISSING);
});

test("P0-5: recovery_diagnose handles 429", (t) => {
  const source = readFileSync("./src/tool-groups/recovery-tools-group.mjs", "utf8");
  assert.ok(source.includes("last_status === 429"));
});

test("P0-5: recovery runtime_status probes bounded JSON health endpoint", (t) => {
  const source = readFileSync("./src/tool-groups/recovery-tools-group.mjs", "utf8");
  assert.match(source, /runtime_status:[\s\S]*curl[\s\S]*--connect-timeout\s+2/);
  assert.match(source, /runtime_status:[\s\S]*curl[\s\S]*--max-time\s+5/);
  assert.match(source, /runtime_status:[\s\S]*http:\/\/localhost:\$\{process\.env\.GPTWORK_PORT\|\|8787\}\/health/);
  assert.doesNotMatch(source, /runtime_status:[\s\S]*\/mcp\/health/);
});

test("P0-6: repair metadata in processor", (t) => {
  const source = readFileSync("./src/task-processing/task-repair-context.mjs", "utf8");
  assert.ok(source.includes("repair_attempt"));
  assert.ok(source.includes("repair_of_goal_id"));
  assert.ok(source.includes("repair_of_worktree"));
});

test("P0-6: repair-loop.mjs exists", (t) => {
  readFileSync("./src/repair-loop.mjs");
});

test("P0-7: collectVerificationEvidence produces paths", async (t) => {
  const { collectVerificationEvidence } = await import("../src/verification-evidence.mjs");
  const evidence = await collectVerificationEvidence({ repoPath: REPO_ROOT });
  assert.ok(evidence.evidence_paths);
});

test("P0-7: quickGitStatus returns boolean", async (t) => {
  const { quickGitStatus } = await import("../src/verification-evidence.mjs");
  const status = quickGitStatus(REPO_ROOT);
  assert.equal(typeof status.isClean, "boolean");
});

test("P0-8: integration queue exports", async (t) => {
  const mod = await import("../src/integration-queue.mjs");
  assert.equal(typeof mod.runIntegrationQueue, "function");
});

test("P0-9: runtime_status fields exist", (t) => {
  const source = readFileSync("./src/tool-groups/runtime-status-tools-group.mjs", "utf8");
  assert.ok(source.includes("running_commit"));
  assert.ok(source.includes("repo_head"));
});

test("P0-10: applyRuntimeCodeChangeGuard non-deploy skips", async (t) => {
  const { applyRuntimeCodeChangeGuard } = await import("../src/task-result-status.mjs");
  const s = await applyRuntimeCodeChangeGuard({ taskStatus: "completed", taskResult: {}, mode: "builder", parsedResult: { changed_files: ["src/a.mjs"] }, isP0Task: false });
  assert.equal(s, "completed");
});

test("P0-10: verifyToolExposure works", async (t) => {
  const { verifyToolExposure } = await import("../src/task-result-status.mjs");
  assert.equal(verifyToolExposure(["a"], ["a","b"]).allPresent, false);
  assert.equal(verifyToolExposure(["a","b"], ["a","b"]).allPresent, true);
});

test("P0-10: safe-restart exports", async (t) => {
  const mod = await import("../src/safe-restart.mjs");
  assert.equal(typeof mod.scanPendingRestartMarkers, "function");
  assert.equal(typeof mod.writePendingRestartMarker, "function");
});

test("worktree: HEAD commit matches git rev-parse HEAD", (t) => {
  const head = git("rev-parse HEAD");
  assert.ok(/^[0-9a-f]{40}$/.test(head), "HEAD must be a full SHA");
});

test("worktree: repo_root ends with canonical repo name", (t) => {
  const topLevel = git("rev-parse --show-toplevel");
  assert.ok(topLevel.includes("gpt-codex-workspace"), `repo root should include canonical name, got: ${topLevel}`);
});

test("tmpdir: gptwork temp dirs not over-accumulated and tmpdir writable", async (t) => {
  const { readdirSync, statSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tmp = tmpdir();

  // 1. Check writability by creating and removing a test dir
  const probe = mkdtempSync(join(tmp, "gptwork-p0-check-"));
  assert.ok(probe.startsWith(tmp), "gptwork test temp dir should be under tmpdir");
  rmSync(probe, { recursive: true, force: true });

  // 2. Scan for existing gptwork temp dirs
  let entries;
  try {
    entries = readdirSync(tmp);
  } catch {
    console.warn("[tmp-inode] cannot read tmpdir, skipping accumulation check");
    return;
  }

  const gptworkDirs = entries.filter((e) => e.startsWith("gptwork-"));
  const total = gptworkDirs.length;

  // Warning threshold: > 500 suggests moderate buildup
  if (total > 500) {
    console.warn(`[tmp-inode] high gptwork temp dir count: ${total} (threshold: 500, max: 5000)`);
  }

  // Fail threshold: > 500 suggests problematic accumulation that could affect /tmp inode usage
  assert.ok(total <= 5000, `gptwork temp dirs in tmpdir: ${total} (max allowed: 5000)`);

  // 3. Check for stale dirs (> 7 days old)
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
  let staleCount = 0;
  for (const name of gptworkDirs) {
    try {
      const st = statSync(join(tmp, name));
      if (now - st.mtimeMs > maxAge) {
        staleCount++;
      }
    } catch {
      // skip entries we cannot stat (e.g., removed by another process)
    }
  }
  if (staleCount > 0) {
    console.warn(`[tmp-inode] found ${staleCount} gptwork temp dir(s) older than 7 days in ${tmp}`);
  }
});
