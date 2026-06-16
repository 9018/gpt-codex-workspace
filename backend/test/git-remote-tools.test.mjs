import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  handleResolveRepo,
  handleFetch,
  handleStatus,
  handleListFiles,
  handleReadFile,
} from "../src/git-remote-tools.mjs";

// ---------------------------------------------------------------------------
// Helpers: create a temporary git repo with an origin remote
// ---------------------------------------------------------------------------

/**
 * Create a bare "origin" repo with an initial commit, then clone it as a
 * working repo. The working repo has "origin" pointing to the bare repo.
 *
 * Returns { bareDir, workDir }.
 */
async function createRepoPair() {
  const base = await mkdtemp(join(tmpdir(), "grt-test-"));
  const bareDir = join(base, "origin.git");
  const workDir = join(base, "work");

  await mkdir(bareDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  // Init bare repo
  execSync("git init --bare", { cwd: bareDir, stdio: "pipe" });

  // Clone a working copy from the bare repo
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });

  // Set up user identity in working copy
  execSync("git config user.email test@test.com", { cwd: workDir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: workDir, stdio: "pipe" });

  // Create initial commit
  await writeFile(join(workDir, "README.md"), "# Test Repo\n\nThis is a test.\n");
  await mkdir(join(workDir, "src"), { recursive: true });
  await writeFile(join(workDir, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(workDir, "src", "utils.ts"), "export function hello() { return 'world'; }\n");
  await writeFile(join(workDir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }));
  execSync("git add -A", { cwd: workDir, stdio: "pipe" });
  execSync("git commit -m 'initial commit'", { cwd: workDir, stdio: "pipe" });

  // Rename branch to main
  execSync("git branch -m main", { cwd: workDir, stdio: "pipe" });

  // Push to bare origin
  execSync("git push -u origin main", { cwd: workDir, stdio: "pipe" });
  // Update bare repo HEAD to point to main so clones default to main
  execSync("git symbolic-ref HEAD refs/heads/main", { cwd: bareDir, stdio: "pipe" });

  // Get SHA for origin/main tracking ref
  const originHeadSha = execSync("git rev-parse refs/remotes/origin/main", {
    cwd: workDir, encoding: "utf8",
  }).trim();

  // Now detach from origin/main so we can verify origin/main:README.md works
  // without origin/main being checked out
  execSync("git checkout --detach HEAD", { cwd: workDir, stdio: "pipe" });

  return { base, bareDir, workDir, originHeadSha };
}

