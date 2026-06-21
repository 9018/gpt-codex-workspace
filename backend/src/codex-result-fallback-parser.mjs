import { parseResultJson } from "./codex-result-json-parser.mjs";
import { parseCodexResult } from "./codex-result-stdout-parser.mjs";

export async function parseCodexResultWithFallback({ resultJsonPath, stdout } = {}) {
  // Try result.json first
  if (resultJsonPath) {
    const jsonResult = await parseResultJson(resultJsonPath);
    if (jsonResult) {
      return jsonResult;
    }
  }

  // Fall back to stdout parser
  const stdoutResult = parseCodexResult(stdout);

  // Add a note that we attempted result.json but fell back
  if (resultJsonPath) {
    stdoutResult._result_json_path = resultJsonPath;
    stdoutResult._result_json_error = "not found or invalid";
  }

  return stdoutResult;
}

// ---------------------------------------------------------------------------
// Task result builder (unchanged interface, extended with warnings/followups)
// ---------------------------------------------------------------------------

/**
 * Build a task.result object from parsed Codex output for successful execution.
 *
 * @param {object} parsed - Result from parseCodexResult() or parseResultJson()
 * @param {object} options
 * @param {boolean} options.timedOut - Whether the process timed out
 * @param {number} options.timeoutSeconds - Timeout duration in seconds
 * @param {number} options.returnCode - Process exit code
 * @returns {object} Task result object
 */
