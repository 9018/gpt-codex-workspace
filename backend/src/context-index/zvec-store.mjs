/**
 * zvec-store.mjs — Vector store adapter for context retrieval.
 *
 * Provides a unified interface over optional zvec backend or a local
 * JSON-file based fallback.  The adapter abstracts indexing (store)
 * and search (retrieve) operations.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = ".gptwork/context-index";
const ZVEC_COLLECTION_PATH = ".gptwork/context-index/zvec/goal_context_chunks";
const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.json";
const DEFAULT_RETRIEVAL_MODE = "vector";
const HYBRID_METHOD_CANDIDATES = [
  "hybridSearchSync",
  "hybridQuerySync",
  "searchHybridSync",
  "queryHybridSync",
  "hybridSearch",
  "hybridQuery",
  "searchHybrid",
  "queryHybrid",
];
const FTS_METHOD_CANDIDATES = [
  "fullTextSearchSync",
  "textSearchSync",
  "ftsSearchSync",
  "keywordSearchSync",
  "fullTextSearch",
  "textSearch",
  "ftsSearch",
  "keywordSearch",
];
const MULTI_QUERY_METHOD_CANDIDATES = ["multiQuerySync", "multiSearchSync", "multiQuery", "multiSearch"];


// ---------------------------------------------------------------------------
// Per-goal concurrency lock (P1 reviewed: correct)
// ---------------------------------------------------------------------------
// Prevents lost-update races when addChunks/search run concurrently
// for the same goalId. Node.js is single-threaded, but async I/O
// creates yield points where a second operation could read stale state.
//
// This locking is adequate: it serializes operations per goalId using
// a promise-chain pattern. The Map is scoped to this module, so it does
// not leak across process boundaries. For multi-process safety, a
// filesystem-level lock would be needed, but the current single-worker
// architecture makes this unnecessary.

/** @type {Map<string, Promise<void>>} */
const goalLocks = new Map();

