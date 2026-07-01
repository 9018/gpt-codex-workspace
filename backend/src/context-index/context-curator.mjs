/**
 * context-curator.mjs — Stable minimal context package manifest.
 *
 * The curator does not retrieve or summarize independently. It records the
 * bounded entrypoint, generated bundle, retrieval diagnostics, and lookup
 * policy produced by the existing local context-index path.
 */

export const CONTEXT_MANIFEST_SCHEMA_VERSION = "gptwork.context_manifest.v1";

function artifact(path, { required = true, present = true, role = "context_curator" } = {}) {
  return {
    role,
    path: path || null,
    required: required === true,
    present: present !== false && Boolean(path),
  };
}

function countSelectedChunks(bundleResult, retrievalJson) {
  if (Number.isFinite(Number(retrievalJson?.selected_bundle_chunks))) return Number(retrievalJson.selected_bundle_chunks);
  if (Array.isArray(bundleResult?.selectedChunks)) return bundleResult.selectedChunks.length;
  return 0;
}

function manifestDiagnostics({ bundleResult = {}, retrievalJson = {} } = {}) {
  return {
    store_name: retrievalJson.store_name || null,
    requested_retrieval_mode: retrievalJson.requested_retrieval_mode || null,
    retrieval_mode: retrievalJson.retrieval_mode || null,
    fallback_reason: retrievalJson.fallback_reason || null,
    embedding_provider: retrievalJson.embedding_provider || null,
    store_capabilities: retrievalJson.store_capabilities || null,
    token_estimate: Number.isFinite(Number(bundleResult.tokenEstimate)) ? Number(bundleResult.tokenEstimate) : null,
    selected_bundle_chunks: countSelectedChunks(bundleResult, retrievalJson),
    merged_chunk_count: Number.isFinite(Number(retrievalJson.merged_chunk_count)) ? Number(retrievalJson.merged_chunk_count) : null,
    budget: retrievalJson.budget || null,
    selection: retrievalJson.selection || null,
  };
}

export function buildContextManifest({ goal = {}, workspaceFiles = {}, bundleResult = {}, retrievalJson = null, warnings = [] } = {}) {
  const files = workspaceFiles && typeof workspaceFiles === "object" ? workspaceFiles : {};
  const entrypoint = files.codex_entry_md || `.gptwork/goals/${goal.id || "unknown"}/codex.entry.md`;
  const contextBundle = files.context_bundle_md || `.gptwork/goals/${goal.id || "unknown"}/context.bundle.md`;
  const contextRetrieval = files.context_retrieval_json || `.gptwork/goals/${goal.id || "unknown"}/context.retrieval.json`;
  const contextManifest = files.context_manifest_json || `.gptwork/goals/${goal.id || "unknown"}/context.manifest.json`;
  const contextJson = files.context_json || `.gptwork/goals/${goal.id || "unknown"}/context.json`;
  const goalMd = files.goal_md || `.gptwork/goals/${goal.id || "unknown"}/goal.md`;
  const transcriptMd = files.transcript_md || `.gptwork/goals/${goal.id || "unknown"}/transcript.md`;

  return {
    schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
    goal_id: goal.id || null,
    workspace_id: goal.workspace_id || null,
    curator: {
      role: "context_curator",
      strategy: "minimal_context_package",
      external_api_used: false,
      source_chain: "local context-index with optional zvec/local-json store",
    },
    entrypoint,
    default_context_package: [entrypoint, contextBundle],
    artifacts: {
      codex_entry: artifact(entrypoint),
      context_bundle: artifact(contextBundle),
      context_retrieval: artifact(contextRetrieval, { required: false, present: Boolean(retrievalJson) }),
      context_manifest: artifact(contextManifest),
    },
    lookup_policy: {
      default_read_order: ["codex_entry", "context_bundle"],
      deep_lookup_files: {
        context_json: { path: contextJson, default_read: false, purpose: "targeted metadata lookup" },
        goal_md: { path: goalMd, default_read: false, purpose: "explicit deep goal lookup" },
        transcript_md: { path: transcriptMd, default_read: false, purpose: "explicit conversation lookup" },
      },
      payload_files_default_read: false,
    },
    diagnostics: manifestDiagnostics({ bundleResult, retrievalJson: retrievalJson || {} }),
    warnings: Array.isArray(warnings) ? warnings : [],
    generated_at: new Date().toISOString(),
  };
}
