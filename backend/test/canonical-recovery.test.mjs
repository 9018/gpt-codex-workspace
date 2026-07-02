import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEachHook, track } from "./helpers/temp-cleanup.mjs";

import {
  DIRTY_CLASSIFICATION,
  FF_ONLY_FAILURE_CLASSIFICATION,
  classifyDirtyPath,
  classifyCanonicalDirty,
  recoverCanonicalDirty,
  classifyFFOnlyFailure,
  recoverFFOnlyMerge,
} from "../src/canonical-recovery.mjs";

afterEachHook(test);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeRepo() {
  const root = track(await mkdtemp(join(tmpdir(), "canonical-recovery-")));
  const canonical = join(root, "repo");
  const worktree = join(root, "wt");
  git(root, ["init", "repo", "--initial-branch", "main"]);
  git(canonical, ["config", "user.email", "test@test"]);
  git(canonical, ["config", "user.name", "Test"]);
  await writeFile(join(canonical, "README.md"), "base\n", "utf8");
  git(canonical, ["add", "README.md"]);
  git(canonical, ["commit", "-m", "chore: initial"]);
  git(canonical, ["worktree", "add", "-b", "task/test", worktree, "main"]);
  git(worktree, ["config", "user.email", "test@test"]);
  git(worktree, ["config", "user.name", "Test"]);
  return { root, canonical, worktree };
}

// ---------------------------------------------------------------------------
// classifyDirtyPath unit tests
// ---------------------------------------------------------------------------

