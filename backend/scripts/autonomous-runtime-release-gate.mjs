#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const backendRoot = resolve(import.meta.dirname, "..");
const listOnly = process.argv.includes("--list");

const suiteDefinitions = [
  { name: "syntax", group: "invariants", command: process.execPath, args: ["scripts/check-syntax.mjs"] },
  { name: "imports", group: "invariants", command: "npm", args: ["run", "check:imports"] },
  {
    name: "canonical decision invariants",
    group: "invariants",
    command: process.execPath,
    args: ["--test", "test/unified-decision-consistency.test.mjs", "test/unified-decision-contract.test.mjs", "test/unified-decision-integration-invariants.test.mjs"],
  },
  {
    name: "progression command suite",
    group: "idempotency",
    command: process.execPath,
    args: ["--test", "test/progression-command-e2e.test.mjs", "test/progression-command-idempotency.test.mjs", "test/progression-command-recovery.test.mjs", "test/e2e-progression-idempotency.test.mjs"],
  },
  {
    name: "autonomous TUI E2E",
    group: "autonomous_tui",
    command: process.execPath,
    args: ["--test", "test/tui-autopilot-e2e.test.mjs", "test/tui-autopilot-no-progress-recovery.test.mjs", "test/e2e-autonomous-tui-closure.test.mjs"],
  },
  {
    name: "provider contract and failover",
    group: "recovery",
    command: process.execPath,
    args: ["--test", "test/execution-provider-contract.test.mjs", "test/execution-provider-failover.test.mjs", "test/execution-attempt-recovery.test.mjs", "test/e2e-provider-failover.test.mjs", "test/e2e-restart-recovery.test.mjs"],
  },
  { name: "state boundary suite", group: "state_consistency", command: "npm", args: ["run", "test:state-boundary"] },
  {
    name: "state and DAG E2E",
    group: "state_consistency",
    command: process.execPath,
    args: ["--test", "test/e2e-state-reconciliation.test.mjs", "test/e2e-multi-agent-dag.test.mjs"],
  },
  { name: "full npm test", group: "invariants", command: "npm", args: ["test"] },
  { name: "TUI first-loop canary", group: "autonomous_tui", command: process.execPath, args: ["scripts/e2e-tui-first-loop.mjs"] },
];

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: backendRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function tail(value, limit = 4000) {
  const text = String(value || "").trim();
  return text.length > limit ? text.slice(-limit) : text;
}

function emptyReport() {
  return {
    git_head: gitHead(),
    passed: null,
    suites: suiteDefinitions.map(({ name, group, command, args }) => ({ name, group, command: [command, ...args].join(" "), passed: null })),
    invariants: null,
    autonomous_tui: null,
    recovery: null,
    idempotency: null,
    state_consistency: null,
    failures: [],
  };
}

function runSuite(definition) {
  const started = Date.now();
  const result = spawnSync(definition.command, definition.args, {
    cwd: backendRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  const passed = result.status === 0 && !result.error;
  return {
    name: definition.name,
    group: definition.group,
    command: [definition.command, ...definition.args].join(" "),
    passed,
    exit_code: result.status,
    signal: result.signal || null,
    duration_ms: Date.now() - started,
    output_tail: tail(result.stdout || result.stderr),
    error: result.error?.message || null,
  };
}

function groupPassed(suites, group) {
  const selected = suites.filter((suite) => suite.group === group);
  return selected.length > 0 && selected.every((suite) => suite.passed);
}

const report = emptyReport();
if (!listOnly) {
  report.suites = suiteDefinitions.map(runSuite);
  report.invariants = groupPassed(report.suites, "invariants");
  report.autonomous_tui = groupPassed(report.suites, "autonomous_tui");
  report.recovery = groupPassed(report.suites, "recovery");
  report.idempotency = groupPassed(report.suites, "idempotency");
  report.state_consistency = groupPassed(report.suites, "state_consistency");
  report.failures = report.suites
    .filter((suite) => !suite.passed)
    .map((suite) => ({ name: suite.name, exit_code: suite.exit_code, signal: suite.signal, error: suite.error, output_tail: suite.output_tail }));
  report.passed = report.failures.length === 0
    && report.invariants
    && report.autonomous_tui
    && report.recovery
    && report.idempotency
    && report.state_consistency;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!listOnly && !report.passed) process.exitCode = 1;
