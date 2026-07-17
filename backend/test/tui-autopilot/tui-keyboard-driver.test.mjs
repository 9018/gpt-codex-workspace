import test from "node:test";
import assert from "node:assert/strict";
import { createTuiKeyboardDriver } from "../../src/tui-autopilot/tui-keyboard-driver.mjs";
test("requires writeInput", () => {
  assert.throws(() => createTuiKeyboardDriver({}), /writeInput is required/);
});
test("send calls writeInput with text", async () => {
  const calls = [];
  const driver = createTuiKeyboardDriver({ writeInput: (text) => calls.push(text), defaultWaitMs: 0 });
  await driver.send("hello");
  assert.deepEqual(calls, ["hello"]);
});
test("press sends key", async () => {
  const calls = [];
  const driver = createTuiKeyboardDriver({ writeInput: (text) => calls.push(text), defaultWaitMs: 0 });
  await driver.press("\r");
  assert.deepEqual(calls, ["\r"]);
});
