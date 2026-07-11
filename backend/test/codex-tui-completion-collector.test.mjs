import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectCodexTuiCompletion } from "../src/codex-tui-completion-collector.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo(prefix = "codex-tui-collector-repo-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

async function createSession(repo, overrides = {}) {
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  return store.createSession({
    sessionId: overrides.sessionId || "session_1",
    taskId: overrides.taskId || "task_1",
    goalId: overrides.goalId || "goal_1",
    cwd: repo,
    repoLockId: "repo_lock_1",
    ...overrides.session,
  });
}

test("collect returns not ready when result.md is missing", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.kind, "codex_tui_completion_snapshot");
  assert.equal(snapshot.session_id, "session_1");
  assert.equal(snapshot.goal_id, "goal_1");
  assert.equal(snapshot.task_id, "task_1");
  assert.equal(snapshot.result_md_present, false);
  assert.equal(snapshot.ready_for_review, false);
  assert.ok(snapshot.findings.some((finding) => finding.code === "result_md_missing"));
});

test("collect reports dirty_worktree and commit_missing when dirty work has no commit evidence", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  await mkdir(join(repo, ".gptwork", "goals", "goal_1"), { recursive: true });
  await writeFile(join(repo, ".gptwork", "goals", "goal_1", "result.md"), "Summary\n\nTests: npm test\n");
  await writeFile(join(repo, "changed.txt"), "dirty\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.result_md_present, true);
  assert.equal(snapshot.worktree_clean, false);
  assert.deepEqual(snapshot.changed_files, ["changed.txt"]);
  assert.equal(snapshot.commit, null);
  assert.equal(snapshot.ready_for_review, false);
  assert.ok(snapshot.findings.some((finding) => finding.code === "dirty_worktree"));
  assert.ok(snapshot.findings.some((finding) => finding.code === "commit_missing"));
  assert.equal(snapshot.tests, "npm test");
});

test("collect can return ready_for_review when durable evidence is present", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);
  await mkdir(join(repo, ".gptwork", "goals", "goal_1"), { recursive: true });
  await writeFile(join(repo, ".gptwork", "goals", "goal_1", "result.md"), "Summary\n\nTests: node --test backend/test/example.test.mjs\nCommit: abcdef1234567890\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.result_md_present, true);
  assert.equal(snapshot.worktree_clean, true);
  assert.deepEqual(snapshot.changed_files, []);
  assert.equal(snapshot.commit, "abcdef1234567890");
  assert.equal(snapshot.tests, "node --test backend/test/example.test.mjs");
  assert.equal(snapshot.ready_for_review, true);
  assert.deepEqual(snapshot.findings, []);
});

// ===========================================================================
// P1-Multi-Agent: Enhanced TUI completion collector tests for acceptance contract
// evidence mapping. These tests verify that completed TUI session evidence
// maps to the acceptance contract required fields (result, verification, acceptance).
// ===========================================================================

test("collect maps complete acceptance contract evidence when result.md has commit and tests", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create session-level commit evidence
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.updateSession("session_1", { commit: "abc123def456", tests: "npm run check:syntax && npm run check:imports" });

  // Create result.md with matching evidence
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary: TUI session completed.\n\nCommit: abc123def456\nTests: npm run check:syntax && npm run check:imports\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  // Acceptance contract fields: commit is present
  assert.equal(snapshot.commit, "abc123def456", "commit maps to acceptance contract commit field");
  // Acceptance contract fields: tests/verification evidence is present
  assert.equal(snapshot.tests, "npm run check:syntax && npm run check:imports", "tests maps to acceptance contract verification field");
  // Acceptance contract fields: result.md presence = result evidence
  assert.equal(snapshot.result_md_present, true, "result_md_present maps to acceptance contract result evidence");
  // Acceptance contract fields: changed_files = acceptance evidence
  assert.deepEqual(snapshot.changed_files, [], "changed_files maps to acceptance contract change evidence");
  // Ready for review = all acceptance fields complete
  assert.equal(snapshot.ready_for_review, true, "ready_for_review means all acceptance fields are satisfied");
  assert.deepEqual(snapshot.findings, [], "no findings means acceptance contract is complete");

  // Verify the snapshot has the required acceptance contract shape
  assert.ok(typeof snapshot.kind === "string", "has kind field");
  assert.ok(snapshot.session_id, "has session_id field");
  assert.ok(snapshot.goal_id, "has goal_id field");
  assert.ok(snapshot.task_id, "has task_id field");
  assert.ok(Array.isArray(snapshot.changed_files), "has changed_files array");
  assert.ok(typeof snapshot.commit === "string" || snapshot.commit === null, "has commit (can be null)");
  assert.ok(typeof snapshot.tests === "string" || snapshot.tests === null, "has tests (can be null)");
});


// ===========================================================================
// P1-Multi-Agent: Enhanced TUI completion acceptance contract evidence tests.
// ===========================================================================

