/**
 * context-index-hooks.mjs — Integration hooks for context-index into goal/task lifecycle.
 *
 * Provides `maybeBuildContextBundle` which attempts to index the goal context
 * and generate a context.bundle.md file.  Failures are caught and logged
 * without breaking the existing workflow.
 *
 * ## Cross-Goal Retrieval (P0)
 *
 * The bundle builder performs two-phase retrieval:
 * 1. Cross-goal retrieval — searches all indexed goals in the workspace
 *    for related context (results, messages, goals) without goal_id filter.
 * 2. Per-goal retrieval — searches the current goal's index for precision.
 *
 * Results are merged with current-goal chunks prioritized. The retrieval JSON
 * records both phases, proving cross-goal awareness.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { indexGoalContext, retrieveContext } from "./retriever.mjs";
import { buildContextBundle } from "./context-bundle-builder.mjs";
import { buildContextManifest } from "./context-curator.mjs";

const DEFAULT_CROSS_GOAL_TOP_K = 4;
const DEFAULT_PER_GOAL_TOP_K = 4;
const DEFAULT_MERGED_CHUNK_LIMIT = 8;
const DEFAULT_BUNDLE_MAX_TOKENS = 2048;
const DEFAULT_MAX_GOALS_SCANNED = 20;

function positiveInt(value, fallback, min = 1, max = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function scopedRetrievalFilters(goal) {
  const filters = {};
  for (const key of ["workspace_id", "project_id", "repo_id"]) {
    const value = goal?.[key];
    if (value !== undefined && value !== null && value !== "") filters[key] = value;
  }
  return filters;
}

function mergeRetrievedChunks({ perGoalRetrieved = [], crossGoalRetrieved = [], indexChunks = [], goalId, limit = DEFAULT_MERGED_CHUNK_LIMIT }) {
  const selected = [];
  const seen = new Set();
  const cap = positiveInt(limit, DEFAULT_MERGED_CHUNK_LIMIT, 1, 20);
  const push = (chunk) => {
    if (!chunk || !chunk.id || seen.has(chunk.id) || selected.length >= cap) return;
    seen.add(chunk.id);
    selected.push(chunk);
  };

  // Keep current-goal context first, but cap it so cross-goal evidence can fit.
  for (const chunk of perGoalRetrieved.slice(0, Math.min(4, cap))) push(chunk);

  // Then add related prior context from the same workspace/project/repo scope.
  for (const chunk of crossGoalRetrieved) {
    if (chunk.metadata?.goal_id === goalId) continue;
    push(chunk);
  }

  // Finally add current indexing output as a deterministic fallback.
  const priority = { goal: 0, result: 1, conversation: 2 };
  const fallback = [...indexChunks].sort((a, b) => (priority[a.metadata?.source_type] ?? 9) - (priority[b.metadata?.source_type] ?? 9));
  for (const chunk of fallback) push(chunk);
  return selected;
}

// ---------------------------------------------------------------------------
// Intent & mutation scope analysis for retrieval filtering (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Determine if a goal has readonly or diagnostic intent.
 * @param {object} goal
 * @returns {boolean}
 */
export function isReadonlyOrDiagnosticGoal(goal) {
  if (!goal) return false;
  const mode = (goal.mode || "").toLowerCase();
  const title = (goal.title || "").toLowerCase();
  const userRequest = (goal.user_request || "").toLowerCase();
  const goalPrompt = (goal.goal_prompt || "").toLowerCase();
  const combined = `${title} ${userRequest} ${goalPrompt}`;

  // Direct mode check
  if (["readonly", "diagnostic"].includes(mode)) return true;
  // Text-based intent detection
  const readonlySignals = [
    "read-only", "readonly", "read only",
    "diagnostic", "inspect", "report findings",
    "do not modify", "do not change", "no mutations",
    "do not write", "do not edit",
  ];
  const mutationSignals = [
    "edit", "modify", "write file", "update config",
    "restart", "deploy", "commit", "reboot",
    "systemctl", "sed -i", "rm ",
  ];
  const hasReadonlySignal = readonlySignals.some((s) => combined.includes(s));
  const hasMutationSignal = mutationSignals.some((s) => combined.includes(s));
  if (hasReadonlySignal && !hasMutationSignal) return true;
  if (hasReadonlySignal && hasMutationSignal) {
    const roCount = readonlySignals.filter((s) => combined.includes(s)).length;
    const mutCount = mutationSignals.filter((s) => combined.includes(s)).length;
    return roCount >= mutCount;
  }
  return false;
}

