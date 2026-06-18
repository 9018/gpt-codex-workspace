import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseGitHubUrl,
  deriveCanonicalRelPath,
  deriveCanonicalPath,
  deriveWorktreeRelPath,
  deriveWorktreePath,
  deriveTmpRelPath,
  deriveTmpPath,
  isTempClone,
  isCanonicalPath,
  detectStaleTempClones,
  RepoRegistry,
  getRepoStatus,
  _gitExec,
} from "../src/repo-registry.mjs";

// ---------------------------------------------------------------------------
// 1. GitHub SSH URL parsing
// ---------------------------------------------------------------------------

test("parseGitHubUrl parses standard SSH URL", () => {
  const result = parseGitHubUrl("git@github.com:owner/repo.git");
  assert.notEqual(result, null);
  assert.equal(result.provider, "github");
  assert.equal(result.host, "github.com");
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
  assert.equal(result.repo_id, "github.com/owner/repo");
});

test("parseGitHubUrl parses SSH URL without .git suffix", () => {
  const result = parseGitHubUrl("git@github.com:owner/my-repo");
  assert.notEqual(result, null);
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "my-repo");
  assert.equal(result.repo_id, "github.com/owner/my-repo");
});

test("parseGitHubUrl parses SSH URL with dot in repo name", () => {
  const result = parseGitHubUrl("git@github.com:9018/gpt-codex-workspace.git");
  assert.notEqual(result, null);
  assert.equal(result.owner, "9018");
  assert.equal(result.repo, "gpt-codex-workspace");
  assert.equal(result.repo_id, "github.com/9018/gpt-codex-workspace");
});

// ---------------------------------------------------------------------------
// 2. GitHub HTTPS URL parsing
// ---------------------------------------------------------------------------

test("parseGitHubUrl parses standard HTTPS URL with .git", () => {
  const result = parseGitHubUrl("https://github.com/owner/repo.git");
  assert.notEqual(result, null);
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
  assert.equal(result.repo_id, "github.com/owner/repo");
});

test("parseGitHubUrl parses HTTPS URL without .git", () => {
  const result = parseGitHubUrl("https://github.com/owner/repo");
  assert.notEqual(result, null);
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
});

test("parseGitHubUrl parses HTTPS URL with branch fragment", () => {
  const result = parseGitHubUrl("https://github.com/owner/repo#main");
  assert.notEqual(result, null);
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
});

test("parseGitHubUrl parses owner/repo shorthand", () => {
  const result = parseGitHubUrl("owner/repo");
  assert.notEqual(result, null);
  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
  assert.equal(result.repo_id, "github.com/owner/repo");
});

test("parseGitHubUrl returns null for invalid input", () => {
  assert.equal(parseGitHubUrl(null), null);
  assert.equal(parseGitHubUrl(""), null);
  assert.equal(parseGitHubUrl("   "), null);
  assert.equal(parseGitHubUrl("not-a-url"), null);
  assert.equal(parseGitHubUrl(42), null);
});

// ---------------------------------------------------------------------------
// 3. repo_id generation (covered by URL parsing tests above)
// ---------------------------------------------------------------------------

test("repo_id is unique per owner/repo combination", () => {
  const a = parseGitHubUrl("git@github.com:alice/awesome-tool.git");
  const b = parseGitHubUrl("git@github.com:bob/awesome-tool.git");
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.notEqual(a.repo_id, b.repo_id);
  assert.equal(a.repo_id, "github.com/alice/awesome-tool");
  assert.equal(b.repo_id, "github.com/bob/awesome-tool");
});

// ---------------------------------------------------------------------------
// 4. Canonical path generation
// ---------------------------------------------------------------------------

test("deriveCanonicalRelPath produces correct relative path", () => {
  const rel = deriveCanonicalRelPath("github.com/9018/gpt-codex-workspace");
  assert.equal(rel, "repos/github.com/9018/gpt-codex-workspace");
});

test("deriveCanonicalPath produces correct absolute path", () => {
  const abs = deriveCanonicalPath("/workspace", "github.com/9018/repo");
  // Use resolve to normalize platform separators
  assert.equal(resolve(abs), resolve("/workspace/repos/github.com/9018/repo"));
});

// ---------------------------------------------------------------------------
// 5. Duplicate repo names under different owners
// ---------------------------------------------------------------------------

