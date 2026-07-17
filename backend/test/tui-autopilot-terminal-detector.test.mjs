import test from "node:test";
import assert from "node:assert/strict";
import { detectTuiTerminalState } from "../src/tui-autopilot/tui-terminal-detector.mjs";

test("detectTuiTerminalState requires durable result, tests, git, and acceptance", () => {
  assert.equal(detectTuiTerminalState({ resultValid: true, testsPresent: true, gitCollected: true, acceptancePassed: true, pendingInteraction: false }).terminal, true);
  const missing = detectTuiTerminalState({ resultValid: true, testsPresent: false, gitCollected: true, acceptancePassed: true });
  assert.equal(missing.terminal, false);
  assert.deepEqual(missing.missing, ["tests"]);
});

test("detectTuiTerminalState never trusts completion text alone", () => {
  const result = detectTuiTerminalState({ frame: { terminal_markers: ["done_text"] } });
  assert.equal(result.terminal, false);
  assert.ok(result.missing.includes("result.json"));
});
