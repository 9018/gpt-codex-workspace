/**
 * docs-only-safe-integration.test.mjs — Tests for safe docs-only integration
 *
 * Accepted docs-only commits must integrate through a controlled,
 * allowlisted, idempotent path — not unrestricted shell or cherry-pick.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { integrateDocsOnlyCommit, isDocsOnlyPath, areAllChangedFilesDocs } from "../src/docs-only-safe-integration.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeRepo(prefix = "docs-integration-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(join(repo, ".gitignore"), ".gptwork\n");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

// ===========================================================================
// C1: docs-only commit integrates successfully
// ===========================================================================

test("C1: docs-only commit integrates to canonical main via controlled path", async () => {
  const repo = await makeRepo();
  const commitFile = join(repo, "README.md");
  await writeFile(commitFile, "base\n\nUpdated documentation.\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "docs: update README"], { cwd: repo, stdio: "ignore" });
  const docsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // Call the safe integration function
  const result = await integrateDocsOnlyCommit({
    commit: docsCommit,
    canonicalRepoPath: repo,
    changedFiles: ["README.md"],
    locksBasePath: repo,
    taskId: "test_c1",
  });

  assert.ok(result.ok, `integration should succeed: ${result.error || ""}`);
  assert.ok(result.status === "already_integrated" || result.status === "ff_merged" || result.status === "merged",
    `unexpected status: ${result.status}`);
  assert.equal(result.commit, docsCommit, "result commit matches input commit");

  // After integration, the commit is reachable from HEAD
  assert.doesNotThrow(
    () => execFileSync("git", ["merge-base", "--is-ancestor", docsCommit, "HEAD"], { cwd: repo, stdio: "ignore" }),
    "commit must be reachable from HEAD"
  );
});

// ===========================================================================
// C2: non-docs commit must be rejected
// ===========================================================================

test("C2: safe integration rejects commit with non-docs changed files", async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "index.js"), "// code\n");
  execFileSync("git", ["add", "src/index.js"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "feat: add code"], { cwd: repo, stdio: "ignore" });
  const codeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const result = await integrateDocsOnlyCommit({
    commit: codeCommit,
    canonicalRepoPath: repo,
    changedFiles: ["src/index.js"],
    locksBasePath: repo,
    taskId: "test_c2",
  });

  assert.equal(result.ok, false, "non-docs commit should be rejected");
  assert.equal(result.status, "non_docs_files");
  assert.ok(result.error.includes("src/index.js"), "error should mention the non-docs file");
  assert.deepEqual(result.non_docs_files, ["src/index.js"]);
});

// ===========================================================================
// C3: idempotent — second call succeeds without error
// ===========================================================================

test("C3: safe integration is idempotent on already-integrated commit", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, "README.md"), "base\n\nv2.0.0\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "docs: v2 notice"], { cwd: repo, stdio: "ignore" });
  const docsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // First call
  const first = await integrateDocsOnlyCommit({
    commit: docsCommit,
    canonicalRepoPath: repo,
    changedFiles: ["README.md"],
    locksBasePath: repo,
    taskId: "test_c3",
  });
  assert.ok(first.ok, `first integration should succeed: ${first.error || ""}`);

  // Second call — idempotent (commit is already reachable)
  // Use a temp locks dir to avoid lock file contamination
  const locksDir = track(await mkdtemp(join(tmpdir(), "docs-locks-")));
  const second = await integrateDocsOnlyCommit({
    locksBasePath: locksDir,
    commit: docsCommit,
    canonicalRepoPath: repo,
    changedFiles: ["README.md"],
    locksBasePath: repo,
    taskId: "test_c3",
  });
  assert.ok(second.ok, `second integration should also succeed: ${second.error || ""}`);
  assert.equal(second.status, "already_integrated", "second call should detect already-integrated");

  // HEAD should be unchanged after idempotent integration
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(headAfter, docsCommit, "HEAD unchanged after idempotent integration");
});

// ===========================================================================
// C4: Submodule-level allowlist validation
// ===========================================================================

test("C4: isDocsOnlyPath correctly identifies docs and non-docs files", () => {
  assert.ok(isDocsOnlyPath("README.md"));
  assert.ok(isDocsOnlyPath("docs/guide.md"));
  assert.ok(isDocsOnlyPath("CHANGELOG.txt"));
  assert.ok(isDocsOnlyPath("LICENSE"));
  assert.ok(isDocsOnlyPath("diagram.svg"));
  assert.ok(isDocsOnlyPath("backend/README.adoc"));
  
  assert.ok(!isDocsOnlyPath("src/index.js"));
  assert.ok(!isDocsOnlyPath("backend/src/codex.mjs"));
  assert.ok(!isDocsOnlyPath("package.json"));
  assert.ok(!isDocsOnlyPath("node_modules/index.mjs"));
});

test("C4b: areAllChangedFilesDocs validates collections correctly", () => {
  assert.ok(areAllChangedFilesDocs(["README.md", "CHANGELOG.txt"]));
  assert.ok(!areAllChangedFilesDocs(["README.md", "src/index.js"]));
  assert.ok(!areAllChangedFilesDocs([]));
});
