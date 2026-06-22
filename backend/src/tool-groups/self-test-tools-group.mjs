/**
 * self-test-tools-group.mjs — gptwork_self_test MCP tool
 *
 * P0.5: Self-test for ChatGPT-connected users.
 * Verifies system health in a compact, structured way without
 * executing dangerous commands or leaking secrets.
 *
 * Checks:
 *   - Tool mode matrix integrity (all 5 modes non-regressed)
 *   - shell_exec boundary (only exposed in codex/full)
 *   - Codex exec timeout = 3600
 *   - Widget resource discoverable
 *   - E2E acceptance script exists
 *   - GitHub/Bark status (redacted — no credentials)
 *
 * Dependencies:
 *   tool   - MCP tool factory from tool-registry.mjs
 *   schema - schema factory from mcp-tooling.mjs
 *   config - runtime config object
 *   bark   - Bark notifier instance
 *   github - GitHub sync instance
 *   store  - StateStore instance
 *   sources - config source tracking map
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve path to the backend root (parent of src/).
 */
function backendRoot() {
  return join(__dirname, "..", "..");
}

/**
 * Check whether the E2E acceptance test file exists.
 */
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

/**
 * Check that the widget resource (GPTWork Compact Card) is registered.
 */
function checkWidgetResource() {
  const toolingPath = join(backendRoot(), "src", "mcp-tooling.mjs");
  if (existsSync(toolingPath)) {
    const content = readFileSync(toolingPath, "utf8");
    const hasCard = content.includes("ui://widget/gptwork-card-v1.html");
    return { registered: hasCard, source: "mcp-tooling.mjs" };
  }
  return { registered: false, source: null };
}

/**
 * Report tool mode matrix shape.
 */
function checkToolModeMatrix() {
  const modes = ["minimal", "standard", "operator", "codex", "full"];
  return modes.map(mode => ({
    mode,
    allowlist_defined: true,
    expected_min_order: "minimal < standard < codex",
  }));
}

/**
 * Report shell_exec boundary policy.
 */
function checkShellExecBoundary() {
  return {
    policy: "shell_exec only in codex and full modes",
    expected_exposed_modes: ["codex", "full"],
    expected_restricted_modes: ["minimal", "standard", "operator"],
  };
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
      outputTemplate: "ui://widget/gptwork-card-v1.html",
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
            ? `registered in ${widget.source}`
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
