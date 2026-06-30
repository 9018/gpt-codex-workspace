import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEachHook, track } from "./helpers/temp-cleanup.mjs";
import { analyzeDeliveryRecoveryCandidate, runDeliveryRecovery } from "../src/delivery-result-recovery.mjs";

afterEachHook(test);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeRepo() {
  const root = track(await mkdtemp(join(tmpdir(), "delivery-recovery-")));
  const canonical = join(root, "repo");
  const worktree = join(root, "task-worktree");
  git(root, ["init", "repo", "--initial-branch", "main"]);
  git(canonical, ["config", "user.email", "test@example.com"]);
  git(canonical, ["config", "user.name", "Test User"]);
  await writeFile(join(canonical, "README.md"), "base\n", "utf8");
  git(canonical, ["add", "README.md"]);
  git(canonical, ["commit", "-m", "chore: initial"]);
  git(canonical, ["worktree", "add", "-b", "task/test", worktree, "main"]);
  git(worktree, ["config", "user.email", "test@example.com"]);
  git(worktree, ["config", "user.name", "Test User"]);
  return { root, canonical, worktree };
}

function resolvedRepo(canonical, worktree) {
  return {
    repo_id: "test-repo",
    canonical_repo_path: canonical,
    task_worktree_path: worktree,
    worktree_lifecycle: { ok: true, mode: "git_worktree", branch_name: "task/test" },
  };
}

test("analyzeDeliveryRecoveryCandidate detects dirty worktree commit_missing findings", async () => {
  const { canonical, worktree } = await makeRepo();
  const candidate = analyzeDeliveryRecoveryCandidate({
    task: { id: "task_1" },
    taskResult: {
      changed_files: ["README.md"],
      commit: "none",
      acceptance_findings: [{ code: "commit_missing" }, { code: "dirty_worktree_after_codex" }],
    },
    parsedResult: { status: "completed", changed_files: ["README.md"], commit: null },
    resolvedRepo: resolvedRepo(canonical, worktree),
    cr: { returncode: 0 },
  });

  assert.equal(candidate.attempted, true);
  assert.equal(candidate.eligible, true);
  assert.ok(candidate.triggers.includes("commit_missing"));
  assert.ok(candidate.triggers.includes("dirty_worktree_after_codex"));
});

test("runDeliveryRecovery commits dirty worktree and ff-only merges into canonical repo", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nrecovered\n", "utf8");

  const recovery = await runDeliveryRecovery({
    task: { id: "task_1", title: "P0: recover dirty delivery" },
    goal: { id: "goal_1" },
    config: { defaultBranch: "main", integrationCheckCommands: [] },
    resolvedRepo: resolvedRepo(canonical, worktree),
    taskResult: { changed_files: ["README.md"], commit: null, acceptance_findings: [{ code: "commit_missing" }] },
    parsedResult: { status: "completed", changed_files: ["README.md"], commit: null },
    verificationCommands: ["git status --short"],
  });

  assert.equal(recovery.attempted, true);
  assert.equal(recovery.eligible, true);
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.verification.passed, true);
  assert.equal(recovery.integration.mode, "ff_only");
  assert.equal(recovery.integration.merged, true);
  assert.match(recovery.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(recovery.changed_files, ["README.md"]);
  assert.equal(git(canonical, ["rev-parse", "HEAD"]), recovery.commit);
  assert.equal(git(canonical, ["status", "--short"]), "");
});

test("runDeliveryRecovery blocks when verification command fails before commit", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nbroken\n", "utf8");
  const before = git(worktree, ["rev-parse", "HEAD"]);

  const recovery = await runDeliveryRecovery({
    task: { id: "task_2", title: "P0: failed verification" },
    config: { defaultBranch: "main" },
    resolvedRepo: resolvedRepo(canonical, worktree),
    taskResult: { changed_files: ["README.md"], commit: null, acceptance_findings: [{ code: "dirty_worktree_after_codex" }] },
    verificationCommands: ["exit 7"],
  });

  assert.equal(recovery.recovered, false);
  assert.equal(recovery.verification.passed, false);
  assert.ok(recovery.blockers.some((blocker) => blocker.code === "verification_failed"));
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), before);
  assert.equal(git(canonical, ["rev-parse", "HEAD"]), before);
});

test("runDeliveryRecovery blocks when canonical repo is dirty", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nworktree\n", "utf8");
  await writeFile(join(canonical, "canonical.tmp"), "dirty\n", "utf8");
  const before = git(worktree, ["rev-parse", "HEAD"]);

  const recovery = await runDeliveryRecovery({
    task: { id: "task_3", title: "P0: canonical dirty" },
    config: { defaultBranch: "main" },
    resolvedRepo: resolvedRepo(canonical, worktree),
    taskResult: { changed_files: ["README.md"], commit: null, acceptance_findings: [{ code: "commit_missing" }] },
    verificationCommands: ["true"],
  });

  assert.equal(recovery.recovered, false);
  assert.ok(recovery.blockers.some((blocker) => blocker.code === "canonical_dirty"));
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), before);
});

test("runDeliveryRecovery blocks when ff-only merge cannot integrate task commit", async () => {
  const { canonical, worktree } = await makeRepo();
  await writeFile(join(worktree, "README.md"), "base\nworktree\n", "utf8");
  await writeFile(join(canonical, "canonical.txt"), "advance\n", "utf8");
  git(canonical, ["add", "canonical.txt"]);
  git(canonical, ["commit", "-m", "chore: advance canonical"]);

  const recovery = await runDeliveryRecovery({
    task: { id: "task_4", title: "P0: ff only failure" },
    config: { defaultBranch: "main" },
    resolvedRepo: resolvedRepo(canonical, worktree),
    taskResult: { changed_files: ["README.md"], commit: null, acceptance_findings: [{ code: "commit_missing" }] },
    verificationCommands: ["true"],
  });

  assert.equal(recovery.recovered, false);
  assert.equal(recovery.integration.mode, "ff_only");
  assert.equal(recovery.integration.merged, false);
  assert.ok(recovery.blockers.some((blocker) => blocker.code === "ff_only_merge_failed"));
  assert.doesNotMatch(git(canonical, ["log", "--oneline", "-1"]), /Merge/);
});
