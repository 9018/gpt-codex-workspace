/**
 * retriever.mjs — Context indexer and retriever.
 *
 * Orchestrates chunking, embedding, indexing, and retrieval for a given
 * goal, conversation, and task context.  Builds an index on first call
 * and can search it for relevant context.
 */

import { randomUUID } from "node:crypto";
import { createEmbeddingProvider, embeddingProviderDiagnostics } from "./embeddings.mjs";
import { createVectorStore } from "./zvec-store.mjs";
import {
  chunkGoalContent,
  chunkMessages,
  chunkResult,
} from "./chunker.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ContextRetrievalOptions
 * @property {object}   goal
 * @property {object}   [conversation]       - Conversation object with .messages
 * @property {object}   [task]               - Task object for metadata
 * @property {object}   [config]             - Runtime config (workspaceRoot, etc.)
 * @property {Array<{ role: string, content: string }>} [extraMessages]
 * @property {Array<{ summary: string }>}    [priorResults]
 * @property {string}   [workspaceRoot]      - Override workspace root path
 */

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Build chunks with metadata from a goal and its conversation.
 *
 * @param {ContextRetrievalOptions} ctx
 * @returns {Promise<Array<{ id: string, text: string, tokens: number, metadata: object }>>}
 */
export async function buildIndexChunks(ctx) {
  const { goal, conversation, task, priorResults } = ctx;
  const now = new Date().toISOString();
  const chunks = [];

  const baseMeta = {
    workspace_id: goal.workspace_id || "hosted-default",
    project_id: goal.project_id || "default",
    repo_id: goal.repo_id || "",
    goal_id: goal.id,
    conversation_id: goal.conversation_id || "",
    task_id: task?.id || goal.task_id || "",
    created_at: now,
  };

  // 1. Goal content (title, user request, goal prompt, context summary)
  const goalChunks = chunkGoalContent(goal, {
    metadata: { ...baseMeta, source_type: "goal" },
  });
  for (const c of goalChunks) {
    chunks.push({
      id: `chunk_${randomUUID()}`,
      text: c.text,
      tokens: c.tokens,
      metadata: { ...c.metadata, chunk_index: c.index },
    });
  }

  // 2. Conversation messages
  const messages = conversation?.messages || [];
  if (messages.length > 0) {
    const msgChunks = chunkMessages(messages, {
      metadata: { ...baseMeta, source_type: "conversation" },
    });
    for (const c of msgChunks) {
      chunks.push({
        id: `chunk_${randomUUID()}`,
        text: c.text,
        tokens: c.tokens,
        metadata: { ...c.metadata, chunk_index: c.index },
      });
    }
  }

  // 3. Prior task result summaries
  if (Array.isArray(priorResults)) {
    for (let i = 0; i < priorResults.length; i++) {
      const text = priorResults[i].summary || priorResults[i].result_text || "";
      if (!text) continue;
      const rChunks = chunkResult(text, {
        metadata: { ...baseMeta, source_type: "result", result_index: i },
      });
      for (const c of rChunks) {
        chunks.push({
          id: `chunk_${randomUUID()}`,
          text: c.text,
          tokens: c.tokens,
          metadata: { ...c.metadata, chunk_index: c.index },
        });
      }
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Index and retrieve
// ---------------------------------------------------------------------------

/**
 * Index chunks for a goal and optionally run a retrieval query.
 *
 * @param {ContextRetrievalOptions} ctx
 * @returns {Promise<{ storeName: string, stored: number, chunks: Array, retrieval: Array|null }>}
 */
export async function indexGoalContext(ctx) {
  const { goal, config } = ctx;
  const workspaceRoot = ctx.workspaceRoot || config?.defaultWorkspaceRoot || process.cwd();

  // Build chunks
  const chunks = await buildIndexChunks(ctx);

  if (chunks.length === 0) {
    return { storeName: "none", stored: 0, chunks: [], retrieval: null };
  }

  // Get embedding provider (use fallback for MVP)
  const embedder = createEmbeddingProvider(ctx.embeddingConfig || { provider: "fallback" });

  // Get vectors for all chunks
  const texts = chunks.map((c) => c.text);
  const vectors = await embedder.embed(texts);

  // Create store (fallback to local if zvec unavailable)
  const store = await createVectorStore({
    workspaceRoot,
    dimension: embedder.dimension,
    prefer: ctx.storePrefer ?? config?.contextVectorStore,
    maxGoalsScanned: config?.contextMaxGoalsScanned,
  });

  await store.addChunks(chunks, vectors, { replace: true });

  return {
    storeName: store.name,
    stored: chunks.length,
    chunks,
    store,
    embeddingProvider: embeddingProviderDiagnostics(embedder),
  };
}

// ---------------------------------------------------------------------------
// Retrieval search
// ---------------------------------------------------------------------------

/**
 * Run a retrieval query against the indexed goal context.
 *
 * @param {object} params
 * @param {string}   params.goalId
 * @param {string}   params.queryText          - The query text to search for.
 * @param {{ workspaceRoot?: string, dimension?: number, storePrefer?: string, contextVectorStore?: string, embeddingConfig?: object, retrievalMode?: string }} [params.options]
 * @param {number}   [params.topK=5]
 * @param {object}   [params.filters={}]
 * @returns {Promise<Array<{ id: string, text: string, tokens: number, metadata: object, score: number }>>}
 */
export async function retrieveContext(params) {
  const { goalId = null, queryText, options = {}, topK = 5, filters = {} } = params;
  const workspaceRoot = options.workspaceRoot || process.cwd();

  const embedder = createEmbeddingProvider(options.embeddingConfig || { provider: "fallback" });
  const store = await createVectorStore({
    workspaceRoot,
    dimension: embedder.dimension,
    prefer: options.storePrefer ?? options.contextVectorStore,
    maxGoalsScanned: options.maxGoalsScanned,
  });

  const [queryVector] = await embedder.embed([queryText]);

  // P1: Support multi-dimension filters — workspace_id, project_id, repo_id,
  // source_type, time_decay.  Pass all filters to the store which applies
  // them during search.
  const searchFilters = { ...filters };
  if (goalId) searchFilters.goal_id = goalId;
  // Explicit filter keys supported by the store's search implementation
  for (const key of ["workspace_id", "project_id", "repo_id", "source_type"]) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== "") {
      searchFilters[key] = filters[key];
    }
  }

  // Time-decay weighting: results older than the decay threshold get a
  // score penalty.  This is handled as a post-search re-ranking step
  // since the vector store does not natively support time decay.
  const timeDecayDays = filters.time_decay ? Number(filters.time_decay) : 0;

  const results = await store.search(queryVector, topK, searchFilters, {
    retrievalMode: options.retrievalMode || "vector",
    queryText,
  });

  if (timeDecayDays > 0 && results.length > 0) {
    const now = Date.now();
    const decayMs = timeDecayDays * 24 * 60 * 60 * 1000;
    for (const r of results) {
      const createdAt = r.metadata?.created_at ? new Date(r.metadata.created_at).getTime() : 0;
      if (createdAt > 0 && (now - createdAt) > decayMs) {
        // Apply a decay penalty: score *= 0.5 for each decay period elapsed
        const periodsElapsed = Math.floor((now - createdAt) / decayMs);
        r.score = r.score * Math.pow(0.5, periodsElapsed);
        r.time_decayed = true;
        r.time_decay_periods = periodsElapsed;
      }
    }
    // Re-sort after time decay reweighting
    results.sort((a, b) => b.score - a.score);
  }

  Object.defineProperty(results, "embeddingProvider", {
    value: embeddingProviderDiagnostics(embedder),
    enumerable: false,
  });

  return results;
}
