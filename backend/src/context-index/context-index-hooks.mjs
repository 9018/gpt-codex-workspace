/**
 * context-index-hooks.mjs — Integration hooks for context-index into goal/task lifecycle.
 *
 * Provides `maybeBuildContextBundle` which attempts to index the goal context
 * and generate a context.bundle.md file.  Failures are caught and logged
 * without breaking the existing workflow.
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
 * @param {object} store
 * @param {object} state
 * @param {object} goal
 * @returns {Promise<Array<{ summary: string }>>}
 */
async function loadPriorResults(store, goal) {
  try {
    const state = await store.load();
    const priorGoals = (state.goals || [])
      .filter((g) => g.id !== goal.id && g.workspace_id === goal.workspace_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 5);

    const results = [];
    for (const prior of priorGoals) {
      try {
        const resultPath = `.gptwork/goals/${prior.id}/result.md`;
        const absPath = join(
          process.cwd(),
          resultPath
        );
        if (existsSync(absPath)) {
          const content = await readFile(absPath, "utf8");
          results.push({ summary: content.substring(0, 2000) });
        } else {
          results.push({ summary: `Goal ${prior.id}: ${prior.title || "untitled"}` });
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
// Safe retrieval JSON builder
// ---------------------------------------------------------------------------

/**
 * Build a retrieval metadata JSON object from retrieval results.
 */
function buildRetrievalJson(goalId, retrieved, storeName, stored) {
  return {
    goal_id: goalId,
    store_name: storeName,
    total_indexed: stored,
    retrieved_count: retrieved.length,
    retrieved_at: new Date().toISOString(),
    results: retrieved.map((r) => ({
      id: r.id,
      score: r.score ?? null,
      source_type: r.metadata?.source_type || "unknown",
      tokens: r.tokens,
      text_preview: r.text?.substring(0, 200),
    })),
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

    // Load prior results for context
    let priorResults = [];
    try {
      priorResults = await loadPriorResults(store, goal);
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

    // Retrieve relevant chunks
    const retrieved = await retrieveContext({
      goalId: goal.id,
      queryText,
      topK: 10,
      options: {
        workspaceRoot,
        storePrefer: indexResult.store,
        embeddingConfig: { provider: "fallback" },
      },
      filters: { goal_id: goal.id },
    });

    // Build bundle from retrieved chunks
    const bundleResult = buildContextBundle({
      chunks: retrieved.length > 0 ? retrieved : indexResult.chunks.slice(0, 10),
      goal,
      workspaceFiles,
    });

    // Build retrieval JSON
    const retrievalJson = buildRetrievalJson(
      goal.id,
      retrieved,
      indexResult.storeName,
      indexResult.stored
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
