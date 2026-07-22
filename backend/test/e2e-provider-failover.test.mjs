import test from "node:test";
import assert from "node:assert/strict";

import { createExecutionOrchestrator } from "../src/execution/execution-orchestrator.mjs";
import { createFaultInjectionHarness, createMemoryAttemptStore } from "./helpers/fault-injection-harness.mjs";
import { createFakeCodexExecProvider } from "./helpers/fake-codex-exec-provider.mjs";
import { createFakeCodexTuiProvider } from "./helpers/fake-codex-tui-provider.mjs";

test("exec no-content failure fails over once to native TUI and preserves input", async () => {
  const harness = createFaultInjectionHarness();
  const providers = {
    codex_exec: createFakeCodexExecProvider({ observations: [{ state: "failed", failure: { code: "no_content_output", retry_count: 1 } }], harness }),
    codex_tui: createFakeCodexTuiProvider({ observations: [{ state: "evidence_ready" }], evidence: { status: "completed", summary: "recovered" }, harness }),
  };
  const attemptStore = createMemoryAttemptStore();
  const result = await createExecutionOrchestrator({
    attemptStore,
    providerRegistry: { get: (name) => providers[name], availability: async () => ({ codex_exec: true, codex_tui: true }) },
  }).run({
    taskId: "task_failover",
    provider: "codex_exec",
    pathContext: { execution_cwd: "/repo/worktree" },
    inputSnapshot: { digest: "input-1" },
  });

  assert.equal(result.attempt.provider, "codex_tui");
  assert.equal(result.attempt.state, "completed");
  assert.equal(attemptStore.attempts.length, 2);
  assert.deepEqual(attemptStore.attempts[1].input_snapshot, attemptStore.attempts[0].input_snapshot);
});


test("native session unbound fails over once to codex_exec", async () => {
  const harness = createFaultInjectionHarness();
  const providers = {
    codex_tui: createFakeCodexTuiProvider({
      startError: Object.assign(new Error("Codex TUI native session binding failed: native_session_not_found"), {
        code: "codex_tui_native_session_unbound",
      }),
      harness,
    }),
    codex_exec: createFakeCodexExecProvider({
      observations: [{ state: "evidence_ready" }],
      evidence: { status: "completed", summary: "exec recovered after tui bind failure" },
      harness,
    }),
  };
  const attemptStore = createMemoryAttemptStore();
  const result = await createExecutionOrchestrator({
    attemptStore,
    providerRegistry: {
      get: (name) => providers[name],
      availability: async () => ({ codex_exec: true, codex_tui: true }),
    },
  }).run({
    taskId: "task_native_bind_failover",
    provider: "codex_tui",
    pathContext: { execution_cwd: "/repo/worktree" },
    inputSnapshot: { digest: "input-native-bind" },
  });

  assert.equal(result.attempt.provider, "codex_exec");
  assert.equal(result.attempt.state, "completed");
  assert.equal(attemptStore.attempts.length, 2);
  assert.equal(attemptStore.attempts[0].provider, "codex_tui");
  assert.equal(attemptStore.attempts[1].provider, "codex_exec");
});
