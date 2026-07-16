export function createContextTelemetry(initial = {}) {
  const state = {
    initial_tool_schema_bytes: Number(initial.initialToolSchemaBytes) || 0,
    bundle_bytes: Number(initial.bundleBytes) || 0,
    candidate_tokens: Number(initial.candidateTokens) || 0,
    final_bundle_tokens: Number(initial.finalTokens) || 0,
    cache_hits: Number(initial.cacheHits) || 0,
    cache_misses: Number(initial.cacheMisses) || 0,
    supplemental_reads: Number(initial.supplementalReads) || 0,
    first_effective_tool_call_ms: initial.firstEffectiveToolCallMs ?? null,
  };

  return {
    record(values = {}) {
      if (values.initialToolSchemaBytes != null) state.initial_tool_schema_bytes = Number(values.initialToolSchemaBytes) || 0;
      if (values.bundleBytes != null) state.bundle_bytes = Number(values.bundleBytes) || 0;
      if (values.candidateTokens != null) state.candidate_tokens = Number(values.candidateTokens) || 0;
      if (values.finalTokens != null) state.final_bundle_tokens = Number(values.finalTokens) || 0;
      if (values.firstEffectiveToolCallMs != null) state.first_effective_tool_call_ms = Number(values.firstEffectiveToolCallMs) || 0;
      if (values.cacheHit === true) state.cache_hits += 1;
      if (values.cacheHit === false) state.cache_misses += 1;
      return this.snapshot();
    },
    recordSupplementalRead(count = 1) {
      state.supplemental_reads += Math.max(1, Math.floor(Number(count) || 1));
      return state.supplemental_reads;
    },
    snapshot() {
      return { ...state };
    },
  };
}
