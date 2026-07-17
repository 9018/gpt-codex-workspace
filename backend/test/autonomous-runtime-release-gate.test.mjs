import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("autonomous runtime release gate exposes the required JSON report contract", () => {
  const result = spawnSync(process.execPath, ["scripts/autonomous-runtime-release-gate.mjs", "--list"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), [
    "git_head",
    "passed",
    "suites",
    "invariants",
    "autonomous_tui",
    "recovery",
    "idempotency",
    "state_consistency",
    "failures",
  ]);
  assert.equal(report.passed, null);
  assert.ok(report.suites.some((suite) => suite.name === "full npm test"));
  assert.ok(report.suites.some((suite) => suite.name === "autonomous TUI E2E"));
});
