import test from "node:test";
import assert from "node:assert/strict";
import { createTuiSlashCommandDriver } from "../../src/tui-autopilot/tui-slash-command-driver.mjs";
test("requires writeInput", () => {
  assert.throws(() => createTuiSlashCommandDriver({}), /writeInput is required/);
});
test("execute sends command text", async () => {
  const calls = [];
  const driver = createTuiSlashCommandDriver({ writeInput: (text) => calls.push(text) });
  const result = await driver.execute({ command: "/help", timeoutMs: 100 });
  assert.ok(calls[0].includes("/help\r"));
  assert.equal(result.ok, true);
});