test("same repo name under different owners produces different repo_ids", () => {
  const r1 = parseGitHubUrl("git@github.com:user1/common-name.git");
  const r2 = parseGitHubUrl("git@github.com:user2/common-name.git");
  assert.notEqual(r1, null);
  assert.notEqual(r2, null);
  assert.notEqual(r1.repo_id, r2.repo_id);
  assert.equal(r1.repo, r2.repo); // same repo name
  assert.notEqual(r1.owner, r2.owner); // different owners
});

// ---------------------------------------------------------------------------
// 6. Registry load/save/update
// ---------------------------------------------------------------------------

test("RepoRegistry round-trip: register, load, update, unregister", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-registry-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  // Initially empty
  assert.equal(reg.count(), 0);
  assert.equal(reg.list().length, 0);
  assert.equal(reg.getDefaultRepo(), null);

  // Register one repo
  const r1 = await reg.register({
    remote_url: "git@github.com:9018/gpt-codex-workspace.git",
    canonical_path: "/home/a9017/mcp/gpt-codex-workspace",
    roles: ["primary"],
    tags: ["deploy"],
  });

  assert.equal(r1.repo_id, "github.com/9018/gpt-codex-workspace");
  assert.equal(r1.owner, "9018");
  assert.equal(r1.repo_name, "gpt-codex-workspace");
  assert.equal(r1.default_branch, "main"); // no branch detected, defaults to main
  assert.deepEqual(r1.roles, ["primary"]);
  assert.equal(r1.status, "active");

  // count and list
  assert.equal(reg.count(), 1);
  assert.equal(reg.list().length, 1);
  const defaultRepo = reg.getDefaultRepo();
  assert.notEqual(defaultRepo, null);
  assert.equal(defaultRepo.repo_id, r1.repo_id);

  // get by repo_id
  const fetched = reg.get("github.com/9018/gpt-codex-workspace");
  assert.notEqual(fetched, null);
  assert.equal(fetched.remote_url, "git@github.com:9018/gpt-codex-workspace.git");

  // findByUrl
  const byUrl = reg.findByUrl("https://github.com/9018/gpt-codex-workspace.git");
  assert.notEqual(byUrl, null);
  assert.equal(byUrl.repo_id, r1.repo_id);

  // findByPath
  const byPath = reg.findByPath("/home/a9017/mcp/gpt-codex-workspace");
  assert.notEqual(byPath, null);
  assert.equal(byPath.repo_id, r1.repo_id);

  // findByName
  const byName = reg.findByName("9018", "gpt-codex-workspace");
  assert.notEqual(byName, null);
  assert.equal(byName.repo_id, r1.repo_id);

  // Update: add a tag
  r1.tags.push("updated");
  r1.status = "archived";
  await reg.register({
    remote_url: "git@github.com:9018/gpt-codex-workspace.git",
    tags: r1.tags,
    status: "archived",
  });

  const updated = reg.get("github.com/9018/gpt-codex-workspace");
  assert.ok(updated.tags.includes("updated"));
  assert.equal(updated.status, "archived");

  // Unregister
  const unregistered = await reg.unregister("github.com/9018/gpt-codex-workspace");
  assert.equal(unregistered, true);
  assert.equal(reg.count(), 0);

  // Unregister again (no-op)
  const again = await reg.unregister("github.com/9018/gpt-codex-workspace");
  assert.equal(again, false);

  // Cleanup
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Canonical repo selection over .tmp-* clone
// ---------------------------------------------------------------------------

test("isTempClone correctly identifies .tmp paths", () => {
  assert.equal(isTempClone("/workspace/.tmp-gh-check-repo"), true);
  assert.equal(isTempClone(".tmp-foo"), true);
  assert.equal(isTempClone("/workspace/repos/github.com/owner/repo"), false);
  assert.equal(isTempClone(null), false);
  assert.equal(isTempClone(""), false);
});

test("isCanonicalPath identifies canonical repos path", () => {
  assert.equal(
    isCanonicalPath("/ws/repos/github.com/owner/repo", "/ws"),
    true
  );
  assert.equal(
    isCanonicalPath("/ws/.tmp-gh-check-repo/repo", "/ws"),
    false
  );
  assert.equal(isCanonicalPath("/outside/path", "/ws"), false);
});

test("RepoRegistry resolves canonical repo from temp clones correctly", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-canonical-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");
  await mkdir(wsRoot, { recursive: true });

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  // Register the canonical repo
  const canonicalPath = join(wsRoot, "repos/github.com/9018/gpt-codex-workspace");
  await reg.register({
    remote_url: "git@github.com:9018/gpt-codex-workspace.git",
    canonical_path: canonicalPath,
  });

  // Verify it's registered
  const record = reg.get("github.com/9018/gpt-codex-workspace");
  assert.notEqual(record, null);
  assert.equal(record.canonical_path, canonicalPath);

  // The canonical repo should be the preferred source
  const repo = reg.getDefaultRepo();
  assert.notEqual(repo, null);
  assert.equal(repo.repo_id, "github.com/9018/gpt-codex-workspace");

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 8. Stale temp clone detection
// ---------------------------------------------------------------------------

test("detectStaleTempClones finds .tmp directories", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-stale-test-"));
  const wsRoot = join(tmpDir, "ws");
  await mkdir(wsRoot, { recursive: true });

  // Create a stale temp clone directory structure
  const staleDir = join(wsRoot, ".tmp-gh-check-my-repo");
  await mkdir(join(staleDir, "repo", ".git"), { recursive: true });

  // Create a non-tmp directory (should be ignored)
  await mkdir(join(wsRoot, "repos"), { recursive: true });

  const clones = await detectStaleTempClones(wsRoot);
  assert.equal(clones.length, 1);
  assert.equal(clones[0].name, ".tmp-gh-check-my-repo");
  assert.equal(clones[0].is_repo, true);
  assert.equal(clones[0].type, "temp-clone");

  await rm(tmpDir, { recursive: true, force: true });
});

test("detectStaleTempClones ignores .git dirs that are not under .tmp", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-stale-test-2-"));
  const wsRoot = join(tmpDir, "ws");
  await mkdir(join(wsRoot, "some-valid-dir", ".git"), { recursive: true });

  const clones = await detectStaleTempClones(wsRoot);
  assert.equal(clones.length, 0);

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 9. Multi-repo ambiguity when repo_id is omitted
// ---------------------------------------------------------------------------

test("RepoRegistry.getDefaultRepo returns null when multiple repos exist", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-ambig-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  // Register two repos
  await reg.register({ remote_url: "git@github.com:alice/repo-a.git" });
  await reg.register({ remote_url: "git@github.com:bob/repo-b.git" });

  assert.equal(reg.count(), 2);
  assert.equal(reg.getDefaultRepo(), null); // ambiguous

  await rm(tmpDir, { recursive: true, force: true });
});

test("RepoRegistry.resolveRepoId handles various input formats", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-resolve-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  await reg.register({ remote_url: "git@github.com:9018/gpt-codex-workspace.git" });

  // Resolve by full repo_id
  assert.equal(
    reg.resolveRepoId("github.com/9018/gpt-codex-workspace"),
    "github.com/9018/gpt-codex-workspace"
  );

  // Resolve by owner/repo
  assert.equal(
    reg.resolveRepoId("9018/gpt-codex-workspace"),
    "github.com/9018/gpt-codex-workspace"
  );

  // Resolve by HTTPS URL
  assert.equal(
    reg.resolveRepoId("https://github.com/9018/gpt-codex-workspace.git"),
    "github.com/9018/gpt-codex-workspace"
  );

  // Resolve by unique repo name
  assert.equal(
    reg.resolveRepoId("gpt-codex-workspace"),
    "github.com/9018/gpt-codex-workspace"
  );

  // Non-existent returns null
  assert.equal(reg.resolveRepoId("unknown/repo"), null);

  await rm(tmpDir, { recursive: true, force: true });
});

