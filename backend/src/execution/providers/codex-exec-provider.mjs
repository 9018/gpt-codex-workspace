import { executeCodexTaskRun } from "../../task-codex-execution.mjs";

function executionFailure(result = {}, attempt = {}) {
  const cr = result.cr || {};
  if (cr.timed_out) {
    return { code: "execution_timeout", retry_count: Math.max(0, Number(attempt.attempt_number || 1) - 1) };
  }
  const noContent = result.parsedResult?._no_structured_summary === true
    || (!String(result.summary || "").trim() && Number(cr.stdout_bytes || 0) === 0 && Number(cr.stderr_bytes || 0) === 0);
  if (noContent) {
    return { code: "no_content_output", retry_count: Math.max(1, Number(attempt.attempt_number || 1) - 1) };
  }
  if (result.parsedResult?.status === "failed" || Number(cr.returncode ?? 0) !== 0) {
    const transportText = `${cr.stderr || ""}\n${result.summary || ""}`;
    if (/\b404\b[\s\S]*(?:\/v1\/responses|responses transport)|(?:\/v1\/responses)[\s\S]*\b404\b/i.test(transportText)) {
      return {
        code: "codex_transport_404",
        failure_class: "codex_transport_404",
        message: result.summary || cr.stderr || "Codex Responses provider returned 404",
        retry_count: Math.max(0, Number(attempt.attempt_number || 1) - 1),
        return_code: cr.returncode ?? null,
      };
    }
    return {
      code: result.parsedResult?._no_structured_summary ? "structured_result_failure" : "execution_failed",
      failure_class: result.parsedResult?.failure_class || "execution_failed",
      message: result.summary || cr.stderr || "Codex execution failed",
      retry_count: Math.max(0, Number(attempt.attempt_number || 1) - 1),
      return_code: cr.returncode ?? null,
    };
  }
  return null;
}

function evidenceFromResult(result = {}) {
  const parsed = result.parsedResult || {};
  const status = ["completed", "failed", "timed_out"].includes(parsed.status)
    ? parsed.status
    : (result.cr?.timed_out ? "timed_out" : Number(result.cr?.returncode ?? 0) === 0 ? "completed" : "failed");
  return {
    ...parsed,
    status,
    summary: parsed.summary || result.summary || "",
    changed_files: Array.isArray(parsed.changed_files) ? parsed.changed_files : [],
    tests: parsed.tests ?? [],
    commit: parsed.commit || null,
    remote_head: parsed.remote_head || null,
    verification: parsed.verification || { passed: status === "completed", commands: [] },
    native_session_id: result.codexMeta?.native_session_id || null,
  };
}

export function createCodexExecProvider({ executeCodexTaskRunFn = executeCodexTaskRun } = {}) {
  async function start(attempt, context = {}) {
    const result = await executeCodexTaskRunFn({
      ...context,
      executionId: context.executionId || attempt.id,
      controlSessionId: context.controlSessionId || attempt.id,
    });
    return {
      provider_run_id: attempt.id,
      attempt_id: attempt.id,
      native_session_id: result.codexMeta?.native_session_id || null,
      result,
      failure: executionFailure(result, attempt),
    };
  }

  return {
    name: "codex_exec",
    revision: "exec-adapter-v1",
    async available() { return true; },
    start,
    async resume(attempt, checkpoint, context = {}) {
      return start(attempt, { ...context, checkpoint });
    },
    async observe(handle) {
      if (handle?.failure) {
        return {
          state: handle.failure.code === "execution_timeout" ? "timed_out" : "failed",
          failure: handle.failure,
          native_session_id: handle.native_session_id || null,
        };
      }
      return { state: "evidence_ready", native_session_id: handle?.native_session_id || null };
    },
    async send() { return { accepted: false, reason: "codex_exec_is_non_interactive" }; },
    async interrupt(handle, context = {}) {
      if (typeof context.interruptExecFn === "function") return context.interruptExecFn(handle);
      return { interrupted: false, reason: "execution_already_collected" };
    },
    async collect(handle) { return evidenceFromResult(handle?.result); },
    async dispose() {},
  };
}
