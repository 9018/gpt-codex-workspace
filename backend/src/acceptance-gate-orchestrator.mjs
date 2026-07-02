/**
 * acceptance-gate-orchestrator.mjs — Independent Acceptance Gate Orchestrator.
 *
 * Ties verification + judgment into a single standalone acceptance gate flow:
 *
 *   result.json → [ Independent Verifier ] → verification.json
 *                                             ↓
 *   verification.json + contract → [ Judgment Module ] → acceptance.json
 *
 * The orchestrator can run as a standalone tool call from scripts, agents,
 * or automated pipelines. It is designed to be backward compatible with
 * the existing acceptance gate engine (acceptance-gate-engine.mjs) by
 * producing equivalent artifacts (verification.json, acceptance.json) in
 * the same locations.
 *
 * G5 dependency: compatible with G4 context curator manifest paths for
 * locating goal workspace directories.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";

import { runIndependentVerification } from "./independent-verifier.mjs";
import { judgeAcceptance, mapJudgmentToTaskStatus, judgmentAllowsAutoComplete } from "./acceptance-judgment.mjs";
import {
  createAcceptanceResult,
  writeAcceptanceResultFile,
} from "./acceptance-result-file.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the independent acceptance gate on a task result.
 *
 * This is the main entry point for the G5 acceptance gate. It:
 * 1. Runs independent verification (or accepts a pre-computed verification result)
 * 2. Makes a three-way acceptance judgment (accepted / failed / needs_continue)
 * 3. Writes verification.json and acceptance.json artifacts
 * 4. Returns a structured gate result with judgment, rationale, and artifacts
 *
 * @param {object} options
 * @param {object} [options.result] — Task result object
 * @param {string} [options.resultJsonPath] — Path to result.json
 * @param {object} [options.goal] — Goal object (for contract and metadata)
 * @param {object} [options.task] — Task object
 * @param {string} [options.repoPath] — Git repository path for evidence
 * @param {object} [options.verification] — Pre-computed verification result (skip re-verification)
 * @param {object} [options.contract] — Acceptance contract (overrides goal.acceptance_contract)
 * @param {Array<string>} [options.verificationCommands] — Explicit verifier commands
 * @param {object} [options.config] — Configuration overrides
 * @param {boolean} [options.writeArtifacts=true] — Whether to write result files
 * @param {string|null} [options.outputDir] — Custom output directory
 * @returns {Promise<object>}
 */
export async function runIndependentGate({
  result = null,
  resultJsonPath = null,
  goal = {},
  task = {},
  repoPath = null,
  verification = null,
  contract = null,
  verificationCommands = null,
  config = {},
  writeArtifacts = true,
  outputDir = null,
} = {}) {
  const timestamp = typeof config.now === "function" ? config.now() : new Date().toISOString();

  // Determine result directory
  const resultDir = outputDir || (resultJsonPath ? dirname(resultJsonPath) : null);

  // Load result if not provided
  let taskResult = result;
  if (!taskResult && resultJsonPath) {
    try {
      taskResult = await readJsonFile(resultJsonPath);
    } catch {
      taskResult = { status: "failed", summary: "Unable to load result.json" };
    }
  }
  if (!taskResult) taskResult = { status: "unknown", summary: "No result data provided" };

  // Load contract (from options, goal, or file)
  const acceptanceContract = contract || (goal?.acceptance_contract) || null;

  // --- Step 1: Run verification (or accept pre-computed)
  let verificationResult = verification;
  let verificationFilePath = null;

  if (!verificationResult) {
    const verifierOut = await runIndependentVerification({
      result: taskResult,
      resultJsonPath,
      goal,
      task,
      repoPath,
      verificationCommands,
      config,
      writeResultFile: writeArtifacts,
      outputDir: resultDir,
    });
    verificationResult = verifierOut.verification;
    verificationFilePath = verifierOut.result_file_path;
  } else {
    verificationFilePath = resultDir ? join(resultDir, "verification.json") : null;
    if (writeArtifacts && verificationFilePath) {
      const { writeVerificationResultFile } = await import("./verification-result-file.mjs");
      await writeVerificationResultFile(verificationFilePath, verificationResult);
    }
  }

  // --- Step 2: Make acceptance judgment
  const judgment = judgeAcceptance({
    verificationResult,
    contract: acceptanceContract,
    result: taskResult,
    task,
    goal,
  });

  // --- Step 3: Determine closure info
  const taskStatus = mapJudgmentToTaskStatus(judgment);
  const autoCompleteAllowed = judgmentAllowsAutoComplete(judgment);

  // --- Step 4: Build and write acceptance result
  const acceptanceResult = createAcceptanceResult({
    judgment: judgment.judgment,
    rationale: judgment.rationale,
    blockers: judgment.blockers,
    followups: judgment.followups,
    verification: verificationResult,
    judgment_detail: judgment,
    closure_decision: {
      status: judgment.judgment === "accepted"
        ? "auto_completed_clean"
        : (judgment.judgment === "failed" ? "failed" : "waiting_for_review"),
      auto_complete_allowed: autoCompleteAllowed,
      task_status: taskStatus,
      reason: judgment.rationale,
    },
    contract_summary: judgment.contract_summary,
    metadata: {
      independent_gate: true,
      verification_artifact: verificationFilePath,
      config_profile: config.profile || null,
    },
    task_id: task?.id || null,
    goal_id: goal?.id || null,
  });

  let acceptanceFilePath = null;
  if (writeArtifacts && resultDir) {
    acceptanceFilePath = join(resultDir, "acceptance.json");
    await writeAcceptanceResultFile(acceptanceFilePath, acceptanceResult);
  }

  return {
    judgment: judgment.judgment,
    accepted: judgment.accepted,
    failed: judgment.failed,
    needs_continue: judgment.needs_continue,
    rationale: judgment.rationale,
    task_status: taskStatus,
    auto_complete_allowed: autoCompleteAllowed,
    verification: {
      judgment: verificationResult.judgment || "unknown",
      passed: verificationResult.passed === true,
      commands_count: normalizeList(verificationResult.commands).length,
      findings_count: normalizeList(verificationResult.findings).length,
      file_path: verificationFilePath,
    },
    acceptance: {
      blockers: judgment.blockers,
      followups: judgment.followups,
      file_path: acceptanceFilePath,
    },
    artifacts: {
      verification_json: verificationFilePath,
      acceptance_json: acceptanceFilePath,
    },
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Convenience entry points
// ---------------------------------------------------------------------------

/**
 * Run the independent gate from a result.json file path.
 * Simplest standalone usage.
 */
export async function gateFromFile(resultJsonPath, options = {}) {
  return runIndependentGate({
    resultJsonPath,
    outputDir: dirname(resultJsonPath),
    ...options,
  });
}

/**
 * Run the independent gate with a pre-computed verification result.
 * Useful for testing or when verification was done externally.
 */
export async function gateWithVerification({ verification, ...options } = {}) {
  return runIndependentGate({ verification, ...options });
}

/**
 * Run the independent gate with explicit verification commands.
 * Useful for CI/CD or automated pipelines.
 */
export async function gateWithCommands({ verificationCommands, ...options } = {}) {
  return runIndependentGate({ verificationCommands, ...options });
}