test("resolveRepoId returns null for ambiguous repo name", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-ambig-name-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  // Two repos with same name but different owners
  await reg.register({ remote_url: "git@github.com:user1/common.git" });
  await reg.register({ remote_url: "git@github.com:user2/common.git" });

  // Resolving by just "common" should fail due to ambiguity
  assert.equal(reg.resolveRepoId("common"), null);

  // But resolving by owner/repo works
  assert.equal(
    reg.resolveRepoId("user1/common"),
    "github.com/user1/common"
  );

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10. Worktree and tmp path generation
// ---------------------------------------------------------------------------

test("deriveWorktreeRelPath and deriveWorktreePath", () => {
  const rel = deriveWorktreeRelPath("github.com/owner/repo", "task_abc123");
  assert.equal(rel, "worktrees/github.com/owner/repo/task_abc123");

  const abs = deriveWorktreePath("/ws", "github.com/owner/repo", "task_abc123");
  assert.equal(resolve(abs), resolve("/ws/worktrees/github.com/owner/repo/task_abc123"));
});

test("deriveTmpRelPath and deriveTmpPath", () => {
  const rel = deriveTmpRelPath("task_abc123");
  assert.equal(rel, "tmp/codex/task_abc123");

  const abs = deriveTmpPath("/ws", "task_abc123");
  assert.equal(resolve(abs), resolve("/ws/tmp/codex/task_abc123"));
});

test("RepoRegistry.generateWorktreePath and generateTmpPath", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-path-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  const wt = reg.generateWorktreePath("github.com/owner/repo", "run_42");
  assert.equal(resolve(wt), resolve(join(wsRoot, "worktrees/github.com/owner/repo/run_42")));

  const tp = reg.generateTmpPath("run_42");
  assert.equal(resolve(tp), resolve(join(wsRoot, "tmp/codex/run_42")));

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Additional: registry persistence across instances
// ---------------------------------------------------------------------------

test("RepoRegistry persists and reloads correctly", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-persist-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  // First instance: register
  const reg1 = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });
  await reg1.register({
    remote_url: "git@github.com:org/repo.git",
    canonical_path: "/some/path",
    roles: ["primary"],
  });
  assert.equal(reg1.count(), 1);

  // Second instance: reload
  const reg2 = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });
  await reg2.load();
  assert.equal(reg2.count(), 1);
  const r = reg2.get("github.com/org/repo");
  assert.notEqual(r, null);
  assert.equal(r.owner, "org");
  assert.equal(r.canonical_path, "/some/path");
  assert.deepEqual(r.roles, ["primary"]);

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getRepoStatus with non-existent repo dir (no .git)
// ---------------------------------------------------------------------------

