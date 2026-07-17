function nextObservation(queue) {
  return queue.length > 1 ? queue.shift() : queue[0];
}

export function createFakeCodexTuiProvider({ observations = [{ state: "evidence_ready" }], evidence = { status: "completed" }, harness } = {}) {
  const queue = structuredClone(observations);
  return {
    name: "codex_tui",
    revision: "fake-tui-v1",
    async start(attempt) {
      harness?.recordEffect("codex_tui.start", { attempt_id: attempt.id });
      harness?.checkpoint("codex_tui.after_start", attempt);
      return { id: `tui_${attempt.id}`, session_id: `session_${attempt.id}`, native_session_id: `native_${attempt.id}` };
    },
    async resume(attempt, checkpoint) {
      harness?.recordEffect("codex_tui.resume", { attempt_id: attempt.id });
      harness?.checkpoint("codex_tui.after_resume", checkpoint);
      return { id: `tui_${attempt.id}`, session_id: `session_${attempt.id}`, native_session_id: checkpoint?.native_session_id || `native_${attempt.id}` };
    },
    async observe() {
      harness?.checkpoint("codex_tui.before_observe");
      return structuredClone(nextObservation(queue) || { state: "running" });
    },
    async collect() {
      harness?.recordEffect("codex_tui.collect", evidence);
      return structuredClone(evidence);
    },
    async interrupt() {},
    async dispose() {},
  };
}
