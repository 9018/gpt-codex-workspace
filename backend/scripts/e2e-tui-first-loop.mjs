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

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function waitFor(predicate, { timeoutMs, intervalMs = 500, label }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(lastValue)}`);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : DEFAULT_TIMEOUT_MS;
  const root = await mkdtemp(join(tmpdir(), "gptwork-real-tui-e2e-"));
  const goalId = `goal_real_e2e_${Date.now()}`;
  const taskId = `task_real_e2e_${Date.now()}`;
  let session = null;

  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "e2e@example.com"]);
    await git(root, ["config", "user.name", "GPTWork E2E"]);
    await writeFile(join(root, "README.md"), "# real Codex TUI E2E\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "chore: initialize real TUI e2e fixture"]);

    const goalDir = join(root, ".gptwork", "goals", goalId);
    await mkdir(goalDir, { recursive: true });
    await writeFile(join(goalDir, "codex.entry.md"), [
      "# Real Codex TUI E2E",
      "",
      "Create marker.txt in the repository root containing exactly REAL_TUI_E2E_OK followed by a newline.",
      `Write ${join(".gptwork", "runtime-goals", goalId, "result.json")} with status=completed, changed_files including marker.txt, and verification evidence.`,
      `Write ${join(".gptwork", "runtime-goals", goalId, "result.md")} with a concise completion summary.`,
      "Do not modify any other repository files.",
      "",
    ].join("\n"));

    session = await startCodexTuiGoalSession({
      task: { id: taskId, title: "Create marker.txt containing REAL_TUI_E2E_OK" },
      goal: { id: goalId },
      cwd: root,
      workspaceRoot: root,
      requireSuperpowers: false,
      tuiNoProgressSeconds: Math.ceil(timeoutMs / 1000),
    });

    const markerPath = join(root, "marker.txt");
    await waitFor(async () => {
      const markerPresent = await exists(markerPath);
      const current = await readCodexTuiSession(session.id, { workspaceRoot: root });
      if (current.status === "failed" || current.status === "timed_out") {
        throw new Error(`Codex TUI session terminated early: ${current.status}`);
      }
      return markerPresent;
    }, { timeoutMs, label: "marker.txt creation" });

    const markerText = await readFile(markerPath, "utf8");
    if (markerText !== "REAL_TUI_E2E_OK\n") {
      throw new Error(`marker.txt content mismatch: ${JSON.stringify(markerText)}`);
    }

    const record = await readCodexTuiSession(session.id, { workspaceRoot: root });
    const status = await getCodexTuiSessionStatus(session.id, { workspaceRoot: root });
    const log = String(record.log || "");
    const checks = {
      real_pty_started: Boolean(session.pty_pid || record.pty_pid),
      directory_trusted: log.includes("[bootstrap-input] trusted working directory"),
      goal_dispatched: log.includes("[bootstrap-input] /goal dispatched"),
      goal_acknowledged: session.goal_dispatch_evidence?.ack_received === true,
      marker_created: true,
      marker_content_valid: markerText === "REAL_TUI_E2E_OK\n",
      session_not_failed: !["failed", "timed_out"].includes(status.status),
    };

    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) throw new Error(`E2E checks failed: ${failedChecks.join(", ")}`);

    const stopped = await stopCodexTuiSession(session.id, {
      reason: "native_detach",
      workspaceRoot: root,
    });
    session = null;

    const report = {
      ok: true,
      mode: "real_codex_tui",
      root,
      goal_id: goalId,
      task_id: taskId,
      checks,
      terminal_control_status: stopped.status,
      kept_fixture: keep,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (session) {
      await stopCodexTuiSession(session.id, { reason: "native_detach", workspaceRoot: root }).catch(() => {});
    }
    if (!keep) await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
