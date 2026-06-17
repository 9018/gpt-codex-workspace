/**
 * Tests for codex-context-builder.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import "../test/helpers/env-isolation.mjs";
import {
  buildCodexContext,
  loadProjectEnv,
  loadProjectMd,
  formatSize,
  inspectTranscript,
  countMemories,
  generateWarnings,
} from "../src/codex-context-builder.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir(fn) {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempRepo(fn) {
  const dir = join(tmpdir(), "gptwork-test-" + randomUUID());
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, ".git")); // just enough to look like a repo
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

test("formatSize returns 0 B for zero", () => {
  assert.equal(formatSize(0), "0 B");
});

test("formatSize returns bytes under 1024", () => {
  assert.equal(formatSize(512), "512 B");
});

test("formatSize returns KB for values between 1KB and 1MB", () => {
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(153600), "150.0 KB");
});

test("formatSize returns MB for values over 1MB", () => {
  assert.equal(formatSize(1048576), "1.0 MB");
  assert.equal(formatSize(5242880), "5.0 MB");
});

// ---------------------------------------------------------------------------
// loadProjectEnv
// ---------------------------------------------------------------------------

test("loadProjectEnv returns empty when repoPath is null", async () => {
  const result = await loadProjectEnv(null);
  assert.equal(result.ok, false);
  assert.equal(result.path, null);
  assert.deepEqual(result.vars, {});
  assert.deepEqual(result.keys, []);
});

test("loadProjectEnv returns empty when file does not exist", async () => {
  const result = await loadProjectEnv("/tmp/nonexistent-path-" + randomUUID());
  assert.equal(result.ok, false);
});

test("loadProjectEnv parses KEY=VALUE correctly", async () => {
  await withTempRepo(async (repo) => {
    const envPath = join(repo, ".gptwork", "project.env");
    await mkdir(join(repo, ".gptwork"), { recursive: true });
    await writeFile(envPath, [
      "# This is a comment",
      "",
      "DEPLOY_TARGET=staging",
      "API_BASE_URL=https://api.example.com",
      "# ANOTHER_COMMENT=ignored",
      "EMPTY_LINE=",
      "FLAG=true",
    ].join("\n"));

    const result = await loadProjectEnv(repo);
    assert.equal(result.ok, true);
    assert.equal(result.path, envPath);
    assert.equal(result.keys.length, 4);
    assert.equal(result.vars.DEPLOY_TARGET, "staging");
    assert.equal(result.vars.API_BASE_URL, "https://api.example.com");
    assert.equal(result.vars.FLAG, "true");
    assert.ok("EMPTY_LINE" in result.vars);
    assert.equal(result.vars.EMPTY_LINE, "");
  });
});

// ---------------------------------------------------------------------------
// loadProjectMd
// ---------------------------------------------------------------------------

test("loadProjectMd returns empty when repoPath is null", async () => {
  const result = await loadProjectMd(null);
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
});

test("loadProjectMd returns empty when file does not exist", async () => {
  const result = await loadProjectMd("/tmp/nonexistent-" + randomUUID());
  assert.equal(result.ok, false);
});

test("loadProjectMd reads content correctly", async () => {
  await withTempRepo(async (repo) => {
    const mdPath = join(repo, ".gptwork", "project.md");
    await mkdir(join(repo, ".gptwork"), { recursive: true });
    const content = "# Project Context\n\nThis is the project.\n";
    await writeFile(mdPath, content);

    const result = await loadProjectMd(repo);
    assert.equal(result.ok, true);
    assert.equal(result.content, content);
    assert.equal(result.size, Buffer.byteLength(content));
  });
});

// ---------------------------------------------------------------------------
// inspectTranscript
// ---------------------------------------------------------------------------

test("inspectTranscript counts messages for existing transcript", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = join(dir, "transcript.md");
    await writeFile(transcriptPath, [
      "## User message",
      "content here",
      "## Assistant response",
      "more content",
      "## Another message",
      "done",
    ].join("\n"));

    const info = await inspectTranscript(transcriptPath);
    assert.equal(info.exists, true);
    assert.equal(info.message_count, 3);
    assert.ok(info.size > 0);
  });
});

test("inspectTranscript returns zero for missing file", async () => {
  const info = await inspectTranscript("/tmp/missing-file-" + randomUUID());
  assert.equal(info.exists, false);
  assert.equal(info.message_count, 0);
});

// ---------------------------------------------------------------------------
// countMemories
// ---------------------------------------------------------------------------

test("countMemories returns 0 for null context", () => {
  assert.equal(countMemories(null), 0);
});

test("countMemories returns 0 for missing memories array", () => {
  assert.equal(countMemories({}), 0);
});

test("countMemories counts memories array", () => {
  const ctx = { memories: [{ key: "a", value: "1" }, { key: "b", value: "2" }] };
  assert.equal(countMemories(ctx), 2);
});

// ---------------------------------------------------------------------------
// generateWarnings
// ---------------------------------------------------------------------------

test("generateWarnings warns for missing repo", () => {
  const warnings = generateWarnings(
    { id: "task_1" },
    { id: "goal_1" },
    null,
    null,
    { exists: false, size: 0, size_label: "0 B" },
    null
  );
  assert.ok(warnings.some(w => w.code === "missing_repo"));
});

test("generateWarnings warns for missing goal", () => {
  const warnings = generateWarnings(
    { id: "task_1" },
    null,
    null,
    null,
    { exists: false, size: 0, size_label: "0 B" },
    { repo_id: "test/repo" }
  );
  assert.ok(warnings.some(w => w.code === "missing_goal"));
});

test("generateWarnings warns for dirty worktree", () => {
  const warnings = generateWarnings(
    { id: "task_1" },
    { id: "goal_1" },
    null,
    { has_uncommitted: true, ahead: 0, behind: 0, default_branch: "main" },
    { exists: false, size: 0, size_label: "0 B" },
    { repo_id: "test/repo" }
  );
  assert.ok(warnings.some(w => w.code === "dirty_worktree"));
});

test("generateWarnings warns for stale clone", () => {
  const warnings = generateWarnings(
    { id: "task_1" },
    { id: "goal_1" },
    null,
    { has_uncommitted: false, ahead: 2, behind: 1, default_branch: "main" },
    { exists: false, size: 0, size_label: "0 B" },
    { repo_id: "test/repo" }
  );
  assert.ok(warnings.some(w => w.code === "stale_clone"));
});

test("generateWarnings warns for huge transcript", () => {
  const warnings = generateWarnings(
    { id: "task_1" },
    { id: "goal_1" },
    null,
    null,
    { exists: true, size: 200 * 1024, size_label: "200.0 KB", message_count: 50 },
    { repo_id: "test/repo" }
  );
  assert.ok(warnings.some(w => w.code === "huge_transcript"));
});

// ---------------------------------------------------------------------------
// buildCodexContext — integration
// ---------------------------------------------------------------------------

test("buildCodexContext with task only (no goal, no workspace, no repo)", async () => {
  const { context, preview } = await buildCodexContext({
    taskId: "task_abc123",
    task: { id: "task_abc123", title: "Test task", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
    config: {
      defaultWorkspaceRoot: "/home/workspace",
      statePath: "/home/workspace/.gptwork/state.json",
      codexExecTimeout: 2400,
      codexExecArgs: "--yolo",
    },
  });

  assert.equal(context.task.id, "task_abc123");
  assert.equal(context.task.title, "Test task");
  assert.equal(context.task.status, "assigned");
  assert.equal(context.task.mode, "builder");
  assert.equal(context.goal, null);
  assert.equal(context.workspace, null);
  assert.equal(context.canonical_repo.path, null);
  assert.ok(context.built_at);
  assert.ok(preview.includes("Test task"));
  assert.ok(preview.includes("task_abc123"));
});

test("buildCodexContext with linked goal", async () => {
  const { context, preview } = await buildCodexContext({
    taskId: "task_xyz",
    task: { id: "task_xyz", title: "Goal-linked task", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
    goal: { id: "goal_demo123", mode: "builder", status: "assigned", title: "Demo goal" },
    workspace: { id: "hosted-default", root: "/tmp/test-workspace", type: "hosted" },
  });

  assert.equal(context.goal.id, "goal_demo123");
  assert.equal(context.goal.mode, "builder");
  assert.equal(context.workspace.id, "hosted-default");
  assert.equal(context.workspace.root, "/tmp/test-workspace");
  assert.ok(preview.includes("goal_demo123"));
  assert.ok(preview.includes("/tmp/test-workspace"));
});

test("buildCodexContext with repo record and status", async () => {
  const { context, preview } = await buildCodexContext({
    taskId: "task_repo1",
    task: { id: "task_repo1", title: "Repo task", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
    repoRecord: {
      repo_id: "github.com/owner/repo",
      remote_url: "git@github.com:owner/repo.git",
      default_branch: "main",
      owner: "owner",
      repo_name: "repo",
      host: "github.com",
      canonical_path: "/tmp/canonical-repo",
    },
    repoStatus: {
      has_uncommitted: false,
      ahead: 0,
      behind: 0,
      current_branch: "main",
      local_head: "abc123",
      remote_head: "def456",
      default_branch: "main",
    },
    config: {
      defaultWorkspaceRoot: "/tmp/workspace",
      statePath: "/tmp/workspace/.gptwork/state.json",
      codexExecTimeout: 2400,
      defaultRepoPath: "/tmp/canonical-repo",
    },
  });

  assert.equal(context.canonical_repo.path, "/tmp/canonical-repo");
  assert.equal(context.canonical_repo.record.repo_id, "github.com/owner/repo");
  assert.equal(context.canonical_repo.status.current_branch, "main");
  assert.equal(context.canonical_repo.status.ahead, 0);
  assert.ok(preview.includes("/tmp/canonical-repo"));
  assert.ok(preview.includes("main"));
});

test("buildCodexContext discovers project.md and project.env", async () => {
  await withTempRepo(async (repo) => {
    await mkdir(join(repo, ".gptwork"), { recursive: true });
    await writeFile(join(repo, ".gptwork", "project.md"), "# Project\nTest project.");
    await writeFile(join(repo, ".gptwork", "project.env"), "KEY=value\nDEBUG=1\n");

    const { context, preview } = await buildCodexContext({
      taskId: "task_proj_ctx",
      task: { id: "task_proj_ctx", title: "Project context", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
      repoRecord: {
        repo_id: "github.com/owner/repo",
        remote_url: "git@github.com:owner/repo.git",
        default_branch: "main",
        owner: "owner",
        repo_name: "repo",
        host: "github.com",
        canonical_path: repo,
      },
      config: {
        defaultWorkspaceRoot: "/tmp/ws",
        statePath: "/tmp/ws/.gptwork/state.json",
        defaultRepoPath: repo,
      },
    });

    assert.equal(context.project_context.project_md.ok, true);
    assert.ok(context.project_context.project_md.size > 0);
    assert.equal(context.project_context.project_env.ok, true);
    assert.deepEqual(context.project_context.project_env.keys, ["KEY", "DEBUG"]);
    assert.ok(preview.includes("project.md"));
    assert.ok(preview.includes("project.env"));
    assert.ok(preview.includes("2 vars"));
  });
});

test("buildCodexContext with memories", async () => {
  const contextJson = {
    memories: [
      { key: "last_result", value: "completed" },
      { key: "user_pref", value: "dark_mode" },
    ],
  };

  const { context } = await buildCodexContext({
    taskId: "task_mem",
    task: { id: "task_mem", title: "Mem test", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
    contextJson,
  });

  assert.equal(context.size_metrics.memory_count, 2);
});

test("buildCodexContext warns for missing repo", async () => {
  const { context } = await buildCodexContext({
    taskId: "task_nowarn",
    task: { id: "task_nowarn", title: "No warn", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
  });

  assert.ok(context.warnings.some(w => w.code === "missing_repo"));
});

test("buildCodexContext warns for missing goal", async () => {
  const { context } = await buildCodexContext({
    taskId: "task_no_goal",
    task: { id: "task_no_goal", title: "No goal", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
  });

  assert.ok(context.warnings.some(w => w.code === "missing_goal"));
});

test("preview includes size metrics when present", async () => {
  const contextJson = {
    memories: [{ key: "k1", value: "v1" }],
  };

  const { preview } = await buildCodexContext({
    taskId: "task_size",
    task: { id: "task_size", title: "Size test", status: "assigned", mode: "builder", assignee: "codex", workspace_id: "hosted-default" },
    contextJson,
  });

  assert.ok(preview.includes("memory_count"));
  assert.ok(preview.includes("1"));
});

console.log("codex-context-builder.test.mjs loaded");