/**
 * Analyze a chunk's text for mutation-related content.
 * @param {object} chunk
 * @returns {{ hasMutationContent: boolean, reason: string }}
 */
function analyzeChunkMutationContent(chunk) {
  const text = (chunk?.text || "").toLowerCase();
  const signals = [
    { pattern: /\bsystemctl\s+(restart|stop|start|enable|disable)\b/, label: "service_restart" },
    { pattern: /\bsed\s+-i\b/, label: "inline_edit" },
    { pattern: /\brm\s+(-\w+\s+)?(\/|\.)/, label: "file_delete" },
    { pattern: /\bgit\s+(commit|push|merge|rebase|checkout\s+-b)\b/, label: "git_mutation" },
    { pattern: /\bdeploy\b/, label: "deploy" },
    { pattern: /\brestart\s+(service|app|nginx|docker|system)/, label: "restart" },
    { pattern: /\breboot\b/, label: "reboot" },
    { pattern: /\b(edit|modify|write\s+to|update)\s+(file|config|settings|path)\b/, label: "file_mutation" },
    { pattern: /\bkubectl\s+(apply|delete|create|patch|rollout)\b/, label: "k8s_mutation" },
    { pattern: /\bdocker\s+(rm|kill|stop|start|restart|compose\s+(up|down))\b/, label: "docker_mutation" },
  ];
  const matches = [];
  for (const { pattern, label } of signals) {
    if (pattern.test(text)) matches.push(label);
  }
  return {
    hasMutationContent: matches.length > 0,
    reason: matches.length > 0 ? `mutation_signals:${matches.join(",")}` : "none",
  };
}

/**
 * Analyze a chunk's intent and mutation_scope from text and metadata.
 * @param {object} chunk
 * @returns {{ intent: string, mutation_scope: string }}
 */
function analyzeChunkIntent(chunk) {
  const { hasMutationContent } = analyzeChunkMutationContent(chunk);
  return {
    intent: hasMutationContent ? "mutation_imperative" : "readonly_diagnostic",
    mutation_scope: hasMutationContent ? "files_and_services" : "none",
  };
}


function retrievalDiagnosticsFrom(results) {
  return results?.retrievalDiagnostics || null;
}

function mergedRetrievalDiagnostics(crossGoalRetrieved, perGoalRetrieved) {
  const perGoal = retrievalDiagnosticsFrom(perGoalRetrieved);
  const crossGoal = retrievalDiagnosticsFrom(crossGoalRetrieved);
  const primary = perGoal || crossGoal || null;
  const fallbackReasons = [crossGoal?.fallback_reason, perGoal?.fallback_reason].filter(Boolean);
  return {
    primary,
    cross_goal: crossGoal,
    per_goal: perGoal,
    retrieval_mode: primary?.retrieval_mode || "vector",
    requested_retrieval_mode: primary?.requested_retrieval_mode || "vector",
    fallback_reason: fallbackReasons.length > 0 ? [...new Set(fallbackReasons)].join("; ") : null,
    keyword_query: primary?.keyword_query || crossGoal?.keyword_query || perGoal?.keyword_query || "",
    query_terms: primary?.query_terms || crossGoal?.query_terms || perGoal?.query_terms || [],
    store_capabilities: primary?.store_capabilities || crossGoal?.store_capabilities || perGoal?.store_capabilities || null,
  };
}