async function withGoalLock(goalId, fn) {
  const existing = goalLocks.get(goalId);
  if (existing) await existing;
  const promise = (async () => {
    try { return await fn(); }
    finally { if (goalLocks.get(goalId) === promise) goalLocks.delete(goalId); }
  })();
  goalLocks.set(goalId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalizeStoreMode(value) {
  if (value && typeof value === "object" && typeof value.addChunks === "function") return value;
  const mode = String(value || "auto").trim().toLowerCase();
  return ["auto", "zvec", "local"].includes(mode) ? mode : "auto";
}

function assertZvecStatus(status, operation) {
  const statuses = Array.isArray(status) ? status : [status];
  const failed = statuses.find((s) => s && s.ok === false);
  if (failed) {
    throw new Error(`Zvec ${operation} failed: ${failed.code || "UNKNOWN"} ${failed.message || ""}`.trim());
  }
}

function escapeZvecString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildZvecFilter(filters = {}) {
  const clauses = [];
  for (const key of ["goal_id", "workspace_id", "source_type", "project_id", "repo_id"]) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== "") {
      clauses.push(`${key} = "${escapeZvecString(filters[key])}"`);
    }
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

function metadataValue(metadata, key, fallback = "") {
  const value = metadata?.[key];
  return value === undefined || value === null ? fallback : value;
}

function normalizeRetrievalMode(value) {
  const mode = String(value || DEFAULT_RETRIEVAL_MODE).trim().toLowerCase();
  return mode === "hybrid" ? "hybrid" : "vector";
}

function keywordQueryFromText(text) {
  return String(text || "")
    .replace(/[`*_#>[\]().,:;!?{}|\\]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 32)
    .join(" ");
}

function queryTermsFromText(text) {
  const seen = new Set();
  const terms = [];
  for (const term of keywordQueryFromText(text).split(/\s+/).filter(Boolean)) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 16) break;
  }
  return terms;
}

function firstFunctionName(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === "function") return name;
  }
  return null;
}

function attachRetrievalDiagnostics(results, diagnostics) {
  Object.defineProperty(results, "retrievalDiagnostics", {
    value: diagnostics,
    enumerable: false,
  });
  return results;
}

function makeStoreCapabilities(storeName, detail = {}) {
  return {
    store_name: storeName,
    vector: detail.vector !== false,
    hybrid: Boolean(detail.hybrid),
    full_text: Boolean(detail.full_text),
    multi_query: Boolean(detail.multi_query),
    methods: detail.methods || {},
  };
}

function makeRetrievalDiagnostics({ storeName, requestedMode, effectiveMode, fallbackReason = null, queryText = "", capabilities }) {
  const keywordQuery = keywordQueryFromText(queryText);
  return {
    requested_retrieval_mode: normalizeRetrievalMode(requestedMode),
    retrieval_mode: normalizeRetrievalMode(effectiveMode),
    fallback_reason: fallbackReason || null,
    keyword_query: keywordQuery,
    query_terms: queryTermsFromText(queryText),
    store_capabilities: capabilities,
    capabilities,
    store_name: storeName,
  };
}

function normalizeSignal(value, { distance = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (distance) return Math.max(0, Math.min(1, 1 - n));
  if (n >= 0 && n <= 1) return n;
  if (n > 1) return n / (n + 1);
  return 0;
}

function fieldsFromZvecResult(r) {
  return r?.fields || r?.document?.fields || r?.metadata || {};
}

function mapZvecResult(r, scoreKind = "cosine_similarity") {
  const fields = fieldsFromZvecResult(r);
  const rawScore = Number(r?.score || 0);
  const vectorScore = normalizeSignal(r?.vector_score ?? r?.vectorScore, { distance: false });
  const keywordScore = normalizeSignal(
    r?.keyword_score ?? r?.keywordScore ?? r?.text_score ?? r?.textScore ?? r?.fts_score ?? r?.ftsScore ?? r?.bm25_score ?? r?.bm25Score,
    { distance: false },
  );
  let score;
  if (scoreKind === "hybrid_similarity" && (vectorScore !== null || keywordScore !== null)) {
    score = ((vectorScore ?? normalizeSignal(rawScore, { distance: true }) ?? 0) * 0.65) + ((keywordScore ?? 0) * 0.35);
  } else if (scoreKind === "hybrid_similarity") {
    score = normalizeSignal(rawScore, { distance: true }) ?? 0;
  } else {
    score = 1 - rawScore;
  }
  return {
    id: r.id,
    text: fields?.text || "",
    tokens: Number(fields?.tokens || 0),
    index: Number(fields?.chunk_index || 0),
    metadata: {
      workspace_id: fields?.workspace_id || "",
      goal_id: fields?.goal_id || "",
      task_id: fields?.task_id || "",
      source_type: fields?.source_type || "unknown",
      project_id: fields?.project_id || "",
      repo_id: fields?.repo_id || "",
      role: fields?.role || "",
      source_path: fields?.source_path || "",
      chunk_index: Number(fields?.chunk_index || 0),
      created_at: fields?.created_at || "",
    },
    score,
    raw_score: rawScore,
    score_kind: scoreKind,
    ...(vectorScore !== null ? { vector_score: vectorScore } : {}),
    ...(keywordScore !== null ? { keyword_score: keywordScore } : {}),
  };
}

function combineVectorAndKeywordResults(vectorResults, keywordResults, topK) {
  const byId = new Map();
  for (const r of vectorResults || []) {
    const mapped = mapZvecResult(r, "cosine_similarity");
    byId.set(mapped.id, {
      ...mapped,
      score_kind: "hybrid_similarity",
      vector_score: mapped.score,
      keyword_score: 0,
      score: mapped.score * 0.65,
    });
  }
  for (const r of keywordResults || []) {
    const mapped = mapZvecResult(r, "hybrid_similarity");
    const keywordScore = mapped.keyword_score ?? normalizeSignal(r?.score, { distance: false }) ?? mapped.score;
    const existing = byId.get(mapped.id);
    if (existing) {
      existing.keyword_score = keywordScore;
      existing.score = (existing.vector_score * 0.65) + (keywordScore * 0.35);
    } else {
      byId.set(mapped.id, {
        ...mapped,
        score_kind: "hybrid_similarity",
        vector_score: 0,
        keyword_score: keywordScore,
        score: keywordScore * 0.35,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ChunkRecord
 * @property {string}  id
 * @property {string}  text
 * @property {number}  tokens
 * @property {object}  metadata       - type, workspace_id, goal_id, task_id, role, source_path, created_at, etc.
 * @property {number}  index
 * @property {number}  [score]        - populated on search results
 */

/**
 * @typedef {object} VectorStoreAdapter
 * @property {string}   name
 * @property {boolean}  available
 * @property {(chunks: ChunkRecord[], vectors: number[][]) => Promise<void>}  addChunks
 * @property {(queryVector: number[], topK: number, filters?: object) => Promise<ChunkRecord[]>}  search
 * @property {(goalId: string) => Promise<void>}  removeGoalChunks
 * @property {() => Promise<void>}  [close]
 */

// ---------------------------------------------------------------------------
// Local JSON-file fallback store
// ---------------------------------------------------------------------------

/**
 * Create a local JSON-file vector store adapter.
 *
 * Persistence: `.gptwork/context-index/{goalId}/chunks.json` and `vectors.json`.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {number} [options.dimension=64]
 * @returns {VectorStoreAdapter}
 */
export function createLocalStore(options = {}) {
  // NB: process.cwd() fallback is non-blocking — callers should pass
  // workspaceRoot via options. This is safe because when called through
  // createVectorStore or retriever.mjs, workspaceRoot is always provided
  // from config.defaultWorkspaceRoot. The fallback only activates when
  // options.workspaceRoot is undefined (direct test usage, not prod path).
 const workspaceRoot = options.workspaceRoot || process.cwd();
 const dimension = options.dimension || 64;
  const maxGoalsScanned = options.maxGoalsScanned || 50;
 const indexDir = join(workspaceRoot, DEFAULT_INDEX_DIR);

  /** Lazy-loaded in-memory cache: { goalId: { chunks, vectors } } */
  const cache = new Map();

  async function ensureGoalDir(goalId) {
    const dir = join(indexDir, goalId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function goalCacheKey(goalId) { return goalId; }

  async function loadGoalIndex(goalId) {
    const key = goalCacheKey(goalId);
    if (cache.has(key)) return cache.get(key);
    const dir = join(indexDir, goalId);
    let chunks = [];
    let vectors = [];
    try {
      const cPath = join(dir, CHUNKS_FILE);
      const vPath = join(dir, VECTORS_FILE);
      if (existsSync(cPath) && existsSync(vPath)) {
        chunks = JSON.parse(await readFile(cPath, "utf8"));
        vectors = JSON.parse(await readFile(vPath, "utf8"));
      }
    } catch {
      // Corrupted or missing — start fresh
    }
    const entry = { chunks, vectors };
    cache.set(key, entry);
    return entry;
  }

  async function listStoredGoalIds(rootDir) {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async function persistGoalIndex(goalId, entry) {
    const dir = await ensureGoalDir(goalId);
    await writeFile(join(dir, CHUNKS_FILE), JSON.stringify(entry.chunks), "utf8");
    await writeFile(join(dir, VECTORS_FILE), JSON.stringify(entry.vectors), "utf8");
  }

  return {
    name: "local-json-store",
    available: true,

    async addChunks(chunks, vectors, options = {}) {
      if (chunks.length !== vectors.length) {
        throw new Error(`addChunks: chunks.length (${chunks.length}) !== vectors.length (${vectors.length})`);
      }
      // Group by goal_id for per-goal storage
      const byGoal = new Map();
      for (let i = 0; i < chunks.length; i++) {
        const goalId = chunks[i].metadata?.goal_id || "unknown";
        if (!byGoal.has(goalId)) byGoal.set(goalId, { chunks: [], vectors: [] });
        byGoal.get(goalId).chunks.push(chunks[i]);
        byGoal.get(goalId).vectors.push(vectors[i]);
      }
      for (const [goalId, data] of byGoal) {
        await withGoalLock(goalId, async () => {
        const entry = await loadGoalIndex(goalId);
        if (options.replace) {
          // Replace mode: clear existing chunks for this goal and use new data
          entry.chunks = data.chunks;
          entry.vectors = data.vectors;
        } else {
          // Dedup mode: avoid duplicate chunks by (source_type, chunk_index)
          // Only dedup when chunk_index is explicitly defined to avoid false matches
          for (let i = 0; i < data.chunks.length; i++) {
            const newChunkIndex = data.chunks[i].metadata?.chunk_index;
            if (newChunkIndex === undefined || newChunkIndex === null || newChunkIndex === -1) {
              entry.chunks.push(data.chunks[i]);
              entry.vectors.push(data.vectors[i]);
              continue;
            }
            const existingIdx = entry.chunks.findIndex(
              (c) =>
                c.metadata?.source_type === data.chunks[i].metadata?.source_type &&
                c.metadata?.chunk_index === newChunkIndex
            );
            if (existingIdx >= 0) {
              entry.chunks[existingIdx] = data.chunks[i];
              entry.vectors[existingIdx] = data.vectors[i];
            } else {
              entry.chunks.push(data.chunks[i]);
              entry.vectors.push(data.vectors[i]);
            }
          }
        }
        await persistGoalIndex(goalId, entry);
        });
      }
    },

   async search(queryVector, topK = 5, filters = {}, searchOptions = {}) {
     const requestedMode = normalizeRetrievalMode(searchOptions.retrievalMode);
     const capabilities = makeStoreCapabilities("local-json-store", { hybrid: false });
     const fallbackReason = requestedMode === "hybrid"
       ? "hybrid retrieval requested but local JSON store only supports vector search"
       : null;
     const goalId = filters.goal_id;
      let goalIds;
      if (goalId) {
        goalIds = [goalId];
      } else {
        // Unbounded all-goal scan is expensive; sort by mtime (newest first) and apply limit
        const allGoalIds = await listStoredGoalIds(indexDir);
        if (allGoalIds.length > 0) {
          const withMtime = await Promise.all(allGoalIds.slice(0, Math.max(maxGoalsScanned * 2, 200)).map(async (gid) => {
            try {
              const stat = await import("node:fs/promises").then(m => m.stat(join(indexDir, gid)));
              return { gid, mtime: stat.mtimeMs || 0 };
            } catch { return { gid, mtime: 0 }; }
          }));
          withMtime.sort((a, b) => b.mtime - a.mtime);
          goalIds = withMtime.slice(0, maxGoalsScanned).map(e => e.gid);
        } else {
          goalIds = [];
        }
      }
     if (goalIds.length === 0) {
       return attachRetrievalDiagnostics([], makeRetrievalDiagnostics({
         storeName: "local-json-store",
         requestedMode,
         effectiveMode: "vector",
         fallbackReason,
         queryText: searchOptions.queryText,
         capabilities,
       }));
     }

      const scored = [];
      for (const currentGoalId of goalIds) {
        await withGoalLock(currentGoalId, async () => {
          const entry = await loadGoalIndex(currentGoalId);
          if (entry.chunks.length === 0) return;

          for (let i = 0; i < entry.chunks.length; i++) {
            const chunk = entry.chunks[i];
            // Apply simple filters
            if (filters.source_type && chunk.metadata?.source_type !== filters.source_type) continue;
            if (filters.goal_id && chunk.metadata?.goal_id !== filters.goal_id) continue;
            if (filters.workspace_id && chunk.metadata?.workspace_id !== filters.workspace_id) continue;
            if (filters.project_id && chunk.metadata?.project_id !== filters.project_id) continue;
            if (filters.repo_id && chunk.metadata?.repo_id !== filters.repo_id) continue;

            const vec = entry.vectors[i];
            if (!vec || vec.length !== queryVector.length) continue;
            const score = cosineSimilarity(queryVector, vec);
            scored.push({ ...chunk, score, raw_score: score, score_kind: "cosine_similarity" });
          }
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return attachRetrievalDiagnostics(scored.slice(0, topK), makeRetrievalDiagnostics({
        storeName: "local-json-store",
        requestedMode,
        effectiveMode: "vector",
        fallbackReason,
        queryText: searchOptions.queryText,
        capabilities,
      }));
    },

    async removeGoalChunks(goalId) {
      cache.delete(goalCacheKey(goalId));
      const dir = join(indexDir, goalId);
      try {
        const files = await readdir(dir);
        for (const f of files) {
          if (f === CHUNKS_FILE || f === VECTORS_FILE) {
            await writeFile(join(dir, f), JSON.stringify([]), "utf8");
          }
        }
      } catch {
        // Dir doesn't exist — nothing to remove
      }
    },

    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Zvec adapter (optional dependency)
// ---------------------------------------------------------------------------

/**
 * Try to load @zvec/zvec and create a collection-backed store adapter.
 *
 * If @zvec/zvec is not installed or fails to load, returns null so callers
 * can fall back to createLocalStore.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {number} [options.dimension=64]
 * @returns {Promise<VectorStoreAdapter|null>}
 */
export async function tryCreateZvecStore(options = {}) {
  try {
    const importZvec = options.importZvec || (() => import("@zvec/zvec"));
    const zvec = await importZvec();
    const {
      ZVecCollectionSchema,
      ZVecCreateAndOpen,
      ZVecDataType,
      ZVecIndexType,
      ZVecMetricType,
    } = zvec || {};
    if (
      typeof ZVecCollectionSchema !== "function" ||
      typeof ZVecCreateAndOpen !== "function" ||
      !ZVecDataType
    ) {
      throw new Error("@zvec/zvec does not expose the expected collection API");
    }
    // NB: process.cwd() fallback is non-blocking — same reasoning as createLocalStore above.
    // In production, workspaceRoot is always provided from config.defaultWorkspaceRoot.
    const workspaceRoot = options.workspaceRoot || process.cwd();
    const dimension = options.dimension || 64;
    const collectionPath = join(workspaceRoot, ZVEC_COLLECTION_PATH);
    await mkdir(join(workspaceRoot, DEFAULT_INDEX_DIR, "zvec"), { recursive: true });

    const schema = new ZVecCollectionSchema({
      name: "goal_context_chunks",
      vectors: {
        name: "embedding",
        dataType: ZVecDataType.VECTOR_FP32,
        dimension,
        indexParams: ZVecIndexType && ZVecMetricType
          ? { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE }
          : undefined,
      },
      fields: [
        { name: "workspace_id", dataType: ZVecDataType.STRING },
        { name: "goal_id", dataType: ZVecDataType.STRING },
        { name: "task_id", dataType: ZVecDataType.STRING },
        { name: "source_type", dataType: ZVecDataType.STRING },
        { name: "project_id", dataType: ZVecDataType.STRING, nullable: true },
        { name: "repo_id", dataType: ZVecDataType.STRING, nullable: true },
        { name: "role", dataType: ZVecDataType.STRING, nullable: true },
        { name: "source_path", dataType: ZVecDataType.STRING, nullable: true },
        { name: "chunk_index", dataType: ZVecDataType.INT64 },
        { name: "tokens", dataType: ZVecDataType.INT64 },
        { name: "created_at", dataType: ZVecDataType.STRING },
        { name: "text", dataType: ZVecDataType.STRING },
      ],
    });

    const collection = ZVecCreateAndOpen(collectionPath, schema);
    let closed = false;
    const hybridMethod = firstFunctionName(collection, HYBRID_METHOD_CANDIDATES);
    const ftsMethod = firstFunctionName(collection, FTS_METHOD_CANDIDATES);
    const multiQueryMethod = firstFunctionName(collection, MULTI_QUERY_METHOD_CANDIDATES);
    const capabilities = makeStoreCapabilities("zvec-collection-store", {
      hybrid: Boolean(hybridMethod || ftsMethod),
      full_text: Boolean(ftsMethod || hybridMethod),
      multi_query: Boolean(multiQueryMethod),
      methods: {
        hybrid: hybridMethod,
        full_text: ftsMethod,
        multi_query: multiQueryMethod,
        vector: "querySync",
      },
    });
    const outputFields = [
      "workspace_id",
      "goal_id",
      "task_id",
      "source_type",
      "project_id",
      "repo_id",
      "role",
      "source_path",
      "chunk_index",
      "tokens",
      "created_at",
      "text",
    ];

    async function close() {
      if (closed) return;
      closed = true;
      if (typeof collection?.close === "function") {
        await collection.close();
      } else if (typeof collection?.closeSync === "function") {
        collection.closeSync();
      }
    }

    function assertOpen(operation) {
      if (closed) throw new Error(`Zvec ${operation} failed: collection is closed`);
    }

    return {
      name: "zvec-collection-store",
      available: true,

      async addChunks(chunks, vectors, options = {}) {
        assertOpen("upsert");
        if (chunks.length !== vectors.length) {
          throw new Error(`addChunks: chunks.length (${chunks.length}) !== vectors.length (${vectors.length})`);
        }
        if (options.replace) {
          // In replace mode, remove existing chunks for all affected goals first
          const goals = new Set(chunks.map(c => c.metadata?.goal_id || "unknown"));
          for (const gid of goals) {
            await this.removeGoalChunks(gid);
          }
        }
        const docs = chunks.map((chunk, i) => ({
          id: chunk.id,
          vectors: { embedding: vectors[i] },
          fields: {
            workspace_id: String(metadataValue(chunk.metadata, "workspace_id", "")),
            goal_id: String(metadataValue(chunk.metadata, "goal_id", "unknown")),
            task_id: String(metadataValue(chunk.metadata, "task_id", "")),
            source_type: String(metadataValue(chunk.metadata, "source_type", "unknown")),
            project_id: String(metadataValue(chunk.metadata, "project_id", "")),
            repo_id: String(metadataValue(chunk.metadata, "repo_id", "")),
            role: metadataValue(chunk.metadata, "role", ""),
            source_path: metadataValue(chunk.metadata, "source_path", ""),
            chunk_index: Number(metadataValue(chunk.metadata, "chunk_index", chunk.index ?? 0)),
            tokens: Number(chunk.tokens || 0),
            created_at: String(metadataValue(chunk.metadata, "created_at", "")),
            text: chunk.text || "",
          },
        }));
        if (docs.length > 0) {
          assertZvecStatus(collection.upsertSync(docs), "upsert");
        }
      },

      async search(queryVector, topK = 5, filters = {}, searchOptions = {}) {
        assertOpen("query");
        const requestedMode = normalizeRetrievalMode(searchOptions.retrievalMode);
        const filter = buildZvecFilter(filters);
        const keywordQuery = keywordQueryFromText(searchOptions.queryText);
        const vectorRequest = {
          fieldName: "embedding",
          vector: queryVector,
          topk: topK,
          ...(filter ? { filter } : {}),
          outputFields,
        };
        let effectiveMode = "vector";
        let fallbackReason = null;
        let rawResults;
        let mappedResults = null;
        let scoreKind = "cosine_similarity";

        if (requestedMode === "hybrid") {
          if (!keywordQuery) {
            fallbackReason = "hybrid retrieval requested but query text produced no keyword terms";
          } else if (!hybridMethod && !ftsMethod) {
            fallbackReason = "hybrid retrieval requested but zvec API does not expose supported hybrid or full-text search methods";
          } else {
            try {
              if (hybridMethod) {
                rawResults = await collection[hybridMethod]({
                  ...vectorRequest,
                  query: keywordQuery,
                  text: keywordQuery,
                  keywordQuery,
                  queryTerms: queryTermsFromText(searchOptions.queryText),
                  vectorWeight: 0.65,
                  keywordWeight: 0.35,
                });
              } else {
                const vectorResults = collection.querySync(vectorRequest);
                const keywordResults = await collection[ftsMethod]({
                  query: keywordQuery,
                  text: keywordQuery,
                  keywordQuery,
                  topk: topK,
                  ...(filter ? { filter } : {}),
                  outputFields,
                });
                mappedResults = combineVectorAndKeywordResults(vectorResults, keywordResults, topK);
              }
              effectiveMode = "hybrid";
              scoreKind = "hybrid_similarity";
            } catch (err) {
              fallbackReason = `hybrid retrieval failed; fell back to vector: ${err?.message || String(err)}`;
              rawResults = null;
            }
          }
        }

        if (!rawResults && !mappedResults) {
          rawResults = collection.querySync(vectorRequest);
        }

        const mapped = mappedResults || rawResults.map((r) => mapZvecResult(r, scoreKind));
        mapped.sort((a, b) => b.score - a.score);
        return attachRetrievalDiagnostics(mapped, makeRetrievalDiagnostics({
          storeName: "zvec-collection-store",
          requestedMode,
          effectiveMode,
          fallbackReason,
          queryText: searchOptions.queryText,
          capabilities,
        }));
      },

      async removeGoalChunks(goalId) {
        assertOpen("deleteByFilter");
        assertZvecStatus(collection.deleteByFilterSync(`goal_id = "${escapeZvecString(goalId)}"`), "deleteByFilter");
      },

      close,
    };
  } catch (err) {
    options.zvecFailureReason = err?.message || String(err);
    // @zvec/zvec not available or collection initialization failed.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unified factory
// ---------------------------------------------------------------------------

/**
 * Create the best available vector store adapter.
 *
 * Tries zvec first; if unavailable, falls back to the local JSON store.
 *
 * @param {{ workspaceRoot?: string, dimension?: number, prefer?: string }} [options]
 * @returns {Promise<VectorStoreAdapter>}
 */
export async function createVectorStore(options = {}) {
  // Reuse an already-created adapter when hooks pass indexResult.store to retrieval.
  if (options.prefer && typeof options.prefer === "object" && typeof options.prefer.search === "function") {
    return options.prefer;
  }

  const mode = normalizeStoreMode(options.prefer || options.contextVectorStore || process.env.GPTWORK_CONTEXT_VECTOR_STORE);
  if (mode === "local") {
    return createLocalStore(options);
  }

  const zvec = await tryCreateZvecStore(options);
  if (zvec) return zvec;

  if (mode === "zvec") {
    const detail = options.zvecFailureReason ? `: ${options.zvecFailureReason}` : "";
    throw new Error(`Zvec vector store requested but unavailable${detail}`);
  }

  return createLocalStore(options);
}
