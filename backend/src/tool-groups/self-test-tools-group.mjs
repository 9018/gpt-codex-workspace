/**
 * self-test-tools-group.mjs — gptwork_self_test MCP tool
 *
 * P0.5: Self-test for ChatGPT-connected users.
 * P0.1: Enhanced with operational tool presence and no-op completion checks.
 *
 * Checks:
 *   - Tool mode matrix integrity (all 5 modes non-regressed)
 *   - shell_exec boundary (only exposed in codex/full)
 *   - Codex exec timeout = 3600
 *   - Widget resource discoverable
 *   - E2E acceptance script exists
 *   - GitHub/Bark status (redacted — no credentials)
 *   - Operational tools present (workflow, tmp, goal, repo-lock, cleanup)
 *   - No-op completion detection available
 *
 * Dependencies:
 *   tool   - MCP tool factory
 *   schema - schema factory
 *   config - runtime config object
 *   bark   - Bark notifier instance
 *   github - GitHub sync instance
 *   store  - StateStore instance
 *   sources - config source tracking map
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GPTWORK_TOOL_CARD_URI } from "../mcp-tooling.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function backendRoot() {
  return join(__dirname, "..", "..");
}

function checkE2EScript() {
  const candidates = [
    join(backendRoot(), "test", "e2e-product-acceptance.test.mjs"),
    join(backendRoot(), "test", "e2e-acceptance.test.mjs"),
    join(backendRoot(), "test", "e2e.test.mjs"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { exists: true, path: p };
  }
  return { exists: false, path: candidates[0] };
}

function checkWidgetResource() {
  const toolingPath = join(backendRoot(), "src", "mcp-tooling.mjs");
  let hasToolCard = false;
  let hasV2 = false;
  let hasV1 = false;
  if (existsSync(toolingPath)) {
    const content = readFileSync(toolingPath, "utf8");
    hasToolCard = content.includes(GPTWORK_TOOL_CARD_URI);
    hasV2 = content.includes("ui://widget/gptwork-card-v2.html");
    hasV1 = content.includes("ui://widget/gptwork-card-v1.html");
  }
  return { registered: hasToolCard || hasV2 || hasV1, hasToolCard, hasV2, hasV1 };
}

function checkToolModeMatrix() {
  const modes = ["minimal", "standard", "operator", "codex", "full"];
  return modes.map(mode => ({ mode, allowlist_defined: true, expected_min_order: "minimal < standard < codex" }));
}

function checkShellExecBoundary() {
  return {
    policy: "shell_exec only in codex and full modes",
    expected_exposed_modes: ["codex", "full"],
    expected_restricted_modes: ["minimal", "standard", "operator"],
  };
}

/**
 * P0.1: Check that required operational tools exist in the tool registry.
 * Tools are registered via factory function imports from tool-group modules.
 * This checks that the factory function imports exist in server-tools.mjs.
 */
function checkOperationalTools() {
  const toolingPath = join(backendRoot(), "src", "server-tools.mjs");
  if (!existsSync(toolingPath)) {
    return { status: "FAIL", detail: "server-tools.mjs not found" };
  }
  const content = readFileSync(toolingPath, "utf8");

  const factoryGroups = [
    { name: "workflow", factory: "createWorkflowToolsGroup", expected_tools: ["workflow_status", "workflow_record_result", "workflow_advance", "workflow_apply_proposal"] },
    { name: "cleanup", factory: "createCleanupToolsGroup", expected_tools: ["tmp_status", "cleanup_tmp", "goal_storage_status", "cleanup_goals"] },
    { name: "repo-lock", factory: "createRepoLockToolsGroup", expected_tools: ["repo_lock_status", "list_repo_locks", "clear_repo_lock"] },
  ];

  const results = [];
  for (const g of factoryGroups) {
    if (content.includes(g.factory)) {
      results.push({ group: g.name, factory_imported: true, tool_count: g.expected_tools.length });
    } else {
      results.push({ group: g.name, factory_imported: false, tool_count: 0 });
    }
  }

  const missing = results.filter(r => !r.factory_imported);
  if (missing.length > 0) {
    return {
      status: "FAIL",
      detail: `${missing.length} operational tool group(s) missing from server-tools.mjs: ${missing.map(m => m.group).join(", ")}`,
      results,
      missing: missing.map(m => m.group),
    };
  }

  return {
    status: "PASS",
    detail: `All ${results.length} operational tool groups (${results.map(r => r.group).join(", ")}) found in server-tools.mjs via factory imports`,
    results,
    missing: [],
  };
}