test("classifyDirtyPath identifies generated/temp files", () => {
  assert.equal(classifyDirtyPath("build/output.tmp"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath("debug.log"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath("node_modules/package/index.js"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath("dist/bundle.js"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath(".eslintcache"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath("__pycache__/module.pyc"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(classifyDirtyPath(".DS_Store"), DIRTY_CLASSIFICATION.GENERATED_TEMP);
});

test("classifyDirtyPath identifies expected integration artifacts", () => {
  assert.equal(classifyDirtyPath("result.json"), DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT);
  assert.equal(classifyDirtyPath("result.md"), DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT);
  assert.equal(classifyDirtyPath("verification.json"), DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT);
  assert.equal(classifyDirtyPath("backend/package-lock.json"), DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT);
});

test("classifyDirtyPath identifies unexpected source mutations", () => {
  assert.equal(classifyDirtyPath("src/main.js"), DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
  assert.equal(classifyDirtyPath("backend/src/app.mjs"), DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
  assert.equal(classifyDirtyPath("test/test.js"), DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
  assert.equal(classifyDirtyPath("lib/utils.py"), DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
  assert.equal(classifyDirtyPath("package.json"), DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
});

test("classifyDirtyPath returns unknown for non-matching paths", () => {
  assert.equal(classifyDirtyPath("random_file.xyz"), DIRTY_CLASSIFICATION.UNKNOWN);
  assert.equal(classifyDirtyPath("data/export.csv"), DIRTY_CLASSIFICATION.UNKNOWN);
  assert.equal(classifyDirtyPath("assets/image.png"), DIRTY_CLASSIFICATION.UNKNOWN);
});

// ---------------------------------------------------------------------------
// classifyCanonicalDirty / recoverCanonicalDirty integration tests
// ---------------------------------------------------------------------------

test("classifyCanonicalDirty: clean repo returns clean classification", async () => {
  const { canonical } = await makeRepo();
  const result = classifyCanonicalDirty(canonical);
  assert.equal(result.is_dirty, false);
  assert.equal(result.overall_classification, DIRTY_CLASSIFICATION.CLEAN);
  assert.equal(result.is_safe_to_clean, false);
  assert.match(result.head_before, /^[0-9a-f]{40}$/);
});

test("classifyCanonicalDirty: generated/temp files classified as safe", async () => {
  const { canonical } = await makeRepo();
  await writeFile(join(canonical, "debug.log"), "temp\n", "utf8");
  await writeFile(join(canonical, "output.tmp"), "temp\n", "utf8");

  const result = classifyCanonicalDirty(canonical);
  assert.equal(result.is_dirty, true);
  assert.equal(result.overall_classification, DIRTY_CLASSIFICATION.GENERATED_TEMP);
  assert.equal(result.is_safe_to_clean, true);
  assert.equal(result.file_count, 2);
  assert.ok(result.dirty_paths.includes("debug.log"));
  assert.ok(result.dirty_paths.includes("output.tmp"));
  assert.ok(result.status_snapshot.length > 0);
});

test("classifyCanonicalDirty: source mutation classified as unsafe", async () => {
  const { canonical } = await makeRepo();
  await mkdir(join(canonical, "src"), { recursive: true });
  await writeFile(join(canonical, "src/app.js"), "modified\n", "utf8");

  const result = classifyCanonicalDirty(canonical);
  assert.equal(result.is_dirty, true);
  assert.equal(result.overall_classification, DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION);
  assert.equal(result.is_safe_to_clean, false);
});

test("recoverCanonicalDirty: noop for clean repo", async () => {
  const { canonical } = await makeRepo();
  const classification = classifyCanonicalDirty(canonical);
  const recovery = recoverCanonicalDirty(canonical, classification);

  assert.equal(recovery.recovery_attempted, false);
  assert.equal(recovery.recovery_needed, false);
  assert.equal(recovery.outcome, "noop_clean");
});

test("recoverCanonicalDirty: cleans generated/temp files", async () => {
  const { canonical } = await makeRepo();
  await writeFile(join(canonical, "debug.log"), "temp\n", "utf8");
  await writeFile(join(canonical, "temp.tmp"), "temp\n", "utf8");

  const classification = classifyCanonicalDirty(canonical);
  assert.equal(classification.is_safe_to_clean, true);

  const recovery = recoverCanonicalDirty(canonical, classification);
  assert.equal(recovery.recovery_attempted, true);
  assert.equal(recovery.clean_after, true);
  assert.equal(recovery.outcome, "cleaned_safe_only");
  assert.equal(recovery.cleaned_files.length, 2);
  assert.match(recovery.head_before, /^[0-9a-f]{40}$/);
  assert.match(recovery.head_after, /^[0-9a-f]{40}$/);

  // Verify canonical is actually clean
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: canonical, encoding: "utf8" }).trim();
  assert.equal(status, "");
});

test("recoverCanonicalDirty: blocks on unexpected source mutations", async () => {
  const { canonical } = await makeRepo();
  await mkdir(join(canonical, "src"), { recursive: true });
  await writeFile(join(canonical, "src/app.js"), "modified\n", "utf8");

  const classification = classifyCanonicalDirty(canonical);
  assert.equal(classification.is_safe_to_clean, false);

  const recovery = recoverCanonicalDirty(canonical, classification);
  assert.equal(recovery.recovery_attempted, false);
  assert.equal(recovery.outcome, "blocked_unsafe");
  assert.ok(recovery.evidence.dirty_files.includes("src/") || recovery.evidence.dirty_files.includes("src/app.js"));
});

// ---------------------------------------------------------------------------
// classifyFFOnlyFailure integration tests
// ---------------------------------------------------------------------------

test("classifyFFOnlyFailure: canonical advanced is recoverable", async () => {
  const { canonical, worktree } = await makeRepo();
  // Create commit in worktree
  await writeFile(join(worktree, "README.md"), "base\nworktree\n", "utf8");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-m", "fix: worktree change"]);
  const wtCommit = git(worktree, ["rev-parse", "HEAD"]);

  // Create commit in canonical (advancing it)
  await writeFile(join(canonical, "advance.txt"), "advance\n", "utf8");
  git(canonical, ["add", "advance.txt"]);
  git(canonical, ["commit", "-m", "chore: advance"]);

  const result = classifyFFOnlyFailure(canonical, worktree, wtCommit);
  assert.ok(["canonical_advanced", "worktree_diverged"].includes(result.failure_reason));
  assert.equal(result.is_recoverable, true);
  assert.equal(result.merge_conflict_detected, false);
});

test("classifyFFOnlyFailure: captures diagnostic evidence", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nworktree\n", "utf8");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-m", "fix: worktree change"]);
  const wtCommit = git(worktree, ["rev-parse", "HEAD"]);

  await writeFile(join(canonical, "advance.txt"), "advance\n", "utf8");
  git(canonical, ["add", "advance.txt"]);
  git(canonical, ["commit", "-m", "chore: advance"]);

  const result = classifyFFOnlyFailure(canonical, worktree, wtCommit);
  assert.match(result.canonical_head, /^[0-9a-f]{40}$/);
  assert.match(result.target_commit, /^[0-9a-f]{40}$/);
  assert.match(result.merge_base, /^[0-9a-f]{40}$/);
  assert.ok(result.canonical_commits_ahead > 0 || result.commit_commits_ahead > 0);
});

// ---------------------------------------------------------------------------
// recoverFFOnlyMerge integration tests
// ---------------------------------------------------------------------------

test("recoverFFOnlyMerge: recovers via rebase when canonical advanced", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nworktree\n", "utf8");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-m", "fix: worktree change"]);
  const wtCommit = git(worktree, ["rev-parse", "HEAD"]);

  await writeFile(join(canonical, "advance.txt"), "advance\n", "utf8");
  git(canonical, ["add", "advance.txt"]);
  git(canonical, ["commit", "-m", "chore: advance"]);

  const classification = classifyFFOnlyFailure(canonical, worktree, wtCommit);
  assert.equal(classification.is_recoverable, true);

  const recovery = await recoverFFOnlyMerge({
    canonicalRepoPath: canonical,
    worktreePath: worktree,
    failureClassification: classification,
    defaultBranch: "main",
  });

  assert.equal(recovery.recovery_attempted, true);
  assert.ok(recovery.outcome.startsWith("recovered_via"), `expected recovery, got: ${recovery.outcome}`);
  assert.equal(recovery.clean_after, true);
  assert.match(recovery.head_before, /^[0-9a-f]{40}$/);
  assert.match(recovery.head_after, /^[0-9a-f]{40}$/);
  assert.ok(recovery.attempts >= 1);
  assert.ok(recovery.actions.length > 0);
});

test("recoverFFOnlyMerge: blocks unrecoverable classifications", async () => {
  // Create a classification that's not recoverable
  const fakeClassification = {
    is_recoverable: false,
    failure_reason: "unknown",
    divergence_detail: "Could not determine divergence cause.",
    canonical_head: "0000000000000000000000000000000000000000",
    target_commit: "0000000000000000000000000000000000000000",
    merge_base: null,
    merge_conflict_detected: null,
  };

  const { canonical, worktree } = await makeRepo();
  const recovery = await recoverFFOnlyMerge({
    canonicalRepoPath: canonical,
    worktreePath: worktree,
    failureClassification: fakeClassification,
    defaultBranch: "main",
  });

  assert.equal(recovery.recovery_attempted, false);
  assert.equal(recovery.outcome, "blocked_unrecoverable");
  assert.equal(recovery.attempts, 0);
});

test("recoverCanonicalDirty: captures head before/after and clean status", async () => {
  const { canonical } = await makeRepo();
  await writeFile(join(canonical, "data.tmp"), "temp\n", "utf8");

  const classification = classifyCanonicalDirty(canonical);
  const beforeHead = classification.head_before;

  const recovery = recoverCanonicalDirty(canonical, classification);
  assert.match(recovery.head_before, /^[0-9a-f]{40}$/);
  assert.match(recovery.head_after, /^[0-9a-f]{40}$/);
  assert.equal(recovery.clean_after, true);
  assert.equal(recovery.timestamp.length > 0, true);
});

test("classifyFFOnlyFailure: returns unknown for invalid commit", async () => {
  const { canonical, worktree } = await makeRepo();
  const result = classifyFFOnlyFailure(canonical, worktree, "0000000000000000000000000000000000000000");
  assert.equal(result.failure_reason, FF_ONLY_FAILURE_CLASSIFICATION.UNKNOWN);
  assert.equal(result.is_recoverable, false);
});
