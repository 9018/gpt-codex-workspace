import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_EXECUTION_PROVIDERS,
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
