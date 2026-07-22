import test from "node:test";
import assert from "node:assert/strict";
import { classifyExecutionProviderFailure, executionFailureState } from "../src/execution/execution-failure-classifier.mjs";

test("classifies native session bind failure as provider interruption", () => {
  const failure = classifyExecutionProviderFailure(
    Object.assign(new Error("Codex TUI native session binding failed: native_session_not_found"), {
      code: "codex_tui_native_session_unbound",
    }),
    { provider: "codex_tui", phase: "start" },
  );
  assert.equal(failure.code, "codex_tui_native_session_unbound");
  assert.equal(failure.failure_class, "provider_interruption");
  assert.equal(executionFailureState(failure), "provider_unavailable");
});