test("collect returns precise review reasons when evidence is incomplete with dirty worktree", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // result.md present but no commit and no tests
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary only, no commit or tests here.\n");

  // Make a non-excluded dirty change to trigger commit_missing
  await writeFile(join(repo, "uncommitted.txt"), "dirty change\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  // result.md is present
  assert.equal(snapshot.result_md_present, true);
  // But no commit or tests evidence
  assert.equal(snapshot.commit, null, "no commit evidence extracted");
  assert.equal(snapshot.tests, null, "no tests evidence extracted");
  // Dirty worktree because of uncommitted.txt
  assert.equal(snapshot.worktree_clean, false, "worktree is dirty with uncommitted.txt");
  assert.equal(snapshot.ready_for_review, false, "not ready without commit and with dirty worktree");

  // Verify precise review reasons
  const commitFinding = snapshot.findings.find(f => f.code === "commit_missing");
  const dirtyFinding = snapshot.findings.find(f => f.code === "dirty_worktree");
  assert.ok(commitFinding, "precise review reason: commit_missing when no durable commit and dirty worktree");
  assert.equal(commitFinding.severity, "blocker", "commit_missing is a blocker for acceptance");
  assert.ok(dirtyFinding, "precise review reason: dirty_worktree when uncommitted changes exist");
  assert.equal(dirtyFinding.severity, "blocker", "dirty_worktree is a blocker");
  assert.ok(commitFinding.message.includes("Dirty work"), "commit_missing message explains evidence gap");
  assert.ok(dirtyFinding.message.includes("uncommitted"), "dirty_worktree message explains state");
});

test("collect detects actual git commit after committed change", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create result.md and commit a real change
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary: Real change committed.\n\nTests: npm test\n");

  // Make a real git change and commit it
  await writeFile(join(repo, "app.js"), "console.log('TUI change');\n");
  execFileSync("git", ["add", "app.js"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "TUI change from session"], { cwd: repo, stdio: "ignore" });

  // Write session commit
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  const headRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await store.updateSession("session_1", { commit: headRef });

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.commit, headRef, "commit is the actual git HEAD hash");
  assert.equal(snapshot.worktree_clean, true, "worktree is clean after commit");
  // changed_files is empty because collector tracks uncommitted changes only;
  // the commit is already applied to the branch
  assert.equal(snapshot.result_md_present, true, "result.md is present");
  assert.equal(snapshot.ready_for_review, true, "ready for review with complete evidence");
  assert.deepEqual(snapshot.findings, [], "no findings for complete evidence");
});

test("collect reports tests missing as informational (ready_for_review does not require tests)", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create result.md without tests field but with commit
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary: Done, no verification evidence.\n\nCommit: abc123\n");

  // Session provides commit evidence
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.updateSession("session_1", { commit: "abc123" });

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  // Commit present, worktree clean, but tests field is null
  assert.equal(snapshot.commit, "abc123", "commit evidence is present");
  assert.equal(snapshot.tests, null, "tests/verification evidence is missing from result.md and session");
  assert.equal(snapshot.worktree_clean, true, "worktree is clean");
  // ready_for_review is true because collector only requires result.md + clean worktree + commit
  // Tests evidence is informational, not blocking for ready_for_review
  assert.equal(snapshot.ready_for_review, true, "ready_for_review does not require tests evidence");
  assert.equal(snapshot.result_md_present, true, "result.md present");
  // No findings because worktree is clean and commit is present
  // Missing tests is informational, not a finding
  assert.deepEqual(snapshot.findings, [], "no findings when result.md, commit, and clean worktree are present");
});

test("collect returns null tests when result.md has no test evidence", async () => {
  const repo = await makeGitRepo();
  await createSession(repo);

  // Create result.md without tests or commit labels
  const goalDir = join(repo, ".gptwork", "goals", "goal_1");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary: No structured fields.\n");

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_1", workspaceRoot: repo });

  assert.equal(snapshot.tests, null, "tests is null when not in result.md or session");
  assert.equal(snapshot.commit, null, "commit is null when not in result.md or session");
  assert.equal(snapshot.result_md_present, true, "result.md exists");
});

test("collect resolves canonical goal artifacts from workspace root when session cwd is an isolated worktree", async () => {
  const workspace = await makeGitRepo("codex-tui-collector-workspace-");
  const worktree = track(await mkdtemp(join(tmpdir(), "codex-tui-collector-worktree-")));
  execFileSync("git", ["clone", "--quiet", workspace, worktree]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: worktree });

  const store = createCodexTuiSessionStore({ workspaceRoot: workspace });
  await store.createSession({
    sessionId: "session_split_roots",
    taskId: "task_split_roots",
    goalId: "goal_split_roots",
    cwd: worktree,
    repoLockId: "repo_lock_split_roots",
  });

  const goalDir = join(workspace, ".gptwork", "goals", "goal_split_roots");
  await mkdir(goalDir, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    changed_files: ["README.md"],
    tests: [{ status: "passed" }],
    verification: { passed: true },
    commit,
  }));
  await writeFile(join(goalDir, "result.md"), `Summary: completed\n\nTests: node --test\nCommit: ${commit}\n`);

  const snapshot = await collectCodexTuiCompletion({ sessionId: "session_split_roots", workspaceRoot: workspace });

  assert.equal(snapshot.result_json_present, true);
  assert.equal(snapshot.result_md_present, true);
  assert.equal(snapshot.result_json_path, join(goalDir, "result.json"));
  assert.equal(snapshot.result_md_path, join(goalDir, "result.md"));
  assert.equal(snapshot.commit, commit);
  assert.equal(snapshot.ready_for_review, true);
});
