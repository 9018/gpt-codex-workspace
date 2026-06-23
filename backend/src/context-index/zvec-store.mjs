/**
 * zvec-store.mjs — Vector store adapter for context retrieval.
 *
 * Provides a unified interface over optional zvec backend or a local
 * JSON-file based fallback.  The adapter abstracts indexing (store)
 * and search (retrieve) operations.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_DIR = ".gptwork/context-index";
const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.json";

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
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const dimension = options.dimension || 64;
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

  async function persistGoalIndex(goalId, entry) {
    const dir = await ensureGoalDir(goalId);
    await writeFile(join(dir, CHUNKS_FILE), JSON.stringify(entry.chunks), "utf8");
    await writeFile(join(dir, VECTORS_FILE), JSON.stringify(entry.vectors), "utf8");
  }

  return {
    name: "local-json-store",
    available: true,

    async addChunks(chunks, vectors) {
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
        const entry = await loadGoalIndex(goalId);
        entry.chunks.push(...data.chunks);
        entry.vectors.push(...data.vectors);
        await persistGoalIndex(goalId, entry);
      }
    },

    async search(queryVector, topK = 5, filters = {}) {
      const goalId = filters.goal_id;
      if (!goalId) return [];

      const entry = await loadGoalIndex(goalId);
      if (entry.chunks.length === 0) return [];

      const scored = [];
      for (let i = 0; i < entry.chunks.length; i++) {
        const chunk = entry.chunks[i];
        // Apply simple filters
        if (filters.source_type && chunk.metadata?.source_type !== filters.source_type) continue;
        if (filters.goal_id && chunk.metadata?.goal_id !== filters.goal_id) continue;
        if (filters.workspace_id && chunk.metadata?.workspace_id !== filters.workspace_id) continue;

        const vec = entry.vectors[i];
        if (!vec || vec.length !== queryVector.length) continue;
        const score = cosineSimilarity(queryVector, vec);
        scored.push({ ...chunk, score });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
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
  };
}

// ---------------------------------------------------------------------------
// Zvec adapter (optional dependency)
// ---------------------------------------------------------------------------

/**
 * Try to load zvec and create a zvec-backed store adapter.
 *
 * If zvec is not installed or fails to load, returns null so callers
 * can fall back to createLocalStore.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {number} [options.dimension=64]
 * @returns {Promise<VectorStoreAdapter|null>}
 */
export async function tryCreateZvecStore(options = {}) {
  try {
    const zvec = await import("zvec");
    if (!zvec || typeof zvec.createIndex !== "function") return null;
    const workspaceRoot = options.workspaceRoot || process.cwd();
    const dimension = options.dimension || 64;
    const indexDir = join(workspaceRoot, DEFAULT_INDEX_DIR);

    // Zvec integration — using a minimal subset of zvec API
    // zvec.createIndex(name, options) → index handle
    // index.add(id, vector, metadata)
    // index.search(queryVector, topK, filterFn) → results

    // Per-goal indices stored under .gptwork/context-index/zvec/
    const zvecDir = join(indexDir, "zvec");
    await mkdir(zvecDir, { recursive: true });

    /** @type {Map<string, any>} */
    const indices = new Map();

    async function getIndex(goalId) {
      if (indices.has(goalId)) return indices.get(goalId);
      const idx = await zvec.createIndex(`goal-${goalId}`, {
        dimension,
        persistPath: join(zvecDir, `goal-${goalId}`),
        metric: "cosine",
      });
      indices.set(goalId, idx);
      return idx;
    }

    return {
      name: "zvec-store",
      available: true,

      async addChunks(chunks, vectors) {
        if (chunks.length !== vectors.length) {
          throw new Error(`addChunks: chunks.length (${chunks.length}) !== vectors.length (${vectors.length})`);
        }
        for (let i = 0; i < chunks.length; i++) {
          const goalId = chunks[i].metadata?.goal_id || "unknown";
          const idx = await getIndex(goalId);
          await idx.add(chunks[i].id, vectors[i], chunks[i].metadata);
        }
      },

      async search(queryVector, topK = 5, filters = {}) {
        const goalId = filters.goal_id;
        if (!goalId) return [];

        const idx = indices.has(goalId)
          ? indices.get(goalId)
          : await (async () => {
              try {
                const idx = await zvec.createIndex(`goal-${goalId}`, {
                  dimension,
                  persistPath: join(zvecDir, `goal-${goalId}`),
                  metric: "cosine",
                  loadExisting: true,
                });
                indices.set(goalId, idx);
                return idx;
              } catch {
                return null;
              }
            })();

        if (!idx) return [];

        const filterFn = filters.source_type
          ? (meta) => meta.source_type === filters.source_type
          : undefined;

        const results = await idx.search(queryVector, topK, filterFn);
        return results.map((r) => ({
          id: r.id,
          text: r.metadata?.text || "",
          tokens: r.metadata?.tokens || 0,
          index: r.metadata?.chunk_index || 0,
          metadata: r.metadata || {},
          score: r.score || 0,
        }));
      },

      async removeGoalChunks(goalId) {
        indices.delete(goalId);
        try {
          const dir = join(zvecDir, `goal-${goalId}`);
          const { rm } = await import("node:fs/promises");
          await rm(dir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup failures
        }
      },
    };
  } catch {
    // zvec not available
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
  // Allow explicit preference for testing
  if (options.prefer === "local") {
    return createLocalStore(options);
  }

  const zvec = await tryCreateZvecStore(options);
  if (zvec) return zvec;

  return createLocalStore(options);
}
