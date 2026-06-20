/**
 * card-utils.test.mjs — unit tests for compact card formatting
 *
 * Covers truncation, status chips, key-value rows, the main card builder,
 * and the tool-specific card formatters (runtimeStatusCard, gptworkDoctorCard,
 * getTaskCard), plus one verbose output truncation path.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  truncateOutput,
  formatTruncationFooter,
  formatStatusChip,
  formatKeyValue,
  formatToolCard,
  formatDiagnostics,
  formatWarnings,
  formatNextActions,
  runtimeStatusCard,
  gptworkDoctorCard,
  getTaskCard,
  createEncodedGoalCard,
  contextStatusCard,
  githubStatusCard,
  previewCodexContextCard,
  shellExecCard,
  gitRemoteDiffCard,
  readTextFileCard,
  listDirCard,
  goalContextCard,
  truncateVerboseOutput,
} from "../src/card-utils.mjs";

// =================================================================
// truncateOutput
// =================================================================

test("truncateOutput returns not truncated for short text", () => {
  const result = truncateOutput("hello world", 20, 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "hello world");
  assert.equal(result.originalLines, 1);
  assert.ok(result.originalBytes > 0);
});

test("truncateOutput truncates by line count", () => {
  const input = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = truncateOutput(input, 3, 8000);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "line 1\nline 2\nline 3");
  assert.equal(result.originalLines, 10);
  assert.equal(result.maxLines, 3);
});

test("truncateOutput truncates by byte count", () => {
  const input = "a".repeat(100);
  const result = truncateOutput(input, 20, 50);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 50);
  assert.equal(result.originalBytes, 100);
  assert.equal(result.maxBytes, 50);
});

test("truncateOutput handles null/undefined", () => {
  const result = truncateOutput(null, 20, 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "");
  assert.equal(result.originalLines, 0);

  const result2 = truncateOutput(undefined, 20, 8000);
  assert.equal(result2.truncated, false);
  assert.equal(result2.text, "");
});

test("truncateOutput does not truncate when within both limits", () => {
  const input = "short text";
  const result = truncateOutput(input, 100, 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "short text");
});

// =================================================================
// formatTruncationFooter
// =================================================================

test("formatTruncationFooter returns empty for non-truncated", () => {
  assert.equal(formatTruncationFooter(null), "");
  assert.equal(formatTruncationFooter({ truncated: false }), "");
});

test("formatTruncationFooter returns footer for truncated", () => {
  const footer = formatTruncationFooter({
    truncated: true,
    originalLines: 100,
    originalBytes: 15000,
    maxLines: 20,
    maxBytes: 8000,
  });
  assert.ok(footer.includes("truncated"));
  assert.ok(footer.includes("100 lines"));
  assert.ok(footer.includes("15000 bytes"));
  assert.ok(footer.includes("20"));
});

// =================================================================
// formatStatusChip
// =================================================================

test("formatStatusChip returns [OK] for green statuses", () => {
  assert.equal(formatStatusChip("ok"), "[OK]");
  assert.equal(formatStatusChip("completed"), "[OK]");
  assert.equal(formatStatusChip("enabled"), "[OK]");
  assert.equal(formatStatusChip("success"), "[OK]");
  assert.equal(formatStatusChip("clean"), "[OK]");
  assert.equal(formatStatusChip("true"), "[OK]");
  assert.equal(formatStatusChip(true), "[OK]");
});

test("formatStatusChip returns [!!] for red statuses", () => {
  assert.equal(formatStatusChip("error"), "[!!]");
  assert.equal(formatStatusChip("failed"), "[!!]");
  assert.equal(formatStatusChip("disabled"), "[!!]");
  assert.equal(formatStatusChip("dirty"), "[!!]");
  assert.equal(formatStatusChip("false"), "[!!]");
  assert.equal(formatStatusChip(false), "[!!]");
});

test("formatStatusChip returns [!!] for unknown status", () => {
  assert.equal(formatStatusChip("unknown"), "[!!]");
  assert.equal(formatStatusChip("pending"), "[--]");
  assert.equal(formatStatusChip("queued"), "[--]");
  assert.equal(formatStatusChip(""), "[--]");
});

// =================================================================
// formatKeyValue
// =================================================================

test("formatKeyValue formats simple values", () => {
  const result = formatKeyValue("pid", 12345);
  assert.ok(result.startsWith("  "));
  assert.ok(result.includes("pid"));
  assert.ok(result.includes("12345"));
});

test("formatKeyValue handles null/undefined", () => {
  assert.ok(formatKeyValue("test", null).includes("-"));
  assert.ok(formatKeyValue("test", undefined).includes("-"));
});

test("formatKeyValue handles booleans", () => {
  assert.ok(formatKeyValue("active", true).includes("yes"));
  assert.ok(formatKeyValue("active", false).includes("no"));
});

test("formatKeyValue converts snake_case to spaces", () => {
  const result = formatKeyValue("running_commit", "abc123");
  assert.ok(result.includes("running commit"));
});

test("formatKeyValue truncates long object values", () => {
  const val = { a: "x".repeat(100) };
  const result = formatKeyValue("data", val);
  assert.ok(result.length < 120);
});

// =================================================================
// formatToolCard (main builder)
// =================================================================

test("formatToolCard produces a text block with dividers", () => {
  const result = formatToolCard("Test Tool", {
    lines: ["  key: value"],
    diagnostics: [{ severity: "info", message: "All good" }],
  });
  assert.ok(result.includes("Test Tool"));
  assert.ok(result.includes("key: value"));
  assert.ok(result.includes("All good"));
  // Should have divider lines
  assert.ok(/[\u2500]{2,}/.test(result));
});

test("formatToolCard includes warnings block", () => {
  const result = formatToolCard("Test", {
    warnings: ["Something is off"],
  });
  assert.ok(result.includes("Warnings:"));
  assert.ok(result.includes("Something is off"));
  assert.ok(result.includes("[!]"));
});

test("formatToolCard includes next actions block", () => {
  const result = formatToolCard("Test", {
    nextActions: ["Do this", "Do that"],
  });
  assert.ok(result.includes("Next:"));
  assert.ok(result.includes("> Do this"));
  assert.ok(result.includes("> Do that"));
});

test("formatToolCard includes truncation footer when provided", () => {
  const result = formatToolCard("Test", {
    truncation: { truncated: true, originalLines: 50, originalBytes: 5000, maxLines: 20, maxBytes: 2000 },
  });
  assert.ok(result.includes("truncated"));
  assert.ok(result.includes("50 lines"));
});

test("formatToolCard omits empty sections", () => {
  const result = formatToolCard("Minimal", {
    lines: ["  only this line"],
  });
  assert.ok(result.includes("only this line"));
  assert.ok(!result.includes("Warnings:"));
  assert.ok(!result.includes("Next:"));
  assert.ok(!result.includes("Diagnostics:"));
});

// =================================================================
// runtimeStatusCard
// =================================================================

test("runtimeStatusCard produces card with key fields", () => {
  const data = {
    pid: 12345,
    started_at: "2026-06-21T10:00:00.000Z",
    running_commit: null,
    worktree_dirty: false,
    dirty_paths: [],
    runtime_env_loaded: true,
    worker: {
      enabled: false,
      queue: { assigned: 0, running: 0 },
    },
    bark: { enabled: false },
    github: { api_sync_enabled: false, api_repo_set: false, api_token_set: false },
  };
  const card = runtimeStatusCard(data);
  assert.ok(card.includes("Runtime Status"), "title present");
  assert.ok(card.includes("12345"), "pid present");
  assert.ok(card.includes("clean"), "worktree clean");
  assert.ok(card.includes("disabled"), "worker disabled");
  assert.ok(card.includes("not configured"), "Bark not configured");
  assert.ok(/[\u2500]{2,}/.test(card), "has dividers");
});

test("runtimeStatusCard shows dirty worktree warning", () => {
  const data = {
    pid: 54321,
    started_at: "2026-06-21T10:00:00.000Z",
    running_commit: null,
    worktree_dirty: true,
    dirty_paths: ["M file1.js", "M file2.js"],
    runtime_env_loaded: false,
    worker: { enabled: true, queue: { assigned: 3 } },
    bark: { enabled: true },
    github: { api_sync_enabled: true, api_repo_set: true },
  };
  const card = runtimeStatusCard(data);
  assert.ok(card.includes("dirty"), "worktree dirty");
  assert.ok(card.includes("Diagnostics:"), "has diagnostics");
  assert.ok(card.includes("Dirty worktree"), "dirty warning");
});

test("runtimeStatusCard shows runtime env warning", () => {
  const data = {
    pid: 1,
    started_at: "2026-06-21T10:00:00.000Z",
    worktree_dirty: false,
    dirty_paths: [],
    runtime_env_loaded: false,
    worker: { enabled: false, queue: { assigned: 0 } },
    bark: { enabled: false },
    github: { api_sync_enabled: false, api_repo_set: false },
  };
  const card = runtimeStatusCard(data);
  assert.ok(card.includes("No runtime.env"), "runtime env warning");
  assert.ok(card.includes("Diagnostics:") || card.includes("Warnings:"), "has diagnostics section");
});

// =================================================================
// gptworkDoctorCard
// =================================================================

test("gptworkDoctorCard produces card with key fields", () => {
  const data = {
    pid: 9999,
    started_at: "2026-06-21T10:00:00.000Z",
    running_commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    worktree_dirty: false,
    dirty_paths: [],
    runtime_env_loaded: true,
    repository_registry_count: 2,
    repository_registry_has_canonical_repo: true,
    stale_clone_count: 0,
    github_api_sync_enabled: true,
    bark_configured: true,
    bark_enabled: true,
    worker: { enabled: true },
    suggested_next_actions: ["Commit changes"],
  };
  const card = gptworkDoctorCard(data);
  assert.ok(card.includes("GPTWork Doctor"), "title present");
  assert.ok(card.includes("9999"), "pid present");
  assert.ok(card.includes("a1b2c3d4e5f6"), "truncated commit");
  assert.ok(card.includes("loaded"), "env loaded");
  assert.ok(card.includes("Next:"), "has next actions");
  assert.ok(card.includes("> Commit changes"), "next action");
});

test("gptworkDoctorCard includes warnings for dirty worktree", () => {
  const data = {
    pid: 1,
    started_at: "2026-06-21T10:00:00.000Z",
    worktree_dirty: true,
    dirty_paths: ["M file.js"],
    runtime_env_loaded: true,
    repository_registry_count: 1,
    repository_registry_has_canonical_repo: true,
    stale_clone_count: 0,
    github_api_sync_enabled: true,
    bark_configured: false,
    worker: { enabled: false },
    suggested_next_actions: [],
  };
  const card = gptworkDoctorCard(data);
  assert.ok(card.includes("dirty"), "worktree dirty");
  assert.ok(card.includes("Diagnostics:") || card.includes("Warnings:"), "diagnostics present");
});

// =================================================================
// getTaskCard
// =================================================================

test("getTaskCard shows task fields", () => {
  const data = {
    task: {
      id: "task_123",
      title: "Test task",
      status: "completed",
      mode: "builder",
      assignee: "codex",
      created_at: "2026-06-20T10:00:00.000Z",
      updated_at: "2026-06-20T12:00:00.000Z",
      logs: [
        { time: "2026-06-20T11:00:00.000Z", message: "Started work" },
        { time: "2026-06-20T12:00:00.000Z", message: "Completed" },
      ],
      artifacts: [{ path: "/tmp/output.txt", label: "output" }],
      result: {
        summary: "Everything worked",
        changed_files: ["src/file1.js", "src/file2.js"],
        tests: "npm test: passed 10/10",
        commit: "abc123def456abc123def456abc123def456abc1",
        warnings: ["Test coverage low"],
      },
    },
  };
  const card = getTaskCard(data);
  assert.ok(card.includes("task_123"), "task id");
  assert.ok(card.includes("Test task"), "title");
  assert.ok(card.includes("completed"), "status");
  assert.ok(card.includes("Everything worked"), "result summary");
  assert.ok(card.includes("file1.js"), "changed file");
  assert.ok(card.includes("passed 10/10"), "tests");
  assert.ok(card.includes("Warnings:"), "has warnings");
  assert.ok(card.includes("Test coverage low"), "warning content");
});

test("getTaskCard handles task not found", () => {
  const data = { task: null };
  const card = getTaskCard(data);
  assert.ok(card.includes("Task not found"));
});

test("getTaskCard shows waiting_for_review warning", () => {
  const data = {
    task: {
      id: "task_456",
      title: "Review needed",
      status: "waiting_for_review",
      mode: "builder",
      assignee: "codex",
      logs: [],
      artifacts: [],
      result: {},
    },
  };
  const card = getTaskCard(data);
  assert.ok(card.includes("waiting_for_review"), "status shown");
  assert.ok(card.includes("needs review") || card.includes("Warnings:"), "warning present");
});

// =================================================================
// createEncodedGoalCard
// =================================================================

test("createEncodedGoalCard shows goal fields", () => {
  const data = {
    goal: {
      id: "goal_abc123",
      title: "My Goal",
      status: "assigned",
      mode: "builder",
      assignee: "codex",
      task_id: "task_def456",
    },
    workspace_files: { goal_md: ".gptwork/goals/goal_abc123/goal.md" },
    execution: { status: "completed", elapsed_ms: 500 },
  };
  const card = createEncodedGoalCard(data);
  assert.ok(card.includes("Goal Created"), "title");
  assert.ok(card.includes("goal_abc123"), "goal id");
  assert.ok(card.includes("def456"), "task id");
  assert.ok(card.includes("completed"), "execution status");
  assert.ok(card.includes("500ms"), "execution wait");
});

test("createEncodedGoalCard handles missing goal", () => {
  const data = { goal: null };
  const card = createEncodedGoalCard(data);
  assert.ok(card.includes("Goal not found"));
});

// =================================================================
// contextStatusCard
// =================================================================

test("contextStatusCard shows context fields", () => {
  const data = {
    workspace_root: "/home/user/workspace",
    default_repo_path: "/home/user/repo",
    project_md: { ok: true },
    project_env: { ok: true, keys: ["DB_HOST", "DB_PORT"] },
    context_source_precedence: [{}, {}, {}],
    warnings: [],
  };
  const card = contextStatusCard(data);
  assert.ok(card.includes("Context Status"), "title");
  assert.ok(card.includes("found"), "project.md found");
  assert.ok(card.includes("2 key(s)"), "env keys count");
});

test("contextStatusCard includes warnings", () => {
  const data = {
    workspace_root: "/tmp",
    warnings: [
      { severity: "warning", code: "missing_canonical_repo", message: "No canonical repo" },
    ],
  };
  const card = contextStatusCard(data);
  assert.ok(card.includes("Warnings:"), "has warnings");
  assert.ok(card.includes("No canonical repo"), "warning content");
});

// =================================================================
// githubStatusCard
// =================================================================

test("githubStatusCard shows GitHub sync fields", () => {
  const data = {
    enabled: true,
    repo: "owner/repo",
    known_issues: 5,
    last_sync_at: "2026-06-21T10:00:00.000Z",
  };
  const card = githubStatusCard(data);
  assert.ok(card.includes("GitHub Status"), "title");
  assert.ok(card.includes("enabled"), "sync status");
  assert.ok(card.includes("owner/repo"), "repo");
  assert.ok(card.includes("5"), "known issues");
});

test("githubStatusCard warns when disabled", () => {
  const data = {
    enabled: false,
    repo: "",
    known_issues: 0,
  };
  const card = githubStatusCard(data);
  assert.ok(card.includes("disabled"), "sync disabled");
  assert.ok(card.includes("Diagnostics:") || card.includes("Warnings:"), "diagnostics section");
});

// =================================================================
// truncateVerboseOutput (verbose output truncation test path)
// =================================================================

test("truncateVerboseOutput truncates long terminal output", () => {
  const longOutput = Array.from({ length: 50 }, (_, i) => `output line ${i + 1}`).join("\n");
  const result = truncateVerboseOutput(longOutput, 10, 8000);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLines, 50);
  assert.equal(result.maxLines, 10);
  assert.ok(result.text.includes("output line 1"));
  assert.ok(result.text.includes("output line 10"));
  assert.ok(!result.text.includes("output line 11"));
  assert.equal(result.full, longOutput);
});

test("truncateVerboseOutput preserves full output in 'full' field", () => {
  const output = "line1\nline2\nline3";
  const result = truncateVerboseOutput(output, 20, 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, output);
  assert.equal(result.full, output);
});

test("truncateVerboseOutput handles null input", () => {
  const result = truncateVerboseOutput(null, 20, 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "");
  assert.equal(result.full, null);
});

// =================================================================
// formatDiagnostics, formatWarnings, formatNextActions
// =================================================================

test("formatDiagnostics formats severity items", () => {
  const items = [
    { severity: "error", message: "Broken" },
    { severity: "warning", message: "Check this" },
    { severity: "info", message: "All good" },
  ];
  const result = formatDiagnostics(items);
  assert.ok(result.includes("[!!]"), "error indicator");
  assert.ok(result.includes("[--]"), "warning indicator");
  assert.ok(result.includes("[OK]"), "info indicator");
  assert.ok(result.includes("Broken"));
  assert.ok(result.includes("Check this"));
  assert.ok(result.includes("All good"));
});

test("formatWarnings returns empty for empty input", () => {
  assert.equal(formatWarnings([]), "");
  assert.equal(formatWarnings(null), "");
});

test("formatNextActions formats action strings", () => {
  const actions = ["Action one", "Action two"];
  const result = formatNextActions(actions);
  assert.ok(result.includes("> Action one"));
  assert.ok(result.includes("> Action two"));
});

test("formatNextActions returns empty for empty input", () => {
  assert.equal(formatNextActions([]), "");
  assert.equal(formatNextActions(null), "");
});



// =================================================================
// previewCodexContextCard
// =================================================================

test("previewCodexContextCard shows context fields", () => {
  const data = {
    context: {
      task: { id: "task_abc", title: "Test Task", status: "assigned", mode: "builder" },
      goal: { id: "goal_xyz", status: "assigned", title: "Test Goal" },
      workspace: { root: "/home/user/workspace", type: "hosted" },
      canonical_repo: { path: "/home/user/repo", record: { remote_url: "https://github.com/owner/repo" } },
      project_context: {
        project_md: { ok: true },
        project_env: { ok: true, keys: ["KEY1", "KEY2"] },
      },
      size_metrics: {
        transcript_bytes: 50000,
        transcript_size_label: "48.8 KB",
        transcript_message_count: 15,
        memory_count: 3,
      },
      warnings: [
        { severity: "warning", code: "dirty_worktree", message: "Uncommitted changes" },
      ],
    },
    actual_prompt_bytes: 80000,
    actual_prompt_warning: "Prompt is large",
  };
  const card = previewCodexContextCard(data);
  assert.ok(card.includes("Codex Context"), "title present");
  assert.ok(card.includes("task_abc"), "task id");
  assert.ok(card.includes("Test Task"), "task title");
  assert.ok(card.includes("goal_xyz"), "goal id");
  assert.ok(card.includes("48.8 KB"), "transcript size");
  assert.ok(card.includes("15 messages"), "message count");
  assert.ok(card.includes("3 memories"), "memory count");
  assert.ok(card.includes("Warnings:"), "has warnings");
  assert.ok(card.includes("Uncommitted changes"), "warning content");
  assert.ok(/[─]{2,}/.test(card), "has dividers");
});

test("previewCodexContextCard handles missing data", () => {
  const card = previewCodexContextCard(null);
  assert.ok(card.includes("No context data"));
});

test("previewCodexContextCard handles no linked task", () => {
  const data = { context: {} };
  const card = previewCodexContextCard(data);
  assert.ok(card.includes("not linked"));
});

// =================================================================
// shellExecCard
// =================================================================

test("shellExecCard shows shell fields", () => {
  const data = {
    command: "npm test",
    cwd: "/home/user/repo",
    returncode: 0,
    duration_ms: 5234,
    stdout_bytes: 15000,
    stderr_bytes: 0,
    stdout_truncated: true,
    stderr_truncated: false,
    timed_out: false,
    first_output_delay_ms: 120,
    stdout: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12",
    stderr: null,
  };
  const card = shellExecCard(data);
  assert.ok(card.includes("Shell Exec"), "title present");
  assert.ok(card.includes("npm test"), "command");
  assert.ok(card.includes("5234ms"), "duration");
  assert.ok(card.includes("yes"), "stdout truncated");
  assert.ok(card.includes("no"), "stderr truncated");
  assert.ok(card.includes("Warnings:"), "has warnings");
});

test("shellExecCard truncates long stdout preview", () => {
  const longOut = Array.from({ length: 50 }, (_, i) => `output line ${i + 1}`).join("\n");
  const data = {
    command: "make build",
    cwd: "/tmp",
    returncode: 0,
    duration_ms: 1000,
    stdout_bytes: 5000,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: false,
    stdout: longOut,
  };
  const card = shellExecCard(data);
  assert.ok(card.includes("stdout (first 10 of 50 lines)"), "truncation label");
  assert.ok(card.includes("output line 1"), "first line");
  assert.ok(!card.includes("output line 20"), "not beyond 10");
});

test("shellExecCard handles null data", () => {
  const card = shellExecCard(null);
  assert.ok(card.includes("No data"));
});

test("shellExecCard shows timed out warning", () => {
  const data = {
    command: "sleep 100",
    cwd: "/tmp",
    returncode: -1,
    duration_ms: 30000,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: true,
    stdout: null,
    stderr: null,
  };
  const card = shellExecCard(data);
  assert.ok(card.includes("timed out"), "timed out info");
  assert.ok(card.includes("Command timed out"), "timeout warning");
});

// =================================================================
// gitRemoteDiffCard
// =================================================================

test("gitRemoteDiffCard shows diff fields", () => {
  const data = {
    ok: true,
    base: "HEAD",
    head: "origin/main",
    path: "src/file.js",
    bytes: 50000,
    truncated: true,
    diff: "--- a/src/file.js\n+++ b/src/file.js\n@@ -1,5 +1,6 @@\n line 1\n line 2",
  };
  const card = gitRemoteDiffCard(data);
  assert.ok(card.includes("Git Diff"), "title present");
  assert.ok(card.includes("HEAD"), "base");
  assert.ok(card.includes("origin/main"), "head");
  assert.ok(card.includes("src/file.js"), "path");
  assert.ok(card.includes("50000"), "bytes");
  assert.ok(card.includes("yes"), "truncated");
  assert.ok(card.includes("Warnings:"), "has warnings");
  assert.ok(card.includes("truncated"), "truncation warning");
});

test("gitRemoteDiffCard handles error case", () => {
  const data = { ok: false, error: "Repository not found." };
  const card = gitRemoteDiffCard(data);
  assert.ok(card.includes("Repository not found"));
});

test("gitRemoteDiffCard handles null data", () => {
  const card = gitRemoteDiffCard(null);
  assert.ok(card.includes("No diff data"));
});

// =================================================================
// readTextFileCard
// =================================================================

test("readTextFileCard shows file fields", () => {
  const data = {
    path: "/home/user/file.txt",
    size: 100000,
    truncated: true,
    content: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
  };
  const card = readTextFileCard(data);
  assert.ok(card.includes("Read File"), "title present");
  assert.ok(card.includes("file.txt"), "path");
  assert.ok(card.includes("100000 bytes"), "size");
  assert.ok(card.includes("yes"), "truncated");
  assert.ok(card.includes("Warnings:"), "has warnings");
  assert.ok(card.includes("truncated"), "truncation warning");
});

test("readTextFileCard shows truncated warning", () => {
  const data = {
    path: "/tmp/big.txt",
    size: 50000,
    truncated: true,
    content: "short content here",
  };
  const card = readTextFileCard(data);
  assert.ok(card.includes("truncated"), "truncated flag");
  assert.ok(card.includes("50000 bytes"), "size display");
  assert.ok(card.includes("Warnings:"), "has warnings");
});

test("readTextFileCard handles null", () => {
  const card = readTextFileCard(null);
  assert.ok(card.includes("No data"));
});

// =================================================================
// listDirCard
// =================================================================

test("listDirCard shows directory fields", () => {
  const data = {
    path: "/home/user",
    recursive: true,
    count: 150,
    limit: 100,
    items: Array.from({ length: 100 }, (_, i) => ({ name: `file${i}.js`, type: "file", size: 100 })),
  };
  const card = listDirCard(data);
  assert.ok(card.includes("List Dir"), "title present");
  assert.ok(card.includes("150"), "count");
  assert.ok(card.includes("100"), "limit");
  assert.ok(card.includes("yes"), "truncated");
  assert.ok(card.includes("Warnings:"), "has warnings");
});

test("listDirCard handles empty listing", () => {
  const data = { path: "/tmp", recursive: false, count: 0, limit: 500, items: [] };
  const card = listDirCard(data);
  assert.ok(card.includes("0"), "count zero");
  assert.ok(!card.includes("Warnings:"), "no warnings");
});

test("listDirCard handles null", () => {
  const card = listDirCard(null);
  assert.ok(card.includes("No data"));
});

// =================================================================
// goalContextCard
// =================================================================

test("goalContextCard shows goal fields without dumping transcript", () => {
  const data = {
    goal: {
      id: "goal_123",
      title: "My Goal",
      status: "assigned",
      mode: "deploy",
      task_id: "task_456",
      project_id: "default",
      workspace_id: "hosted-default",
    },
    conversation: {
      messages: Array.from({ length: 25 }, () => ({ role: "codex", content: "message text" })),
    },
    memories: [{ id: "mem1" }, { id: "mem2" }, { id: "mem3" }],
    task: { id: "task_456", status: "assigned" },
    workspace_files: { goal_md: ".gptwork/goals/goal_123/goal.md" },
    codex_instruction: "Follow the goal.md exactly.",
  };
  const card = goalContextCard(data);
  assert.ok(card.includes("Goal Context"), "title present");
  assert.ok(card.includes("goal_123"), "goal id");
  assert.ok(card.includes("My Goal"), "title");
  assert.ok(card.includes("25"), "message count");
  assert.ok(card.includes("3"), "memory count");
  assert.ok(card.includes("task_456"), "task id");
  assert.ok(card.includes("instruction:"), "instruction shown");
  // Ensure no full transcript dump
  assert.ok(!card.includes("message text"), "no message content dumped");
});

test("goalContextCard handles missing goal", () => {
  const data = { goal: null };
  const card = goalContextCard(data);
  assert.ok(card.includes("Goal not found"));
});

test("goalContextCard handles missing conversation/memories", () => {
  const data = { goal: { id: "goal_xyz", title: "test", status: "completed" } };
  const card = goalContextCard(data);
  // Should not crash, should show basic info
  assert.ok(card.includes("completed"), "status shown");
  assert.ok(!card.includes("undefined"), "no undefined in output");
});

console.log("card-utils tests loaded");
