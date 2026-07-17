export function recordAgentValueTelemetry(input = {}) {
  return {
    role: input.role || "unknown",
    latency_ms: Math.max(0, Number(input.latency_ms) || 0),
    token_count: Math.max(0, Number(input.token_count) || 0),
    cost_usd: Math.max(0, Number(input.cost_usd) || 0),
    finding_count: Math.max(0, Number(input.finding_count) || 0),
    prevented_failure: input.prevented_failure === true,
    repair_contribution: input.repair_contribution || null,
    recorded_at: input.recorded_at || new Date().toISOString(),
  };
}

export function summarizeAgentValueTelemetry(records = []) {
  const summary = { count: 0, latency_ms: 0, token_count: 0, cost_usd: 0, finding_count: 0, prevented_failures: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = recordAgentValueTelemetry(record);
    summary.count += 1;
    summary.latency_ms += normalized.latency_ms;
    summary.token_count += normalized.token_count;
    summary.cost_usd += normalized.cost_usd;
    summary.finding_count += normalized.finding_count;
    if (normalized.prevented_failure) summary.prevented_failures += 1;
  }
  return summary;
}