async function closeVectorStore(store) {
  if (store && typeof store.close === "function") {
    try {
      await store.close();
    } catch {
      // Best-effort lifecycle cleanup; bundle generation should not fail only because teardown failed.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load an existing transcript.md if it exists.
 * @param {string} workspaceRoot
 * @param {string} transcriptPath
 * @returns {Promise<string|null>}
 */
async function loadTranscriptIfExists(workspaceRoot, transcriptPath) {
  const abs = join(workspaceRoot, transcriptPath);
  if (!existsSync(abs)) return null;
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Load prior goal result summaries from the workspace.
 * Now also reads result.json for structured data in addition to result.md.
 *
 * @param {object} store
 * @param {string} workspaceRoot
 * @param {object} goal
 * @returns {Promise<Array<{ summary: string, goal_id: string, title: string, status: string }>>}
 */
export async function loadPriorResults(store, workspaceRoot, goal) {
  try {
    const state = await store.load();
    const priorGoals = (state.goals || [])
      .filter((g) => g.id !== goal.id && g.workspace_id === goal.workspace_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 5);

    const results = [];
    for (const prior of priorGoals) {
      const goalDir = join(workspaceRoot || process.cwd(), ".gptwork", "goals", prior.id);
      // Try result.json first (structured)
      const resultJsonPath = join(goalDir, "result.json");
      if (existsSync(resultJsonPath)) {
        try {
          const content = JSON.parse(await readFile(resultJsonPath, "utf8"));
          results.push({
            summary: content.summary || `Goal ${prior.id}: ${prior.title || "untitled"}`,
            goal_id: prior.id,
            title: prior.title || "untitled",
            status: content.status || prior.status || "unknown",
          });
          continue;
        } catch {
          // Invalid JSON, fall through to result.md
        }
      }
      // Fallback: result.md
      try {
        const resultPath = join(goalDir, "result.md");
        if (existsSync(resultPath)) {
          const content = await readFile(resultPath, "utf8");
          results.push({
            summary: content.substring(0, 2000),
            goal_id: prior.id,
            title: prior.title || "untitled",
            status: prior.status || "unknown",
          });
        } else {
          results.push({ summary: `Goal ${prior.id}: ${prior.title || "untitled"}`, goal_id: prior.id, title: prior.title || "untitled", status: prior.status || "unknown" });
        }
      } catch {
        // Skip unreadable results
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Fault injection support for safe degradation testing
// These validate resilience in edge cases without mocking whole modules.
// ---------------------------------------------------------------------------

/**
 * Load acceptance contract from the workspace, gracefully degrading on errors.
 * Phase 4: Fault injection -- missing/corrupted contracts are caught here.
 * @param {string} workspaceRoot
 * @param {string} goalId
 * @returns {Promise<{ contract: object|null, warning: string|null }>}
 */
export async function loadAcceptanceContractSafe(workspaceRoot, goalId) {
  if (!workspaceRoot || !goalId) {
    return { contract: null, warning: "No workspaceRoot or goalId provided" };
  }
  const contractPath = join(workspaceRoot, ".gptwork", "goals", goalId, "acceptance.contract.json");
  if (!existsSync(contractPath)) {
    return { contract: null, warning: null }; /* missing is valid -- no contract configured */
  }
  try {
    const raw = await readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { contract: null, warning: `acceptance.contract.json is not a valid object (goal ${goalId})` };
    }
    return { contract: parsed, warning: null };
  } catch (err) {
    return {
      contract: null,
      warning: `Failed to load acceptance.contract.json (goal ${goalId}): ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Safe retrieval JSON builder (cross-goal aware)
// ---------------------------------------------------------------------------

/**
 * Build a retrieval metadata JSON object from retrieval results.
 */
function buildRetrievalJson(goalId, crossGoalRetrieved, perGoalRetrieved, storeName, stored, workload, budget = {}) {
  const crossGoalEnabled = budget.crossGoalEnabled !== undefined ? Boolean(budget.crossGoalEnabled) : true;
  const embeddingProvider = budget.embeddingProvider ||
    perGoalRetrieved.embeddingProvider ||
    crossGoalRetrieved.embeddingProvider ||
    null;
  const diagnostics = mergedRetrievalDiagnostics(crossGoalRetrieved, perGoalRetrieved);
  const selectedChunks = Array.isArray(budget.selectedChunks) ? budget.selectedChunks : [];
  const selectionMetadata = budget.selectionMetadata || null;

  // Build candidate-level tracking with intent, mutation_scope, semantic_capability
  const crossGoalCandidates = crossGoalRetrieved.map((r) => {
    const isCrossGoal = r.metadata?.goal_id !== goalId;
    const { intent, mutation_scope } = analyzeChunkIntent(r);
    const semanticCapability = embeddingProvider?.semantic !== false;
    let included = true;
    let reason = "cross_goal_candidate";

    if (crossGoalEnabled) {
      if (embeddingProvider?.semantic === false) {
        included = false;
        reason = "non_semantic_embedding_cannot_distinguish";
      } else if (isCrossGoal && budget.isReadonlyGoal && intent === "mutation_imperative") {
        included = false;
        reason = "intent_mismatch_readonly_vs_mutation";
      }
    } else {
      included = false;
      reason = isCrossGoal ? "cross_goal_retrieval_disabled" : "current_goal_retrieval";
    }

    return {
      id: r.id,
      score: r.score ?? null,
      source_goal_id: r.metadata?.goal_id || null,
      source_type: r.metadata?.source_type || "unknown",
      tokens: r.tokens,
      included,
      reason,
      intent,
      mutation_scope,
      semantic_capability: semanticCapability,
      text_preview: r.text?.substring(0, 200),
    };
  });

  const perGoalCandidates = perGoalRetrieved.map((r) => {
    const { intent, mutation_scope } = analyzeChunkIntent(r);
    const semanticCapability = embeddingProvider?.semantic !== false;
    return {
      id: r.id,
      score: r.score ?? null,
      source_goal_id: r.metadata?.goal_id || null,
      source_type: r.metadata?.source_type || "unknown",
      tokens: r.tokens,
      included: true,
      reason: "per_goal_retrieval",
      intent,
      mutation_scope,
      semantic_capability: semanticCapability,
      text_preview: r.text?.substring(0, 200),
    };
  });

  const crossGoalDisabledWarning = !crossGoalEnabled ? [{
    type: "cross_goal_retrieval_disabled",
    message: "Cross-goal retrieval disabled; embedding provider is non-semantic",
    count: crossGoalRetrieved.length,
  }] : [];
  const intentMismatchCount = crossGoalCandidates.filter((c) => c.reason === "intent_mismatch_readonly_vs_mutation").length;
  const intentMismatchWarning = intentMismatchCount > 0 ? [{
    type: "intent_mismatch",
    message: `Readonly goal retrieving ${intentMismatchCount} mutation chunk(s)`,
    count: intentMismatchCount,
  }] : [];

  return {
    goal_id: goalId,
    store_name: storeName,
    total_indexed: stored,
    requested_retrieval_mode: diagnostics.requested_retrieval_mode,
    retrieval_mode: diagnostics.retrieval_mode,
    fallback_reason: diagnostics.fallback_reason,
    keyword_query: diagnostics.keyword_query,
    query_terms: diagnostics.query_terms,
    store_capabilities: diagnostics.store_capabilities,
    embedding_provider: embeddingProvider,
    cross_goal_retrieval: {
      enabled: crossGoalEnabled,
      disabled_reason: crossGoalEnabled ? null : "non_semantic_embedding",
      retrieval_mode: diagnostics.cross_goal?.retrieval_mode || diagnostics.retrieval_mode,
      fallback_reason: diagnostics.cross_goal?.fallback_reason || null,
      retrieved_count: crossGoalRetrieved.length,
      cross_goal_chunks: crossGoalRetrieved.filter((r) => r.metadata?.goal_id !== goalId).length,
      candidate_count: crossGoalCandidates.length,
      candidates: crossGoalCandidates,
      retrieval_warnings: [...crossGoalDisabledWarning, ...intentMismatchWarning],
    },
    per_goal_retrieval: {
      retrieval_mode: diagnostics.per_goal?.retrieval_mode || diagnostics.retrieval_mode,
      fallback_reason: diagnostics.per_goal?.fallback_reason || null,
      retrieved_count: perGoalRetrieved.length,
      results: perGoalRetrieved.map((r) => ({
        id: r.id,
        source_goal_id: r.metadata?.goal_id || null,
        score: r.score ?? null,
        source_type: r.metadata?.source_type || "unknown",
        tokens: r.tokens,
        text_preview: r.text?.substring(0, 200),
      })),
    },
    merged_chunk_count: workload.length,
    selected_bundle_chunks: selectedChunks.length,
    selection: {
      quota: selectionMetadata?.quotas || null,
      bucket_counts: selectionMetadata?.bucket_counts || {},
      source_budget_tokens: selectionMetadata?.source_budget_tokens || null,
      boosts: selectionMetadata?.boosts || null,
      results: selectedChunks.map((chunk) => ({
        id: chunk.id,
        goal_id: chunk.metadata?.goal_id || null,
        source_goal_id: chunk.metadata?.goal_id || null,
        source_type: chunk.metadata?.source_type || "unknown",
        score: chunk.score ?? null,
        tokens: chunk.tokens ?? null,
        why_selected: chunk.metadata?.selection?.why_selected || null,
        quota_bucket: chunk.metadata?.selection?.quota_bucket || null,
        boost_reason: chunk.metadata?.selection?.boost_reason || null,
        effective_score: chunk.metadata?.selection?.effective_score ?? null,
      })),
    },
    budget: {
      cross_goal_top_k: budget.crossGoalTopK ?? null,
      cross_goal_enabled: crossGoalEnabled,
      per_goal_top_k: budget.perGoalTopK ?? null,
      is_readonly_goal: budget.isReadonlyGoal ?? null,
      merged_chunk_limit: budget.mergedChunkLimit ?? null,
      bundle_max_tokens: budget.bundleMaxTokens ?? null,
      max_goals_scanned: budget.maxGoalsScanned ?? null,
      filters: budget.filters || {},
    },
    retrieved_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

/**
 * Attempt to build/update the context bundle for a goal.
 *
 * Safe to call anywhere in the goal/task lifecycle:
 * - On success: writes context.bundle.md and optionally context.retrieval.json
 * - On failure: returns cleanly with a warning, no exceptions thrown upward
 *
 * @param {object} store          - State store instance.
 * @param {object} config         - Runtime config.
 * @param {object} goal           - Goal object.
 * @param {object} [conversation] - Conversation object (with .messages).
 * @param {object} [task]         - Task object.
 * @param {object} [workspaceFiles] - Goal workspace file paths.
 * @param {object} [context]      - Auth context.
 * @returns {Promise<{ ok: boolean, bundle?: string, retrievalJson?: object, warning?: string }>}
 */
export async function maybeBuildContextBundle(
  store,
  config,
  goal,
  conversation = null,
  task = null,
  workspaceFiles = null,
  context = null
) {
  // If there's no goal, nothing to index
  if (!goal || !goal.id) {
    return { ok: false, warning: "No goal provided to maybeBuildContextBundle" };
  }

  // If the goal has no meaningful content to index, skip
  if (!goal.user_request && !goal.goal_prompt && !goal.context_summary && !goal.title) {
    return { ok: false, warning: `Goal ${goal.id} has no indexable content` };
  }

  let indexResult = null;
  try {
    const workspaceRoot = config?.defaultWorkspaceRoot || process.cwd();
    const transcriptPath = workspaceFiles?.transcript_md || `.gptwork/goals/${goal.id}/transcript.md`;

    // Load transcript for additional context if available
    let transcriptContent = null;
    try {
      transcriptContent = await loadTranscriptIfExists(workspaceRoot, transcriptPath);
    } catch {
      // Transcript not available
    }

    // Load prior results for context (P0: cross-goal awareness via prior result loading)
    let priorResults = [];
    try {
      priorResults = await loadPriorResults(store, workspaceRoot, goal);
    } catch {
      // Prior results not available
    }

    // Index the goal context
    indexResult = await indexGoalContext({
      goal,
      conversation,
      task,
      priorResults,
      config,
      workspaceRoot,
    });

    if (indexResult.stored === 0) {
      return { ok: false, warning: `Goal ${goal.id} index produced 0 chunks` };
    }

    // Build a query from goal content
    const queryText = [
      goal.user_request || "",
      goal.goal_prompt || "",
      goal.context_summary || "",
      goal.title || "",
    ].filter(Boolean).join("\n").substring(0, 2000);

    if (!queryText) {
      // Nothing to query with — still write a minimal bundle from indexed content
      const bundleResult = buildContextBundle({
        chunks: indexResult.chunks.slice(0, 10),
        goal,
        workspaceFiles,
      });
      return {
        ok: true,
        bundle: bundleResult.bundle,
        tokenEstimate: bundleResult.tokenEstimate,
        contextManifest: buildContextManifest({ goal, workspaceFiles, bundleResult }),
      };
    }

    // ================================================================
    // P0: Two-phase retrieval with Phase 2 hardening
    // - Cross-goal retrieval: skipped when semantic=false (non-semantic fallback)
    // - Per-goal retrieval: always runs for current goal precision
    // ================================================================

    // Phase 2 hardening: check semantic capability from embedding provider
    const embeddingProvider = indexResult.embeddingProvider;
    const isSemantic = embeddingProvider?.semantic !== false;
    const crossGoalEnabled = isSemantic;
    console.warn(
      `[context-index] embedding provider="${embeddingProvider?.name}" semantic=${embeddingProvider?.semantic} crossGoalEnabled=${crossGoalEnabled}`
    );

    // Phase 1: Cross-goal retrieval (no goal_id filter)
    // This searches ALL indexed goals in the workspace for related context.
    // The local store's search method iterates all goal directories when
    // goal_id filter is absent, enabling cross-goal awareness.
    const retrievalScope = scopedRetrievalFilters(goal);
    const crossGoalTopK = positiveInt(config?.contextCrossGoalTopK, DEFAULT_CROSS_GOAL_TOP_K, 0, 20);
    const perGoalTopK = positiveInt(config?.contextPerGoalTopK, DEFAULT_PER_GOAL_TOP_K, 1, 20);
    const mergedChunkLimit = positiveInt(config?.contextBundleMaxChunks, DEFAULT_MERGED_CHUNK_LIMIT, 1, 20);
    const bundleMaxTokens = positiveInt(config?.contextBundleMaxTokens, DEFAULT_BUNDLE_MAX_TOKENS, 256, 16000);
    const maxGoalsScanned = positiveInt(config?.contextMaxGoalsScanned, DEFAULT_MAX_GOALS_SCANNED, 1, 100);

    const crossGoalRetrieved = crossGoalEnabled && crossGoalTopK > 0 ? await retrieveContext({
      goalId: null,           // no goal filter — search scoped prior goals
      queryText,
      topK: crossGoalTopK,
      options: {
        workspaceRoot,
        storePrefer: indexResult.store,
        contextVectorStore: config?.contextVectorStore,
        maxGoalsScanned,
        retrievalMode: "hybrid",
        embeddingConfig: { provider: "fallback" },
      },
      filters: retrievalScope,
    }) : [];
    if (!crossGoalEnabled && crossGoalTopK > 0) {
      console.warn(`[context-index] Cross-goal retrieval skipped: semantic=${embeddingProvider?.semantic} name="${embeddingProvider?.name}"`);
    }

    // Phase 2: Per-goal retrieval (current goal only)
    // This ensures the current goal's context is always represented,
    // even if cross-goal results dominate.
    const perGoalRetrieved = await retrieveContext({
      goalId: goal.id,
      queryText,
      topK: perGoalTopK,
      options: {
        workspaceRoot,
        storePrefer: indexResult.store,
        contextVectorStore: config?.contextVectorStore,
        maxGoalsScanned,
        retrievalMode: "hybrid",
        embeddingConfig: { provider: "fallback" },
      },
      filters: { ...retrievalScope, goal_id: goal.id },
    });

    // Merge with hard caps: current goal first, scoped prior context second,
    // deterministic current chunks as fallback. This prevents long GPTChat
    // histories from expanding Codex's initial context.
    const mergedChunks = mergeRetrievedChunks({
      perGoalRetrieved,
      crossGoalRetrieved,
      indexChunks: indexResult.chunks,
      goalId: goal.id,
      limit: mergedChunkLimit,
    });

    // Build bundle from merged chunks
    const bundleResult = buildContextBundle({
      chunks: mergedChunks.length > 0 ? mergedChunks : indexResult.chunks.slice(0, mergedChunkLimit),
      goal,
      task,
      workspaceFiles,
      maxTokens: bundleMaxTokens,
      maxChunks: mergedChunkLimit,
    });

    // Build retrieval JSON with cross-goal metadata and intent filtering
    const isReadonlyGoal = isReadonlyOrDiagnosticGoal(goal);
    const retrievalJson = buildRetrievalJson(
      goal.id,
      crossGoalRetrieved,
      perGoalRetrieved,
      indexResult.storeName,
      indexResult.stored,
      mergedChunks,
      {
        crossGoalEnabled,
        crossGoalTopK,
        perGoalTopK,
        mergedChunkLimit,
        bundleMaxTokens,
        maxGoalsScanned,
        filters: retrievalScope,
        embeddingProvider,
        isReadonlyGoal,
        selectedChunks: bundleResult.selectedChunks,
        selectionMetadata: bundleResult.selectionMetadata,
      },
    );

    // Build warnings for context manifest (Phase 2)
    const manifestWarnings = [];
    if (embeddingProvider?.semantic === false) {
      manifestWarnings.push({
        type: "non_semantic_embedding",
        message: `Embedding provider "${embeddingProvider.name}" is non-semantic (semantic=${embeddingProvider.semantic})`,
        embedding_provider_name: embeddingProvider.name,
        dimension: embeddingProvider.dimension,
        count: 1,
      });
    }
    if (!crossGoalEnabled) {
      manifestWarnings.push({
        type: "cross_goal_retrieval_disabled",
        message: "Cross-goal retrieval disabled due to non-semantic embedding",
        cross_goal_top_k: crossGoalTopK,
        count: crossGoalRetrieved.length,
      });
    }
    // Add intent mismatch warning from retrieval JSON if present
    if (retrievalJson?.cross_goal_retrieval?.candidates) {
      const intentMismatchCount = retrievalJson.cross_goal_retrieval.candidates.filter(
        (c) => c.reason === "intent_mismatch_readonly_vs_mutation"
      ).length;
      if (intentMismatchCount > 0) {
        manifestWarnings.push({
          type: "intent_mismatch",
          message: `Readonly goal has ${intentMismatchCount} cross-goal chunk(s) with mutation intent`,
          count: intentMismatchCount,
        });
      }
    }

    return {
      ok: true,
      bundle: bundleResult.bundle,
      tokenEstimate: bundleResult.tokenEstimate,
      retrievalJson,
      contextManifest: buildContextManifest({ goal, workspaceFiles, bundleResult, retrievalJson, warnings: manifestWarnings }),
    };
  } catch (err) {
    const warning = `Context index/bundle generation failed for goal ${goal.id}: ${err.message}`;
    console.warn("[context-index]", warning);
    return { ok: false, warning };
  } finally {
    await closeVectorStore(indexResult?.store);
  }
}

// ---------------------------------------------------------------------------
// Legacy shorthand
// ---------------------------------------------------------------------------

/**
 * Attempt to build a context bundle.  Returns null on failure.
 * Convenience wrapper for callers that only want the bundle string.
 *
 * @param {object} store
 * @param {object} config
 * @param {object} goal
 * @param {object} [conversation]
 * @param {object} [task]
 * @returns {Promise<string|null>}
 */
export async function tryBuildContextBundle(store, config, goal, conversation, task) {
  const result = await maybeBuildContextBundle(store, config, goal, conversation, task);
  return result.ok ? result.bundle : null;
}
