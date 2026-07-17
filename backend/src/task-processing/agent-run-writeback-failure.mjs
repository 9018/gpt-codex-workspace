export function recordAgentRunWritebackFailure(taskResult, role, err) {
  if (!taskResult || typeof taskResult !== "object") return;
  const message = String(err?.message || err || "agent run writeback failed").slice(0, 500);
  taskResult.agent_run_writeback = Array.isArray(taskResult.agent_run_writeback) ? taskResult.agent_run_writeback : [];
  taskResult.agent_run_writeback.push({ role, status: "failed", reason: message });
  taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
  taskResult.warnings.push({ code: "agent_run_writeback_failed", role, severity: "warning", message });
}
