import test from "node:test";
import assert from "node:assert/strict";

import {
  assertExecutionProviderContract,
  EXECUTION_PROVIDER_METHODS,
} from "../src/execution/execution-provider-contract.mjs";
import { createExecutionProviderRegistry } from "../src/execution/execution-provider-registry.mjs";

function provider(name = "codex_exec") {
  return Object.fromEntries([
    ["name", name],
    ...EXECUTION_PROVIDER_METHODS.map((method) => [method, async () => ({})]),
  ]);
}

test("exec and TUI providers satisfy one autonomous provider contract", () => {
  assert.equal(assertExecutionProviderContract(provider("codex_exec")), true);
  assert.equal(assertExecutionProviderContract(provider("codex_tui")), true);
});

test("provider contract rejects an interactive provider without resume and dispose", () => {
  const incomplete = provider("codex_tui");
  delete incomplete.resume;
  delete incomplete.dispose;
  assert.throws(() => assertExecutionProviderContract(incomplete), /resume/);
});

test("provider registry reports availability and revisions", async () => {
  const registry = createExecutionProviderRegistry();
  registry.register({ ...provider("codex_exec"), revision: "exec-v2", available: async () => true });
  registry.register({ ...provider("codex_tui"), revision: "tui-v4", available: async () => false });

  assert.equal(await registry.isAvailable("codex_exec"), true);
  assert.equal(await registry.isAvailable("codex_tui"), false);
  assert.deepEqual(registry.describe().map((entry) => entry.name), ["codex_exec", "codex_tui"]);
});