function makeContext(workDir) {
  // Simulate registry context (pass null registry, just use workDir resolution)
  return { registry: null, defaultWorkspaceRoot: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("git_remote_read_file reads origin/main:README.md without checking out origin/main", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const ctx = makeContext(workDir);
    const result = handleReadFile(
      { repo: null, repo_path: workDir, ref: "origin/main", path: "README.md", max_bytes: 10000 },
      ctx
    );

    assert.equal(result.ok, true, "handleReadFile should succeed");
    assert.equal(result.bytes, "README.md".length + 20, `bytes should match, got ${result.bytes}`);
    assert.equal(result.truncated, false, "should not be truncated");
    assert.ok(result.content.includes("Test Repo"), "content should contain README text");
    assert.equal(result.path, "README.md");
    assert.equal(result.ref, "origin/main");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_read_file returns truncated content when max_bytes is small", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleReadFile(
      { repo_path: workDir, ref: "origin/main", path: "README.md", max_bytes: 5 },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true, "should be truncated");
    assert.equal(result.content.length, 5, "content should be truncated to max_bytes");
    assert.ok(result.bytes > 5, "original bytes should be larger");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_list_files lists files from origin/main without checking it out", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleListFiles(
      { repo_path: workDir, ref: "origin/main", path: null, limit: 200 },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.ok(result.files.length >= 4, `should list at least 4 files, got ${result.files.length}`);
    assert.ok(result.files.includes("README.md"), "should include README.md");
    assert.ok(result.files.includes("src/index.ts"), "should include src/index.ts");
    assert.ok(result.files.includes("src/utils.ts"), "should include src/utils.ts");
    assert.equal(result.truncated, false, "should not be truncated");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_list_files respects limit and path filter", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleListFiles(
      { repo_path: workDir, ref: "origin/main", path: "src", limit: 1 },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.equal(result.limit, 1);
    assert.equal(result.files.length, 1, "limited to 1 file");
    assert.ok(result.path === "src");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_status reports local/tracking/remote HEADs and equality flags", async () => {
  const { base, workDir, originHeadSha } = await createRepoPair();
  try {
    const result = handleStatus(
      { repo_path: workDir, remote: "origin", branch: "main", fetch: false },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    // In detached HEAD at the initial commit, local should equal tracking
    assert.ok(result.local_head, "should have local_head");
    assert.equal(result.tracking_head, originHeadSha, "tracking_head should match origin/main");
    assert.equal(result.remote_head, originHeadSha, "remote_head should match origin/main");
    // local_equals_tracking should be true (we are at the same commit)
    assert.equal(result.local_equals_tracking, true, "local should equal tracking (detached at same commit)");
    assert.equal(result.tracking_equals_remote, true, "tracking should equal remote");
    assert.equal(result.dirty, false, "should not be dirty");
    assert.deepEqual(result.dirty_paths, [], "dirty_paths should be empty");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_status reports dirty state correctly", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    // Make an uncommitted change
    await writeFile(join(workDir, "dirty.txt"), "dirty content");
    execSync("git add dirty.txt", { cwd: workDir, stdio: "pipe" });
    // Keep it staged but uncommitted

    const result = handleStatus(
      { repo_path: workDir, remote: "origin", branch: "main", fetch: false },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.equal(result.dirty, true, "should be dirty");
    assert.ok(result.dirty_paths.length > 0, "should have dirty paths");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_resolve_repo returns not_found for unknown repo gracefully", async () => {
  // Create a temp dir that is NOT a git repo
  const tmpBase = await mkdtemp(join(tmpdir(), "grt-no-repo-"));
  try {
    const result = handleResolveRepo(
      { repo: null, repo_path: tmpBase },
      { registry: null, defaultWorkspaceRoot: "/tmp/nonexistent-workspace" }
    );
    assert.equal(result.ok, false);
    assert.equal(result.found, false);
    assert.ok(result.error, "should have error message");
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
});

test("git_remote_resolve_repo finds repo by repo_path", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    // Pass null repo but a valid repo_path
    // The repo_path should resolve to the git dir
    const result = handleResolveRepo(
      { repo: null, repo_path: workDir },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.ok(result.repo_path, "should return repo_path");
    assert.ok(result.remote_url, "should return remote_url");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_fetch updates tracking refs", async () => {
  const { base, workDir, bareDir } = await createRepoPair();
  try {
    // Make a new commit in bare via a temp clone
    const tmpClone = join(base, "tmp-clone");
    execSync(`git clone "${bareDir}" "${tmpClone}"`, { stdio: "pipe" });
    execSync("git config user.email other@test.com", { cwd: tmpClone, stdio: "pipe" });
    execSync("git config user.name Other", { cwd: tmpClone, stdio: "pipe" });
    // Modify README
    await writeFile(join(tmpClone, "README.md"), "# Updated\n");
    execSync("git add -A", { cwd: tmpClone, stdio: "pipe" });
    execSync("git commit -m 'update readme'", { cwd: tmpClone, stdio: "pipe" });
    execSync("git push origin main", { cwd: tmpClone, stdio: "pipe" });

    // Now the working repo's origin tracking is stale. Fetch it.
    const result = handleFetch(
      { repo_path: workDir, remote: "origin", branch: "main" },
      makeContext(workDir)
    );
    assert.equal(result.ok, true);
    assert.ok(result.tracking_head, "should have tracking_head after fetch");

    // Verify the tracking head is now the new commit
    const resultAfter = handleStatus(
      { repo_path: workDir, remote: "origin", branch: "main", fetch: false },
      makeContext(workDir)
    );
    // local != tracking (local is still at initial)
    assert.equal(resultAfter.tracking_equals_remote, true, "tracking should now equal remote");
    await rm(tmpClone, { recursive: true, force: true });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_read_file returns error for missing path", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleReadFile(
      { repo_path: workDir, ref: "origin/main", path: "nonexistent.txt" },
      makeContext(workDir)
    );
    assert.equal(result.ok, false);
    assert.ok(result.error, "should return error message");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_list_files returns error for bad ref", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleListFiles(
      { repo_path: workDir, ref: "origin/nonexistent-branch", path: null, limit: 200 },
      makeContext(workDir)
    );
    assert.equal(result.ok, false);
    assert.ok(result.error, "should return error message");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ================================================================
// Tests: resolve_repo default_branch fix and ref fallback
// ================================================================

test("git_remote_resolve_repo default_branch reports discovered default branch", async () => {
  const { base, workDir, bareDir } = await createRepoPair();
  try {
    // Change bare repo HEAD to a non-main branch to test default_branch detection
    execSync("git checkout -b develop", { cwd: workDir, stdio: "pipe" });
    await writeFile(join(workDir, "FEATURE.md"), "# Feature\n");
    execSync("git add -A", { cwd: workDir, stdio: "pipe" });
    execSync("git commit -m 'feature branch'", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin develop", { cwd: workDir, stdio: "pipe" });
    // Set bare repo HEAD to develop (simulating a different default branch on remote)
    execSync("git symbolic-ref HEAD refs/heads/develop", { cwd: bareDir, stdio: "pipe" });
    // Resync local origin/HEAD
    execSync("git remote set-head origin --auto 2>&1 || true", { cwd: workDir, stdio: "pipe" });
    // Detach HEAD
    execSync("git checkout --detach HEAD", { cwd: workDir, stdio: "pipe" });
    // Fetch to update refs
    execSync("git fetch origin 2>&1", { cwd: workDir, stdio: "pipe" });

    const result = handleResolveRepo(
      { repo_path: workDir },
      { registry: null, defaultWorkspaceRoot: null, defaultRemote: "origin" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    // Now origin/HEAD has been set to origin/develop, so default_branch should be "develop"
    assert.equal(result.default_branch, "develop",
      `default_branch should be "develop" (from origin/HEAD), got "${result.default_branch}"`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_read_file falls back to origin/main when no ref provided and defaults are empty", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    // Call handleReadFile without ref, with empty defaultRemote and defaultBranch
    const result = handleReadFile(
      { repo_path: workDir, path: "README.md", max_bytes: 10000 },
      { registry: null, defaultWorkspaceRoot: null, defaultRepo: "", defaultBranch: "", defaultRepoPath: "", defaultRemote: "" }
    );
    assert.equal(result.ok, true, "should fall back to origin/main when defaults are empty");
    assert.ok(result.content.includes("Test Repo"), "should read README.md from origin/main");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote_list_files falls back to origin/main when no ref provided and defaults are empty", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    const result = handleListFiles(
      { repo_path: workDir, path: "", limit: 200 },
      { registry: null, defaultWorkspaceRoot: null, defaultRepo: "", defaultBranch: "", defaultRepoPath: "", defaultRemote: "" }
    );
    assert.equal(result.ok, true, "should fall back to origin/main when defaults are empty");
    assert.ok(result.files.length >= 4, "should list files from origin/main");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git_remote tools accept defaultRepoPath from context", async () => {
  const { base, workDir } = await createRepoPair();
  try {
    // Pass null args but defaultRepoPath in context
    const ctx = {
      registry: null,
      defaultWorkspaceRoot: null,
      defaultRepo: "",
      defaultBranch: "main",
      defaultRepoPath: workDir,
      defaultRemote: "origin"
    };
    // handleResolveRepo should find the repo via defaultRepoPath
    const resolveResult = handleResolveRepo({ repo: null }, ctx);
    assert.equal(resolveResult.ok, true);
    assert.equal(resolveResult.found, true);
    assert.ok(resolveResult.repo_path, "should resolve repo path from defaultRepoPath");

    // handleStatus should work with defaultRepoPath
    const statusResult = handleStatus(
      { remote: "origin", branch: "main", fetch: false },
      ctx
    );
    assert.equal(statusResult.ok, true);
    assert.ok(statusResult.local_head, "should get local head via defaultRepoPath");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
