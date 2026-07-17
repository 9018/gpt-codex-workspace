function nextObservation(queue) {
  return queue.length > 1 ? queue.shift() : queue[0];
}

export function createFakeCodexExecProvider({ observations = [{ state: "evidence_ready" }], evidence = { status: "completed" }, harness } = {}) {
  const queue = structuredClone(observations);
  return {
    name: "codex_exec",
    revision: "fake-exec-v1",
    async start(attempt) {
      harness?.recordEffect("codex_exec.start", { attempt_id: attempt.id });
      harness?.checkpoint("codex_exec.after_start", attempt);
      return { id: `exec_${attempt.id}` };
    },
    async resume(attempt) {
      harness?.recordEffect("codex_exec.resume", { attempt_id: attempt.id });
      return { id: `exec_${attempt.id}`, resumed: true };
    },
    async observe() {
      harness?.checkpoint("codex_exec.before_observe");
      return structuredClone(nextObservation(queue) || { state: "running" });
    },
    async collect() {
      harness?.recordEffect("codex_exec.collect", evidence);
      return structuredClone(evidence);
    },
    async interrupt() {},
    async dispose() {},
  };
}
