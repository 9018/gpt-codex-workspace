import test from "node:test";
import assert from "node:assert/strict";

import { createFaultInjectionHarness } from "./helpers/fault-injection-harness.mjs";
import { createFakeCodexTuiProvider } from "./helpers/fake-codex-tui-provider.mjs";
import { fakeTuiScreenSequence } from "./helpers/fake-tui-screen-sequences.mjs";

test("autonomous TUI closes after confirmation and evidence without human input", async () => {
  const harness = createFaultInjectionHarness();
  const screens = fakeTuiScreenSequence("confirmationThenCompletion");
  const provider = createFakeCodexTuiProvider({
    observations: [{ state: "running" }, { state: "evidence_ready" }],
    evidence: { status: "completed", summary: "verified", tests: [{ passed: true }] },
    harness,
  });

  const handle = await provider.start({ id: "attempt_tui", task_id: "task_tui" });
  assert.equal((await provider.observe(handle)).state, "running");
  assert.equal((await provider.observe(handle)).state, "evidence_ready");
  assert.equal((await provider.collect(handle)).status, "completed");
  assert.match(screens[0], /\(y\/n\)/);
  assert.match(screens.at(-1), /STATUS=completed/);
  assert.deepEqual(harness.effects(), ["codex_tui.start", "codex_tui.collect"]);
});