test("getRepoStatus returns skeleton status when repo dir has no .git", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-status-test-"));
  const wsRoot = join(tmpDir, "ws");

  const record = {
    repo_id: "github.com/org/mock-repo",
    remote_url: "git@github.com:org/mock-repo.git",
    default_branch: "main",
    canonical_path: join(tmpDir, "nonexistent"),
  };

  const status = await getRepoStatus(record, wsRoot);
  assert.equal(status.repo_id, "github.com/org/mock-repo");
  assert.equal(status.local_head, null);
  assert.equal(status.remote_head, null);
  assert.equal(status.is_canonical, false);
  assert.ok(Array.isArray(status.stale_temp_copies));

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getRepoStatus with a real temp git repo
// ---------------------------------------------------------------------------

test("getRepoStatus reports correct state for a git repo", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-git-status-"));
  const repoDir = join(tmpDir, "repo");
  await mkdir(repoDir, { recursive: true });

  // Init a git repo with an initial commit
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });
  await writeFile(join(repoDir, "README.md"), "# Test");
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  const head = execSync("git commit -m 'initial'", {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
  const headSha = execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();

  // Rename default branch to main
  execSync("git branch -m master main", { cwd: repoDir, stdio: "pipe" });

  const record = {
    repo_id: "github.com/test/test-repo",
    remote_url: "git@github.com:test/test-repo.git",
    default_branch: "main",
    canonical_path: repoDir,
  };

  const status = await getRepoStatus(record, tmpDir);

  assert.equal(status.repo_id, "github.com/test/test-repo");
  assert.equal(status.local_head, headSha);
  assert.equal(status.current_branch, "main");
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.is_canonical, true); // registered canonical path that exists on disk
  // P1.1: Verify new diagnostic fields
  assert.equal(status.repo_dir_exists, true);
  assert.equal(status.effective_path, repoDir);
  assert.equal(status.registry_path, repoDir);
  assert.equal(status.canonical_at_standard_location, false); // not under wsRoot/repos/

  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getAllCanonicalPaths
// ---------------------------------------------------------------------------

test("RepoRegistry.getAllCanonicalPaths returns registered paths", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "gptwork-paths-test-"));
  const registryPath = join(tmpDir, "repos.json");
  const wsRoot = join(tmpDir, "ws");

  const reg = new RepoRegistry({ registryPath, workspaceRoot: wsRoot });

  // No repos yet
  assert.deepEqual(reg.getAllCanonicalPaths(), []);

  await reg.register({
    remote_url: "git@github.com:a/b.git",
    canonical_path: "/path/to/b",
  });
  await reg.register({
    remote_url: "git@github.com:c/d.git",
    canonical_path: "/path/to/d",
  });

  const paths = reg.getAllCanonicalPaths();
  assert.equal(paths.length, 2);
  assert.ok(paths.includes("/path/to/b"));
  assert.ok(paths.includes("/path/to/d"));

  await rm(tmpDir, { recursive: true, force: true });
});
