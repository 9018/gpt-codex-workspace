/**
 * entry-contract-deriver.mjs — Derive entry display from acceptance contract.
 *
 * Phase 3: codex.entry.md, claude.entry.md, and related execution entrypoints
 * must derive their execution mode and mutation scope display from the
 * acceptance.contract.json's canonical intent block, not from custom top-level
 * fields.
 *
 * The intent block is the single source of truth:
 *   intent.operation_kind  → Execution mode display
 *   intent.execution_mode  → Execution mode
 *   intent.mutation_scope  → Mutation scope display
 *   intent.semantic_confidence → Confidence level
 */

// ---------------------------------------------------------------------------
// Mutation commands that MUST NOT appear in readonly/diagnostic entries
// ---------------------------------------------------------------------------

const MUTATION_COMMANDS = Object.freeze([
  "make", "change", "commit", "deploy", "restart",
  "reboot", "mkdir", "rmdir", "rm ", "cp ", "mv ",
  "sed", "awk", "systemctl", "kubectl", "docker",
  "git commit", "git push", "git merge", "git rebase",
]);

const MUTATION_COMMAND_PATTERN = /\b(make|change|commit|deploy|restart|reboot|rm\b|cp\b|mv\b|sed\b|awk\b|systemctl\b|kubectl\b|docker\b)\b/i;

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if the contract indicates readonly or diagnostic intent.
 * @param {object} contract
 * @returns {boolean}
 */
export function isReadonlyOrDiagnosticContract(contract) {
  if (!contract?.intent) return false;
  const kind = String(contract.intent.operation_kind || "").toLowerCase();
  const mode = String(contract.intent.execution_mode || "").toLowerCase();

  if (["diagnostic", "readonly_validation", "noop", "already_integrated"].includes(kind)) return true;
  if (["readonly"].includes(mode)) return true;
  return false;
}

/**
 * Get the execution mode display string derived from the acceptance contract.
 *
 * @param {object} contract
 * @returns {string} e.g. "readonly diagnostic", "implementation", "deploy"
 */
export function getExecutionModeDisplay(contract) {
  if (!contract?.intent) return "unknown";
  const kind = contract.intent.operation_kind || "unknown";
  const mode = contract.intent.execution_mode || "unknown";

  if (["diagnostic", "readonly_validation", "noop"].includes(kind)) {
    return `readonly diagnostic (mode: ${mode}, kind: ${kind})`;
  }
  if (kind === "already_integrated") {
    return `readonly already_integrated (mode: ${mode})`;
  }
  return `${kind || "unknown"} (mode: ${mode})`;
}

/**
 * Get the mutation scope display string derived from the acceptance contract.
 *
 * @param {object} contract
 * @returns {string} e.g. "none", "repo", "runtime", "filesystem", "external_system"
 */
export function getMutationScopeDisplay(contract) {
  if (!contract?.intent) return "unknown";
  const scope = contract.intent.mutation_scope || "unknown";
  return scope;
}

/**
 * Get the execution mode as a short label for diagnostic display.
 *
 * @param {object} contract
 * @returns {string} e.g. "readonly diagnostic", "implementation"
 */
export function getExecutionModeLabel(contract) {
  if (!contract?.intent) return "unknown";
  const kind = String(contract.intent.operation_kind || "");
  const mode = String(contract.intent.execution_mode || "");

  if (["diagnostic", "readonly_validation", "noop", "already_integrated"].includes(kind)) {
    return "readonly diagnostic";
  }
  if (mode === "readonly") return "readonly";
  if (mode === "deploy") return "deploy";
  if (mode === "admin") return "admin";
  if (kind === "restart") return "restart";
  return mode || "implementation";
}

/**
 * Get the mutation scope as a short label for diagnostic display.
 *
 * @param {object} contract
 * @returns {string} e.g. "none", "code_tests_docs"
 */
