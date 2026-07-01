/**
 * context-index index.mjs — Barrel exports for context-index module.
 *
 * Re-exports all public API surfaces for convenient imports.
 */

export { chunkText, chunkMessages, chunkGoalContent, chunkResult } from "./chunker.mjs";
export { createEmbeddingProvider, fallbackEmbeddingProvider } from "./embeddings.mjs";
export { createVectorStore, createLocalStore, tryCreateZvecStore } from "./zvec-store.mjs";
export { buildIndexChunks, indexGoalContext, retrieveContext } from "./retriever.mjs";
export { buildContextBundle } from "./context-bundle-builder.mjs";
export { buildContextManifest, CONTEXT_MANIFEST_SCHEMA_VERSION } from "./context-curator.mjs";
export { maybeBuildContextBundle, tryBuildContextBundle } from "./context-index-hooks.mjs";
