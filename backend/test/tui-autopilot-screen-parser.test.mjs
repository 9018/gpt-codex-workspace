import test from "node:test";
import assert from "node:assert/strict";
import { parseTuiScreen } from "../src/tui-autopilot/tui-screen-parser.mjs";

test("parseTuiScreen removes terminal noise and extracts structured markers", () => {
  const frame = parseTuiScreen("\u001b[2KWorking ⠋\r\nAllow command? (y/n)\r\n  1. Continue\r\n> 2. Cancel\r\n", {
    sequence: 7,
    capturedAt: "2026-07-17T00:00:00.000Z",
  });

  assert.equal(frame.sequence, 7);
  assert.equal(frame.normalized_text.includes("\u001b"), false);
  assert.deepEqual(frame.confirmation_markers, ["allow_command"]);
  assert.deepEqual(frame.selectable_options.map((option) => option.index), [1, 2]);
  assert.ok(frame.progress_markers.includes("working"));
  assert.match(frame.content_digest, /^[a-f0-9]{64}$/);
});