export function getMutationScopeLabel(contract) {
  if (!contract?.intent) return "unknown";
  const scope = String(contract.intent.mutation_scope || "");
  if (scope === "none") return "none";
  if (scope === "repo") return "repo (code, tests, docs)";
  if (scope === "filesystem") return "filesystem";
  if (scope === "runtime") return "runtime";
  if (scope === "external_system") return "external_system";
  return scope || "unknown";
}

/**
 * Strip mutation-related command references from text when in readonly mode.
 * This prevents readonly diagnostics from containing make/change/commit/deploy
 * etc. commands that conflict with their execution mode.
 *
 * @param {string} text - Original text
 * @param {boolean} isReadonly - Whether the contract is readonly/diagnostic
 * @returns {string} Sanitized text
 */
export function sanitizeReadonlyInstructions(text, isReadonly = true) {
  if (!text || !isReadonly) return text || "";
  // Replace mutation commands with safe alternatives
  let result = text
    .replace(/\b(make|Make)\b/g, "$&") // placeholder - we remove sentences with mutation
    .replace(/\b(change|Change|modify|Modify)\s+\w+/g, "analyze")
    .replace(/\b(commit|Commit)\s+.+$/gm, "report findings")
    .replace(/\b(deploy|Deploy)\b/g, "inspect")
    .replace(/\b(restart|Restart|reboot|Reboot)\b/g, "check status of")
    .replace(/\b(systemctl\s+(restart|stop|start|enable|disable))/g, "systemctl status")
    .replace(/\b(kubectl\s+(apply|delete|create|patch|rollout))/g, "kubectl get")
    .replace(/\b(docker\s+(rm|kill|stop|start|restart|compose\s+(up|down)))/g, "docker ps")
    .replace(/\bgit\s+(commit|push|merge|rebase)/g, "git log")
    .replace(/\b(Write|Edit|Update)\s+file\b/g, "Read file")
    .replace(/\b(sed\s+-i)\b/g, "# sed inspection");

  return result;
}

/**
 * Build the execution diagnostics section for an entry file.
 *
 * @param {object} contract - Acceptance contract
 * @returns {string} Markdown-formatted execution diagnostics
 */
export function buildEntryExecutionDiagnostics(contract) {
  if (!contract?.intent) {
    return [
      "## Execution Diagnostics",
      "",
      "- Execution mode: unknown",
      "- Mutation scope: unknown",
      "- Intent source: acceptance.contract.json.intent",
      "",
    ].join("\n");
  }

  const modeLabel = getExecutionModeLabel(contract);
  const scopeLabel = getMutationScopeLabel(contract);
  const isReadonly = isReadonlyOrDiagnosticContract(contract);

  const lines = [
    "## Execution Diagnostics",
    "",
    `- **Execution mode**: ${modeLabel} (derived from acceptance.contract.json.intent)`,
    `- **Mutation scope**: ${scopeLabel} (derived from acceptance.contract.json.intent)`,
    `- **Operation kind**: ${contract.intent.operation_kind || "unknown"}`,
    `- **Semantic confidence**: ${contract.intent.semantic_confidence || "unknown"}`,
    `- **Read-only mode**: ${isReadonly ? "Yes — do not execute mutation commands" : "No"}`,
    "",
  ];

  if (isReadonly) {
    lines.push("> **Read-only constraint**: This goal has readonly/diagnostic intent.");
    lines.push("> Do NOT execute any make, change, commit, deploy, restart, reboot, or");
    lines.push("> other mutation commands. Only read, inspect, analyze, and report.");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Sanitize the entry's Execution Rules section to remove mutation commands
 * when the goal is readonly/diagnostic.
 *
 * @param {string} rulesText - Original execution rules text
 * @param {boolean} isReadonly - Whether to sanitize
 * @returns {string} Sanitized or original text
 */
export function sanitizeExecutionRules(rulesText, isReadonly) {
  if (!rulesText || !isReadonly) return rulesText || "";

  // Keep generic rules, remove mutation-specific ones
  const lines = rulesText.split("\n").filter((line) => {
    const lower = line.toLowerCase();
    // Keep lines that don't contain mutation commands
    return !MUTATION_COMMAND_PATTERN.test(lower);
  });

  return lines.join("\n");
}
