import test from "node:test";
import assert from "node:assert/strict";

const MODULES = Object.freeze([
  {
    path: "../src/goal-queue/queue-store.mjs",
    exports: ["enqueueGoal", "listGoalQueue", "getGoalQueueItem", "updateGoalQueueItem", "cancelGoalQueueItem"],
  },
  {
    path: "../src/goal-queue/eligibility-policy.mjs",
    exports: ["checkTypedEligibility"],
  },
  {
    path: "../src/goal-queue/dependency-policy.mjs",
    exports: ["checkTypedEligibility"],
  },
  {
    path: "../src/goal-queue/repo-guard.mjs",
    exports: ["checkTypedEligibility"],
  },
  {
    path: "../src/goal-queue/queue-starter.mjs",
    exports: ["startNextQueuedGoal", "startQueuedGoals"],
  },
  {
    path: "../src/goal-queue/auto-advance.mjs",
    exports: ["autoStartNextOnTaskCompleted", "queueAutoAdvanceTick"],
  },
  {
    path: "../src/goal-queue/index.mjs",
    exports: ["enqueueGoal", "checkTypedEligibility", "startNextQueuedGoal", "queueAutoAdvanceTick"],
  },
  {
    path: "../src/goal-queue/queue-service.mjs",
    exports: ["enqueueGoal", "startQueuedGoals", "queueAutoAdvanceTick"],
  },
  {
    path: "../src/runtime/patrol/stalled-task-rule.mjs",
    exports: ["detectTerminalTasksRunning"],
  },
  {
    path: "../src/runtime/patrol/patrol-runner.mjs",
    exports: ["runWatchDiagnostics", "runWatchWithRecovery"],
  },
  {
    path: "../src/runtime/patrol/lock-rule.mjs",
    exports: ["detectStaleLocks"],
  },
  {
    path: "../src/runtime/patrol/state-classification-rule.mjs",
    exports: ["detectTerminalTasksRunning"],
  },
  {
    path: "../src/runtime/patrol/blocker-rule.mjs",
    exports: ["detectStaleQueueBlockers"],
  },
  {
    path: "../src/runtime/patrol/evidence-rule.mjs",
    exports: ["detectTerminalTasksRunning"],
  },
  {
    path: "../src/runtime/patrol/dirty-repo-rule.mjs",
    exports: ["runWatchDiagnostics"],
  },
  {
    path: "../src/runtime/patrol/afc-rule.mjs",
    exports: ["applyRecoveryActions"],
  },
  {
    path: "../src/runtime/patrol/patrol-report.mjs",
    exports: ["formatWatchDiagnosticsCard"],
  },
  {
    path: "../src/retention/config.mjs",
    exports: ["getRetentionConfig"],
  },
  {
    path: "../src/retention/service.mjs",
    exports: ["retentionStatus", "retentionCleanup", "retentionDiagnosticSummary", "getRecentRetentionCleanups"],
  },
  {
    path: "../src/retention/inventory.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/policy.mjs",
    exports: ["getRetentionConfig"],
  },
  {
    path: "../src/retention/plan-builder.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/cleanup-executor.mjs",
    exports: ["retentionCleanup"],
  },
  {
    path: "../src/retention/audit.mjs",
    exports: ["getRecentRetentionCleanups"],
  },
  {
    path: "../src/retention/scanners/task-scanner.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/scanners/goal-scanner.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/scanners/worktree-scanner.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/scanners/event-scanner.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/retention/scanners/temp-scanner.mjs",
    exports: ["retentionStatus"],
  },
  {
    path: "../src/onboarding/init-runner.mjs",
    exports: ["runInit", "runFullCheck"],
  },
  {
    path: "../src/onboarding/fix-runner.mjs",
    exports: ["runFix"],
  },
  {
    path: "../src/onboarding/checks/runtime-checks.mjs",
    exports: ["checkRuntimeEnv", "checkNodeVersion"],
  },
  {
    path: "../src/onboarding/checks/git-checks.mjs",
    exports: ["checkGitAvailability", "checkGitRepo", "checkDirtyRepo", "checkCurrentHeadDiagnostics"],
  },
  {
    path: "../src/onboarding/report-renderer.mjs",
    exports: ["printInitReport", "printFixReport"],
  },
  {
    path: "../src/onboarding/checks/codex-checks.mjs",
    exports: ["checkCodexAvailability", "checkCodexExecSettings"],
  },
  {
    path: "../src/onboarding/checks/workspace-checks.mjs",
    exports: ["checkWorkspaceSettings", "checkRequiredDirs", "checkGptworkDir", "checkProjectContext"],
  },
  {
    path: "../src/onboarding/checks/context-checks.mjs",
    exports: ["checkContextVectorStore", "checkIntegrationMode", "checkRepoRegistry"],
  },
  {
    path: "../src/onboarding/templates.mjs",
    exports: ["getDefaultProjectMd", "getDefaultProjectEnv"],
  },
  {
    path: "../src/tool-groups/recovery/index.mjs",
    exports: ["createRecoveryToolsGroup"],
  },
  {
    path: "../src/tool-groups/workflow/index.mjs",
    exports: ["createWorkflowToolsGroup"],
    values: ["WORKFLOW_ADVANCE_HANDLER_VERSION"],
  },
]);

const TOOL_GROUP_SEGMENTS = Object.freeze([
  "common",
  "file-tools",
  "patch-tools",
  "command-tools",
  "lock-tools",
  "queue-tools",
  "worker-tools",
  "runtime-tools",
  "restart-tools",
  "storage-tools",
  "api-tools",
]);

const WORKFLOW_SEGMENTS = Object.freeze([
  "status-tools",
  "result-tools",
  "advance-tools",
  "proposal-tools",
]);

test("gptplan 09 exposes split god-file module entrypoints", async () => {
  for (const spec of MODULES) {
    const mod = await import(spec.path);
    for (const name of spec.exports || []) {
      assert.equal(typeof mod[name], "function", `${spec.path} should export function ${name}`);
    }
    for (const name of spec.values || []) {
      assert.ok(Object.hasOwn(mod, name), `${spec.path} should export value ${name}`);
    }
  }
});

test("gptplan 09 exposes tool segment modules with registry-shaped exports", async () => {
  for (const name of TOOL_GROUP_SEGMENTS) {
    const mod = await import(`../src/tool-groups/recovery/${name}.mjs`);
    assert.ok(Array.isArray(mod.definitions), `${name} should export definitions array`);
    assert.equal(typeof mod.handlers, "object", `${name} should export handlers object`);
  }

  for (const name of WORKFLOW_SEGMENTS) {
    const mod = await import(`../src/tool-groups/workflow/${name}.mjs`);
    assert.ok(Array.isArray(mod.definitions), `${name} should export definitions array`);
    assert.equal(typeof mod.handlers, "object", `${name} should export handlers object`);
  }
});
