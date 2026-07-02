import test from "node:test";
import assert from "node:assert/strict";

test("canary smoke A", () => {
  assert.equal(1 + 1, 2);
});
