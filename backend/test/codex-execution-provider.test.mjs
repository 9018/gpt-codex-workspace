import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_EXECUTION_PROVIDERS,
  checkSuperpowersPluginForTuiFallback,
  normalizeCodexExecutionProvider,
  taskUsesCodexTuiGoal,
} from "../src/codex-execution-provider.mjs";

test("normalizeCodexExecutionProvider defaults missing provider to codex_exec", () => {
  assert.equal(normalizeCodexExecutionProvider(), CODEX_EXECUTION_PROVIDERS.EXEC);
  assert.equal(normalizeCodexExecutionProvider(null), CODEX_EXECUTION_PROVIDERS.EXEC);
  assert.equal(normalizeCodexExecutionProvider(""), CODEX_EXECUTION_PROVIDERS.EXEC);
});

test("normalizeCodexExecutionProvider accepts codex_tui_goal", () => {
  assert.equal(
    normalizeCodexExecutionProvider("codex_tui_goal"),
    CODEX_EXECUTION_PROVIDERS.TUI_GOAL
  );
});

test("normalizeCodexExecutionProvider defaults unknown provider to codex_exec", () => {
  assert.equal(normalizeCodexExecutionProvider("something_else"), CODEX_EXECUTION_PROVIDERS.EXEC);
});

test("taskUsesCodexTuiGoal reads provider from task metadata", () => {
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "codex_tui_goal" } }), true);
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "codex_exec" } }), false);
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "unknown" } }), false);
  assert.equal(taskUsesCodexTuiGoal({}), false);
});

test("checkSuperpowersPluginForTuiFallback resolves plugins from configured CODEX_HOME", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "gptwork-codex-home-"));
  await mkdir(join(codexHome, "plugins", "superpowers"), { recursive: true });

  const result = checkSuperpowersPluginForTuiFallback({
    codexHome,
    requireSuperpowersPluginForTuiFallback: true,
  }, {});

  assert.deepEqual(result, { available: true, required: true, diagnostic: null });
});
