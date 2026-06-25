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
// Safe retrieval JSON builder (cross-goal aware)
// ---------------------------------------------------------------------------

/**
 * Build a retrieval metadata JSON object from retrieval results.
 */
function buildRetrievalJson(goalId, crossGoalRetrieved, perGoalRetrieved, storeName, stored, workload) {
  return {
    goal_id: goalId,
    store_name: storeName,
    total_indexed: stored,
    cross_goal_retrieval: {
      enabled: true,
      retrieved_count: crossGoalRetrieved.length,
      cross_goal_chunks: crossGoalRetrieved.filter((r) => r.metadata?.goal_id !== goalId).length,
      results: crossGoalRetrieved.map((r) => ({
        id: r.id,
        score: r.score ?? null,
        goal_id: r.metadata?.goal_id || null,
        source_type: r.metadata?.source_type || "unknown",
        tokens: r.tokens,
        text_preview: r.text?.substring(0, 200),
      })),
    },
    per_goal_retrieval: {
      retrieved_count: perGoalRetrieved.length,
      results: perGoalRetrieved.map((r) => ({
        id: r.id,
        score: r.score ?? null,
        source_type: r.metadata?.source_type || "unknown",
        tokens: r.tokens,
        text_preview: r.text?.substring(0, 200),
      })),
    },
    merged_chunk_count: workload.length,
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
    const indexResult = await indexGoalContext({
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
      };
    }

    // ================================================================
    // P0: Two-phase retrieval — cross-goal + per-goal
    // ================================================================

    // Phase 1: Cross-goal retrieval (no goal_id filter)
    // This searches ALL indexed goals in the workspace for related context.
    // The local store's search method iterates all goal directories when
    // goal_id filter is absent, enabling cross-goal awareness.
    const crossGoalRetrieved = await retrieveContext({
      goalId: null,           // no goal filter — search all goals
      queryText,
      topK: 10,
      options: {
        workspaceRoot,
        storePrefer: indexResult.store,
        contextVectorStore: config?.contextVectorStore,
        embeddingConfig: { provider: "fallback" },
      },
      filters: {},            // no goal_id filter — cross-goal search
    });

    // Phase 2: Per-goal retrieval (current goal only)
    // This ensures the current goal's context is always represented,
    // even if cross-goal results dominate.
    const perGoalRetrieved = await retrieveContext({
      goalId: goal.id,
      queryText,
      topK: 5,
      options: {
        workspaceRoot,
        storePrefer: indexResult.store,
        contextVectorStore: config?.contextVectorStore,
        embeddingConfig: { provider: "fallback" },
      },
      filters: { goal_id: goal.id },
    });

    // Merge results: current-goal chunks first (priority), then cross-goal chunks
    // Deduplicate by chunk ID
    const seenIds = new Set();
    const mergedChunks = [];

    // Priority 1: Current goal chunks (per-goal retrieval)
    for (const chunk of perGoalRetrieved) {
      if (!seenIds.has(chunk.id)) {
        seenIds.add(chunk.id);
        mergedChunks.push(chunk);
      }
    }

    // Priority 2: Cross-goal chunks that are not current goal (related context)
    for (const chunk of crossGoalRetrieved) {
      if (!seenIds.has(chunk.id) && chunk.metadata?.goal_id !== goal.id) {
        seenIds.add(chunk.id);
        mergedChunks.push(chunk);
      }
    }

    // If we still have room, add remaining index chunks for context
    if (mergedChunks.length < 10) {
      for (const chunk of indexResult.chunks) {
        if (!seenIds.has(chunk.id) && mergedChunks.length < 10) {
          seenIds.add(chunk.id);
          mergedChunks.push(chunk);
        }
      }
    }

    // Build bundle from merged chunks
    const bundleResult = buildContextBundle({
      chunks: mergedChunks.length > 0 ? mergedChunks : indexResult.chunks.slice(0, 10),
      goal,
      workspaceFiles,
    });

    // Build retrieval JSON with cross-goal metadata
    const retrievalJson = buildRetrievalJson(
      goal.id,
      crossGoalRetrieved,
      perGoalRetrieved,
      indexResult.storeName,
      indexResult.stored,
      mergedChunks,
    );

    return {
      ok: true,
      bundle: bundleResult.bundle,
      tokenEstimate: bundleResult.tokenEstimate,
      retrievalJson,
    };
  } catch (err) {
    const warning = `Context index/bundle generation failed for goal ${goal.id}: ${err.message}`;
    console.warn("[context-index]", warning);
    return { ok: false, warning };
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
