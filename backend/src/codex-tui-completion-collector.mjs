/**
 * codex-tui-completion-collector.mjs — Collect durable completion evidence
 * from a Codex TUI session. Git evidence is read from the isolated task
 * worktree, while canonical goal artifacts are resolved from the workspace
 * root with a worktree-local fallback for backwards compatibility.
 */

import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createCodexTuiSessionStore } from "./codex-tui-session-store.mjs";
import { codexTuiGoalArtifactCandidates, firstExistingArtifactPath, firstMatchingJsonArtifact } from "./codex-tui/result-locator.mjs";

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

function parseResultJson(text) {
  if (!text) return { value: null, error: null };
  try {
    return { value: JSON.parse(text), error: null };
  } catch (err) {
    return { value: null, error: err?.message || "invalid JSON" };
  }
}

/**
 * Terminalize a TUI session when durable result artifacts exist but session
 * is still marked active/created. This is idempotent.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {string} params.sessionId - TUI session ID
 * @param {object} params.session - Current session record
 * @returns {Promise<{ terminalized: boolean, session: object|null }>}
 */
export async function terminalizeTuiSession({ workspaceRoot, sessionId, session } = {}) {
  if (!workspaceRoot || !sessionId) return { terminalized: false, session };
  if (!session || session.status === "stopped" || session.status === "failed" || session.status === "completed") {
    return { terminalized: false, session };
  }
  const goalId = session.goal_id;
  if (!goalId) return { terminalized: false, session };
  const resultJsonPath = join(workspaceRoot, ".gptwork", "goals", goalId, "result.json");
  if (!existsSync(resultJsonPath)) return { terminalized: false, session };
  try {
    const raw = await readFile(resultJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const isTerminal = parsed.status === "completed" || parsed.status === "failed" || parsed.status === "timed_out";
    if (!isTerminal) return { terminalized: false, session };
    const { createCodexTuiSessionStore } = await import("./codex-tui-session-store.mjs");
    const store = createCodexTuiSessionStore({ workspaceRoot });
    const updated = await store.updateSession(sessionId, {
      status: parsed.status === "completed" ? "stopped" : "failed",
      active: false,
      terminalized_at: new Date().toISOString(),
      terminalize_reason: "durable_result_found",
      durable_result_status: parsed.status,
    });
    return { terminalized: true, session: updated };
  } catch {
    return { terminalized: false, session };
  }
}

/**
 * Collect completion evidence from a Codex TUI session.
 *
 * Always checks git status and result files from the session's cwd
 * (task worktree path), not the canonical repository root.
 *
 * @param {object} params
 * @param {string} params.sessionId - TUI session ID
 * @param {string} [params.workspaceRoot] - Workspace root (fallback for goal dir)
 * @returns {Promise<object>} Completion snapshot
 */
export async function collectCodexTuiCompletion({ sessionId, workspaceRoot } = {}) {
  if (!sessionId) throw new Error("sessionId is required");

  // Read session to get cwd (worktree path) and goal_id
  let session, cwd, goalId, taskId;
  const root = workspaceRoot || process.cwd();

  if (workspaceRoot) {
    const store = createCodexTuiSessionStore({ workspaceRoot: root });
    try {
      session = await store.readSession(sessionId, { maxChars: 0 });
    } catch {
      // Fall back to workspace root as cwd
      session = { cwd: root };
    }
  } else {
    // Try candidate roots
    for (const candidateRoot of [process.cwd(), join(process.cwd(), "..")]) {
      try {
        const store = createCodexTuiSessionStore({ workspaceRoot: candidateRoot });
        session = await store.readSession(sessionId, { maxChars: 0 });
        break;
      } catch {}
    }
    if (!session) {
      // Fall back entirely
      session = { cwd: process.cwd(), goal_id: null, task_id: null };
    }
  }

  cwd = session.cwd || root;
  goalId = session.goal_id || null;
  taskId = session.task_id || null;

  // Goal artifacts are canonical workspace state. TUI sessions execute in an
  // isolated worktree, but codex.entry.md instructs agents to write results to
  // <workspaceRoot>/.gptwork/goals/<goalId>. Keep a worktree-local fallback so
  // older sessions remain collectible.
  const canonicalGoalDir = goalId ? join(root, ".gptwork", "goals", goalId) : null;
  const resultJsonCandidates = codexTuiGoalArtifactCandidates({ workspaceRoot: root, cwd, goalId, filename: "result.json" });
  const terminalJson = await firstMatchingJsonArtifact(resultJsonCandidates, (value) =>
    ["completed", "failed", "timed_out", "verified"].includes(value?.status));
  const resultJsonPath = terminalJson?.path || await firstExistingArtifactPath(resultJsonCandidates);
  const resultMdCandidates = codexTuiGoalArtifactCandidates({ workspaceRoot: root, cwd, goalId, filename: "result.md" });
  const preferredResultMdPath = terminalJson?.path?.endsWith("/result.json")
    ? terminalJson.path.slice(0, -"result.json".length) + "result.md"
    : null;
  const resultMdPath = preferredResultMdPath && await fileExists(preferredResultMdPath)
    ? preferredResultMdPath
    : await firstExistingArtifactPath(resultMdCandidates);
  const resultJsonPresent = resultJsonPath ? await fileExists(resultJsonPath) : false;
  const resultMdPresent = resultMdPath ? await fileExists(resultMdPath) : false;
  const resultJsonText = resultJsonPresent ? await readFile(resultJsonPath, "utf8") : "";
  const resultMdText = resultMdPresent ? await readFile(resultMdPath, "utf8") : "";
  const parsedResultJson = parseResultJson(resultJsonText);
  const resultEvidence = resultMarkdownEvidence(resultMdText);
  const acceptanceContractPath = canonicalGoalDir ? join(canonicalGoalDir, "acceptance.contract.json") : null;
  let acceptanceContract = null;
  if (acceptanceContractPath && await fileExists(acceptanceContractPath)) {
    try {
      acceptanceContract = JSON.parse(await readFile(acceptanceContractPath, "utf8"));
    } catch {}
  }
  const requiresCommit = acceptanceContract?.requirements?.requires_commit
    ?? acceptanceContract?.requires_commit
    ?? true;

  // Git status from the session cwd (task worktree)
  const statusLines = gitLines(cwd, ["status", "--short"]);
  const statusChangedFiles = changedFilesFromStatus(statusLines);
  const diffFiles = gitLines(cwd, ["diff", "--name-only"]);
  const changedFiles = [...new Set([...statusChangedFiles, ...diffFiles].filter((path) => !isInternalEvidencePath(path)))].sort();
  const worktreeClean = changedFiles.length === 0;
  const commit = session.commit || session.metadata?.commit || parsedResultJson.value?.commit || resultEvidence.commit || null;
  const tests = session.tests || session.metadata?.tests || parsedResultJson.value?.tests || parsedResultJson.value?.verification?.commands || resultEvidence.tests || null;

  const findings = [];
  if (!resultMdPresent) {
    findings.push({ code: "result_md_missing", severity: "blocker", message: "result.md is not present for the TUI goal." });
  }
  if (resultJsonPresent && parsedResultJson.error) {
    findings.push({ code: "result_json_invalid", severity: "blocker", message: parsedResultJson.error });
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
    task_context_digest: session.task_context_digest || null,
    task_context_revision: session.task_context_revision || null,
    cwd,
    changed_files: changedFiles,
    tests,
    commit,
    result_json: parsedResultJson.value,
    result_json_present: resultJsonPresent,
    result_json_valid: resultJsonPresent ? !parsedResultJson.error : false,
    result_json_error: parsedResultJson.error,
    result_json_path: resultJsonPath,
    result_md_present: resultMdPresent,
    result_md_path: resultMdPath,
    worktree_clean: worktreeClean,
    requires_commit: requiresCommit === true,
    ready_for_review: resultMdPresent
      && worktreeClean
      && (requiresCommit === false ? (resultJsonPresent && !parsedResultJson.error) : Boolean(commit))
      && findings.length === 0,
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
