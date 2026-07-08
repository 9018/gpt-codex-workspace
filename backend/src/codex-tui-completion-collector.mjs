import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";

function gitLines(cwd, args) {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function changedFilesFromStatus(statusLines) {
  const files = new Set();
  for (const line of statusLines) {
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const renamed = pathPart.split(" -> ").at(-1);
    files.add(renamed);
  }
  return [...files].sort();
}

function isInternalEvidencePath(path) {
  return path === ".gptwork" || path.startsWith(".gptwork/");
}

function extractFirstLineValue(text, labels) {
  for (const line of String(text || "").split(/\r?\n/)) {
    for (const label of labels) {
      const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "i");
      const match = line.match(re);
      if (match) return match[1].trim() || null;
    }
  }
  return null;
}

function resultMarkdownEvidence(text) {
  return {
    tests: extractFirstLineValue(text, ["tests", "test evidence", "verification"]),
    commit: extractFirstLineValue(text, ["commit"]),
  };
}

export async function collectCodexTuiCompletion({ sessionId, workspaceRoot } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!workspaceRoot) throw new Error("workspaceRoot is required");

  const store = createCodexTuiSessionStore({ workspaceRoot });
  const session = await store.readSession(sessionId, { maxChars: 0 });
  const cwd = session.cwd || workspaceRoot;
  const goalId = session.goal_id || null;
  const taskId = session.task_id || null;
  const resultMdPath = goalId ? join(workspaceRoot, ".gptwork", "goals", goalId, "result.md") : null;
  const resultMdPresent = resultMdPath ? await fileExists(resultMdPath) : false;
  const resultMdText = resultMdPresent ? await readFile(resultMdPath, "utf8") : "";
  const resultEvidence = resultMarkdownEvidence(resultMdText);

  const statusLines = gitLines(cwd, ["status", "--short"]);
  const statusChangedFiles = changedFilesFromStatus(statusLines);
  const diffFiles = gitLines(cwd, ["diff", "--name-only"]);
  const changedFiles = [...new Set([...statusChangedFiles, ...diffFiles].filter((path) => !isInternalEvidencePath(path)))].sort();
  const worktreeClean = changedFiles.length === 0;
  const commit = session.commit || session.metadata?.commit || resultEvidence.commit || null;
  const tests = session.tests || session.metadata?.tests || resultEvidence.tests || null;

  const findings = [];
  if (!resultMdPresent) {
    findings.push({ code: "result_md_missing", severity: "blocker", message: "result.md is not present for the TUI goal." });
  }
  if (!worktreeClean) {
    findings.push({ code: "dirty_worktree", severity: "blocker", message: "The TUI worktree has uncommitted changes." });
  }
  if (!commit && !worktreeClean) {
    findings.push({ code: "commit_missing", severity: "blocker", message: "Dirty work exists but no durable commit evidence was found." });
  }

  return {
    kind: "codex_tui_completion_snapshot",
    session_id: session.id,
    goal_id: goalId,
    task_id: taskId,
    changed_files: changedFiles,
    tests,
    commit,
    result_md_present: resultMdPresent,
    worktree_clean: worktreeClean,
    ready_for_review: resultMdPresent && worktreeClean && Boolean(commit) && findings.length === 0,
    findings,
  };
}

/**
 * Normalize raw TUI evidence into a structured evidence object with clear
 * evidence_ready semantics. Major findings (missing result.json) mean
 * evidence_ready=false; minor findings (missing result.md) are non-blocking.
 */
export function normalizeCodexTuiEvidence({ sessionId, goalId, resultJson, resultMd, gitEvidence } = {}) {
  const findings = [];

  if (!resultJson) {
    findings.push({
      severity: "major",
      code: "tui_result_json_missing",
      message: "Codex TUI did not write result.json.",
    });
  }

  if (!resultMd) {
    findings.push({
      severity: "minor",
      code: "tui_result_md_missing",
      message: "Codex TUI did not write result.md.",
    });
  }

  const tests = resultJson?.tests || resultJson?.verification?.commands || null;
  const commit = resultJson?.commit || gitEvidence?.commit || "none";
  const changedFiles = Array.isArray(resultJson?.changed_files)
    ? resultJson.changed_files
    : (gitEvidence?.changed_files || []);

  return {
    kind: "codex_tui_evidence",
    provider: "codex_tui_goal",
    execution_backend: "codex_tui_superpowers",
    session_id: sessionId,
    goal_id: goalId,
    evidence_ready: findings.every((f) => f.severity !== "major"),
    changed_files: changedFiles,
    tests,
    commit,
    verification: {
      passed: findings.every((f) => f.severity !== "major") && Boolean(tests),
      findings,
    },
  };
}