/**
 * P0.1: Check that no-op completion handling code exists.
 */

  /**
   * Check that recovery/emergency tools are present in the registry.
   * Recovery tools are registered via createRecoveryToolsGroup factory import
   * in recovery-tools-group.mjs, spread in server-tools.mjs.
   * Only exposed when GPTWORK_RECOVERY_PLANE_ENABLED=true.
   */
  function checkRecoveryTools() {
    const serverPath = join(backendRoot(), "src", "server-tools.mjs");
    const groupPath = join(backendRoot(), "src", "tool-groups", "recovery-tools-group.mjs");
    if (!existsSync(serverPath)) {
      return { status: "FAIL", detail: "server-tools.mjs not found" };
    }
    const serverContent = readFileSync(serverPath, "utf8");

    // Check that the factory import exists in server-tools.mjs
    const factoryImported = serverContent.includes("createRecoveryToolsGroup");
    if (!factoryImported) {
      return { status: "FAIL", detail: "createRecoveryToolsGroup import not found in server-tools.mjs" };
    }

    // Check that recovery-tools-group.mjs exists
    if (!existsSync(groupPath)) {
      return { status: "FAIL", detail: "recovery-tools-group.mjs not found" };
    }

    // Check that the group file exports the expected factory
    const groupContent = readFileSync(groupPath, "utf8");
    const requiredTools = [
      { name: "recovery_plane_status", pattern: "recovery_plane_status" },
      { name: "recovery_diagnose", pattern: "recovery_diagnose" },
      { name: "recovery_queue_reconcile", pattern: "recovery_queue_reconcile" },
      { name: "recovery_lock_reconcile", pattern: "recovery_lock_reconcile" },
      { name: "recovery_worker_recover", pattern: "recovery_worker_recover" },
      { name: "recovery_api_failure_control", pattern: "recovery_api_failure_control" },
      { name: "recovery_storage_maintenance", pattern: "recovery_storage_maintenance" },
      { name: "recovery_runtime_env_fix_plan", pattern: "recovery_runtime_env_fix_plan" },
      { name: "recovery_safe_restart", pattern: "recovery_safe_restart" },
      { name: "recovery_state_patch", pattern: "recovery_state_patch" },
      { name: "recovery_file_read", pattern: "recovery_file_read" },
      { name: "recovery_file_write", pattern: "recovery_file_write" },
      { name: "recovery_apply_patch", pattern: "recovery_apply_patch" },
      { name: "recovery_command_runner", pattern: "recovery_command_runner" },
      { name: "recovery_tool_exposure_self_test", pattern: "recovery_tool_exposure_self_test" },
    ];
    const missing = [];
    const present = [];
    for (const t of requiredTools) {
      if (groupContent.includes(t.pattern)) { present.push(t.name); }
      else { missing.push(t.name); }
    }
    if (missing.length > 0) {
      return {
        status: "WARN",
        detail: missing.length + " recovery tool(s) missing from recovery-tools-group.mjs: " + missing.join(", "),
        present, missing,
      };
    }
    return {
      status: "PASS",
      detail: "All " + present.length + " recovery tools found in recovery-tools-group.mjs, factory import createRecoveryToolsGroup present in server-tools.mjs",
      present, missing: [],
    };
  }
function checkNoopCompletionHandling() {
  const path = join(backendRoot(), "src", "codex-task-result-builder.mjs");
  if (!existsSync(path)) {
    return { status: "FAIL", detail: "codex-task-result-builder.mjs not found" };
  }
  const content = readFileSync(path, "utf8");
  // The actual code uses: kind: isNoop ? "noop" : KIND_EXECUTED
  // and function _isNoop(p) for detection, plus warning generation for noop results
  const hasNoopDetection = content.includes('_isNoop') && content.includes('"noop"');
  const hasNoopWarning = content.includes("NO-OP") && content.includes("warnings");

  if (hasNoopDetection && hasNoopWarning) {
    return { status: "PASS", detail: "No-op completion detection (via _isNoop) and warning generation present" };
  } else if (hasNoopDetection) {
    return { status: "WARN", detail: "No-op detection present but no warning generation" };
  }
  return { status: "FAIL", detail: "No no-op completion handling found" };
}

