import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_EXECUTION_PROVIDERS,
  checkSuperpowersPluginForTuiFallback,
  isCodexTuiEnabled,
  normalizeCodexExecutionProvider,
  taskUsesCodexTuiGoal,
  describeCodexExecutionProvider,
  getTaskExecutionProviderMode,
} from "../src/codex-execution-provider.mjs";

test("normalizeCodexExecutionProvider defaults missing provider to autonomous codex TUI", () => {
  assert.equal(normalizeCodexExecutionProvider(), CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
  assert.equal(normalizeCodexExecutionProvider(null), CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
  assert.equal(normalizeCodexExecutionProvider(""), CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
});

test("normalizeCodexExecutionProvider accepts codex_tui_goal", () => {
  assert.equal(
    normalizeCodexExecutionProvider("codex_tui_goal"),
    CODEX_EXECUTION_PROVIDERS.TUI_GOAL
  );
});

test("normalizeCodexExecutionProvider preserves compatibility for an unknown explicit provider", () => {
  assert.equal(normalizeCodexExecutionProvider("something_else"), CODEX_EXECUTION_PROVIDERS.EXEC);
});

test("taskUsesCodexTuiGoal reads provider from task metadata", () => {
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "codex_tui_goal" } }), true);
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "codex_exec" } }), false);
  assert.equal(taskUsesCodexTuiGoal({ metadata: { codex_execution_provider: "unknown" } }), false);
  assert.equal(taskUsesCodexTuiGoal({}), true);
});

test("provider descriptions expose TUI as autonomous default and exec as availability fallback", () => {
  const tui = describeCodexExecutionProvider();
  const exec = describeCodexExecutionProvider("codex_exec");
  assert.equal(tui.is_default, true);
  assert.equal(tui.is_manual_fallback, false);
  assert.match(tui.description, /autonomous/i);
  assert.equal(exec.is_default, false);
  assert.equal(exec.is_availability_fallback, true);
});

test("task provider mode distinguishes explicit selection from the TUI default", () => {
  assert.deepEqual(getTaskExecutionProviderMode({}).provider, CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
  assert.equal(getTaskExecutionProviderMode({}).explicit, false);
  assert.equal(getTaskExecutionProviderMode({ metadata: { codex_execution_provider: "codex_exec" } }).explicit, true);
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

test("Codex TUI is enabled by default and only explicit false disables it", () => {
  assert.equal(isCodexTuiEnabled({}, {}), true);
  assert.equal(isCodexTuiEnabled({ codexTuiEnabled: true }, {}), true);
  assert.equal(isCodexTuiEnabled({ codexTuiEnabled: false }, {}), false);
  assert.equal(isCodexTuiEnabled({}, { GPTWORK_CODEX_TUI_ENABLED: "false" }), false);
});
