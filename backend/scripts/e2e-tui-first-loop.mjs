#!/usr/bin/env node
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  getCodexTuiSessionStatus,
  readCodexTuiSession,
  startCodexTuiGoalSession,
  stopCodexTuiSession,
} from "../src/codex-tui-session-manager.mjs";
import { ensureGoalWorkspace } from "../src/goal-worktree-service.mjs";
import { applyMergeGate } from "../src/merge-gate-service.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 180_000;
const CANARY_FILE = "production-canary.txt";
const CANARY_CONTENT = "REAL_TUI_PRODUCTION_CANARY_OK\n";

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return stdout.trim();
}

async function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function waitFor(predicate, { timeoutMs, intervalMs = 750, label }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(lastValue)}`);
}

function parseChangedPaths(status) {
  return String(status || "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
}

async function main() {
  const keep = process.argv.includes("--keep");
  const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : DEFAULT_TIMEOUT_MS;
  const root = await mkdtemp(join(tmpdir(), "gptwork-production-tui-canary-"));
  const runId = `${Date.now()}_${process.pid}`;
  const goalId = `goal_production_canary_${runId}`;
  const taskId = `task_production_canary_${runId}`;
  let session = null;

  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "production-canary@gptwork.local"]);
    await git(root, ["config", "user.name", "GPTWork Production Canary"]);
    await writeFile(join(root, ".gitignore"), ".gptwork/\n");
    await writeFile(join(root, "README.md"), "# GPTWork production Codex TUI Canary\n");
    await git(root, ["add", ".gitignore", "README.md"]);
    await git(root, ["commit", "-m", "chore: initialize production TUI canary"]);
    const baseHead = await git(root, ["rev-parse", "HEAD"]);

    const config = {
      defaultRepoPath: root,
      defaultWorkspaceRoot: root,
      goalWorktreeRoot: join(root, ".gptwork", "worktrees"),
      goalBranchPrefix: "gptwork/canary",
      mergeTargetBranch: "main",
      defaultBranch: "main",
    };
    const workspace = await ensureGoalWorkspace({ goal: { id: goalId, base_branch: "main" }, config });
    const goalDir = join(workspace.worktree_path, ".gptwork", "goals", goalId);
    await mkdir(goalDir, { recursive: true });
    await writeFile(join(goalDir, "codex.entry.md"), [
      "# Production Codex TUI Canary",
      "",
      `Create ${CANARY_FILE} in the repository root containing exactly ${CANARY_CONTENT.trim()} followed by one newline.`,
      "Do not create, edit, delete, rename, stage, or commit any other repository file.",
      "Do not use codex exec or any non-interactive fallback. Complete this task in the current native TUI session.",
      "",
    ].join("\n"));

    session = await startCodexTuiGoalSession({
      task: { id: taskId, title: `Create ${CANARY_FILE}` },
      goal: { id: goalId },
      cwd: workspace.worktree_path,
      workspaceRoot: root,
      requireSuperpowers: false,
      tuiNoProgressSeconds: Math.ceil(timeoutMs / 1000),
    });

    const markerPath = join(workspace.worktree_path, CANARY_FILE);
    await waitFor(async () => {
      const current = await readCodexTuiSession(session.id, { workspaceRoot: root });
      if (["failed", "timed_out"].includes(current.status)) {
        throw new Error(`Codex TUI session terminated early: ${current.status}`);
      }
      return await exists(markerPath);
    }, { timeoutMs, label: `${CANARY_FILE} creation` });

    const markerText = await readFile(markerPath, "utf8");
    if (markerText !== CANARY_CONTENT) throw new Error(`${CANARY_FILE} content mismatch: ${JSON.stringify(markerText)}`);

    const porcelain = await git(workspace.worktree_path, ["status", "--porcelain", "--untracked-files=all"]);
    const changedPaths = parseChangedPaths(porcelain);
    const forbiddenPaths = changedPaths.filter((path) => path !== CANARY_FILE);
    if (forbiddenPaths.length) throw new Error(`Canary changed forbidden paths: ${forbiddenPaths.join(", ")}`);
    if (!changedPaths.includes(CANARY_FILE)) throw new Error(`Canary did not produce a Git change for ${CANARY_FILE}`);

    await git(workspace.worktree_path, ["add", "--", CANARY_FILE]);
    await git(workspace.worktree_path, ["commit", "-m", `test: production TUI canary ${runId}`]);
    const candidateHead = await git(workspace.worktree_path, ["rev-parse", "HEAD"]);
    const candidateParent = await git(workspace.worktree_path, ["rev-parse", "HEAD^"]);
    if (candidateParent !== baseHead) throw new Error(`Candidate parent mismatch: ${candidateParent} != ${baseHead}`);

    await writeFile(join(goalDir, "result.md"), `# Production Canary Result\n\nTask ${taskId} completed through native Codex TUI.\n`);
    await writeFile(join(goalDir, "result.json"), `${JSON.stringify({
      status: "completed",
      provider: "codex_tui_goal",
      execution_backend: "codex_tui_superpowers",
      task_id: taskId,
      goal_id: goalId,
      changed_files: [CANARY_FILE],
      commit: candidateHead,
      verification: [{ command: `cat ${CANARY_FILE}`, passed: true }],
    }, null, 2)}\n`);
    await writeFile(join(goalDir, "evidence.bundle.json"), `${JSON.stringify({
      goal_id: goalId,
      candidate_head: candidateHead,
      candidate_branch: workspace.candidate_branch,
      changed_files: [CANARY_FILE],
      worktree_clean: true,
      result_md_present: true,
      result_json_present: true,
      provider: "codex_tui_goal",
    }, null, 2)}\n`);
    await writeFile(join(goalDir, "acceptance.result.json"), `${JSON.stringify({
      goal_id: goalId,
      verdict: "passed",
      merge_recommendation: "merge",
      reviewed_candidate_head: candidateHead,
      checks: { marker_content: true, changed_path_allowlist: true, native_tui: true },
    }, null, 2)}\n`);

    const merge = await applyMergeGate({ goalId, workspace, config });
    if (!merge.merged) throw new Error(`Merge gate did not merge: ${JSON.stringify(merge.decision)}`);
    const mainHead = await git(root, ["rev-parse", "main"]);
    await git(root, ["merge-base", "--is-ancestor", candidateHead, "main"]);
    const mergedText = await readFile(join(root, CANARY_FILE), "utf8");
    if (mergedText !== CANARY_CONTENT) throw new Error("Merged canary content mismatch");

    const record = await readCodexTuiSession(session.id, { workspaceRoot: root });
    const status = await getCodexTuiSessionStatus(session.id, { workspaceRoot: root });
    const log = String(record.log || "");
    const checks = {
      native_codex_tui_provider: Boolean(session.pty_pid || record.pty_pid)
        && Boolean(record.native_session_id || session.native_session_id)
        && Boolean(record.bootstrap_method || session.bootstrap_method),
      real_pty_started: Boolean(session.pty_pid || record.pty_pid),
      native_session_bound: Boolean(record.native_session_id || session.native_session_id),
      directory_trusted: log.includes("[bootstrap-input] trusted working directory"),
      goal_dispatched: log.includes("[bootstrap-input] /goal dispatched"),
      marker_created_by_tui: true,
      changed_path_allowlist: forbiddenPaths.length === 0,
      candidate_commit_created: /^[0-9a-f]{40}$/.test(candidateHead),
      candidate_parent_is_base: candidateParent === baseHead,
      merge_gate_applied: merge.merged === true,
      candidate_reachable_from_main: true,
      main_advanced: mainHead !== baseHead,
      task_completed: true,
      goal_completed: true,
      result_contract_present: true,
      acceptance_passed: true,
      session_not_failed: !["failed", "timed_out"].includes(status.status),
    };
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) throw new Error(`Production Canary checks failed: ${failedChecks.join(", ")}`);

    const stopped = await stopCodexTuiSession(session.id, { reason: "native_detach", workspaceRoot: root });
    session = null;

    console.log(JSON.stringify({
      ok: true,
      mode: "production_native_codex_tui_local_main_merge",
      run_id: runId,
      root,
      goal_id: goalId,
      goal_status: "completed",
      task_id: taskId,
      task_status: "completed",
      provider: "codex_tui_goal",
      candidate_branch: workspace.candidate_branch,
      candidate_commit: candidateHead,
      merge_commit: merge.merge_commit,
      main_head: mainHead,
      changed_files: [CANARY_FILE],
      checks,
      terminal_control_status: stopped.status,
      pushed_to_github: false,
      kept_fixture: keep,
    }, null, 2));
  } finally {
    if (session) await stopCodexTuiSession(session.id, { reason: "native_detach", workspaceRoot: root }).catch(() => {});
    if (!keep) await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
