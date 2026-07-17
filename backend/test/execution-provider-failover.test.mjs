import test from "node:test";
import assert from "node:assert/strict";

import { selectFailoverProvider } from "../src/execution/provider-failover-policy.mjs";

test("exec no-content failures automatically fail over to TUI", () => {
  assert.deepEqual(
    selectFailoverProvider({
      attempt: { provider: "codex_exec", attempt_number: 1 },
      failure: { code: "no_content_output", retry_count: 1 },
      availability: { codex_tui: true },
    }),
    { provider: "codex_tui", reason_code: "exec_no_content_output" },
  );
});

test("TUI falls back to exec only for typed provider unavailability", () => {
  assert.equal(selectFailoverProvider({
    attempt: { provider: "codex_tui" },
    failure: { code: "pty_unavailable" },
    availability: { codex_exec: true },
  }).provider, "codex_exec");
  assert.equal(selectFailoverProvider({
    attempt: { provider: "codex_tui" },
    failure: { code: "autopilot_repeated_prompt_loop" },
    availability: { codex_exec: true },
  }), null);
});

test("failover returns null when alternate provider is unavailable", () => {
  assert.equal(selectFailoverProvider({
    attempt: { provider: "codex_exec" },
    failure: { code: "no_content_output", retry_count: 2 },
    availability: { codex_tui: false },
  }), null);
});