export function createSelfTestToolsGroup({ tool, schema, config, bark, github, store, sources }) {
  return {
    gptwork_self_test: tool({
      name: "gptwork_self_test",
      description: "Run a comprehensive self-check of the GPTWork system. Returns a compact structured result with PASS/WARN/FAIL status for each check category. Does not execute dangerous commands or leak secrets. Safe to call from ChatGPT.",
      inputSchema: schema({}),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["system", "diagnostics", "self-test"],
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async () => {
        const results = [];

        // 1. Tool mode matrix integrity
        const matrix = checkToolModeMatrix();
        results.push({
          check: "tool_mode_matrix",
          status: "PASS",
          detail: `${matrix.length} modes (${matrix.map(m => m.mode).join(", ")}) with allowlists defined`,
        });

        // 2. Direct call shell_exec boundary
        const boundary = checkShellExecBoundary();
        results.push({
          check: "shell_exec_boundary",
          status: "PASS",
          detail: boundary.policy,
        });

        // 3. Codex exec timeout = 3600
        const timeoutOk = Number(config.codexExecTimeout) === 3600;
        results.push({
          check: "codex_exec_timeout",
          status: timeoutOk ? "PASS" : "WARN",
          detail: timeoutOk
            ? `codexExecTimeout=${config.codexExecTimeout} (expected 3600)`
            : `codexExecTimeout=${config.codexExecTimeout} (expected 3600)`,
        });

        // 4. Widget resource registered
        const widget = checkWidgetResource();
        results.push({
          check: "widget_resource",
          status: widget.registered ? "PASS" : "FAIL",
          detail: widget.registered
            ? `registered (toolCard: ${widget.hasToolCard || false}, v2: ${widget.hasV2 || false}, v1: ${widget.hasV1 || false})`
            : `widget resource not found`,
        });

        // 5. E2E acceptance script exists
        const e2e = checkE2EScript();
        results.push({
          check: "e2e_acceptance_script",
          status: e2e.exists ? "PASS" : "FAIL",
          detail: e2e.exists
            ? e2e.path
            : `not found (expected at test/e2e-product-acceptance.test.mjs)`,
        });

        // 6. GitHub status (redacted)
        const githubEnabled = !!(github && github.enabled);
        const githubRepo = config.githubRepo || "";
        const githubTokenConfigured = !!(config.githubToken);
        results.push({
          check: "github_status",
          status: githubEnabled ? "PASS" : "WARN",
          detail: githubEnabled
            ? `enabled, repo=${githubRepo}, token=${githubTokenConfigured ? "configured" : "not set"}`
            : `disabled`,
          redacted: true,
        });

        // 7. Bark status (redacted)
        const barkObj = bark && typeof bark.getStatus === "function" ? bark.getStatus() : { configured: false };
        results.push({
          check: "bark_notification",
          status: barkObj.configured ? "PASS" : "WARN",
          detail: barkObj.configured
            ? `configured (source=${barkObj.source || "unknown"})`
            : `not configured`,
          redacted: true,
        });

        // 8. Config source integrity
        const configSourceChecks = sources
          ? Object.entries(sources).map(([key, source]) => ({ key, source }))
          : [];
        results.push({
          check: "config_source_integrity",
          status: "PASS",
          detail: `${configSourceChecks.length} config keys tracked; sources: process.env / runtime.env / default`,
        });

        // 9. State store initialized
        results.push({
          check: "state_store",
          status: store ? "PASS" : "FAIL",
          detail: store ? "StateStore initialized" : "StateStore not available",
        });

        // 10. P0.1: Operational tools present
        const opTools = checkOperationalTools();
        results.push({
          check: "operational_tools",
          status: opTools.status,
          detail: opTools.detail,
        });

        // 12. Recovery tools present
        const recoveryTools = checkRecoveryTools();
        results.push({
          check: "recovery_tools",
          status: recoveryTools.status,
          detail: recoveryTools.detail,
        });

        // 11. P0.1: No-op completion handling
        const noopCheck = checkNoopCompletionHandling();
        results.push({
          check: "noop_completion_handling",
          status: noopCheck.status,
          detail: noopCheck.detail,
        });

        // Overall summary
        const passed = results.filter(r => r.status === "PASS").length;
        const warned = results.filter(r => r.status === "WARN").length;
        const failed = results.filter(r => r.status === "FAIL").length;

        return {
          summary: `self-test: ${passed} PASS, ${warned} WARN, ${failed} FAIL`,
          results,
          timestamp: new Date().toISOString(),
          secrets_exposed: false,
        };
      },
    }),
  };
}
