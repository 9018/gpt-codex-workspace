import test from "node:test";
import assert from "node:assert/strict";

import { selectExecutionProvider } from "../src/execution/provider-selection-policy.mjs";

test("explicit execution provider always wins when available", async () => {
  const selected = await selectExecutionProvider({
    policy: { provider: "codex_tui" },
    availability: { codex_exec: true, codex_tui: true },
    history: { codex_exec: { success_rate: 1 } },
  });
  assert.equal(selected.provider, "codex_tui");
  assert.equal(selected.reason_code, "explicit_provider");
});

test("auto routing prefers native TUI whenever it is available", async () => {
  const selected = await selectExecutionProvider({
    policy: { provider: "auto" },
    availability: { codex_exec: true, codex_tui: true },
    history: {
      codex_exec: { success_rate: 1, attempts: 100 },
      codex_tui: { success_rate: 0, attempts: 100 },
    },
  });
  assert.equal(selected.provider, "codex_tui");
  assert.equal(selected.reason_code, "auto_tui_first");
});

test("auto routing falls back to exec only when TUI is unavailable", async () => {
  const selected = await selectExecutionProvider({
    policy: { provider: "auto" },
    availability: { codex_exec: true, codex_tui: false },
  });
  assert.equal(selected.provider, "codex_exec");
  assert.equal(selected.reason_code, "auto_tui_unavailable");
});

test("routing fails closed when explicit provider is unavailable", async () => {
  await assert.rejects(
    selectExecutionProvider({
      policy: { provider: "codex_tui" },
      availability: { codex_exec: true, codex_tui: false },
    }),
    /provider unavailable/,
  );
});
