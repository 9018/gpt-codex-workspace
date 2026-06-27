/**
 * embeddings.mjs — Embedding provider abstraction.
 *
 * Defines an interface-like factory for creating embedding providers.
 * Provides a deterministic fallback provider for tests/dev that does not
 * require any external API or model.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Embedding provider interface
//
// An embedding provider must expose:
//   - name: string           — human-readable provider name
//   - dimension: number      — embedding vector dimension
//   - embed(texts: string[]): Promise<number[][]>
//     Return a 2-D array of floats, one vector per input text.
//     Each vector must have exactly `dimension` elements.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic fallback provider
// ---------------------------------------------------------------------------

const FALLBACK_DIMENSION = 64;

/**
 * Create a deterministic hash-based embedding vector for a single text.
 *
 * Uses SHA-256 to derive stable pseudo-random components.  This is not
 * semantically meaningful — it exists only to give deterministic,
 * reproducible vectors for testing and offline development.
 *
 * @param {string} text
 * @param {number} [dimension=64]
 * @returns {number[]}
 */
function hashEmbed(text, dimension = FALLBACK_DIMENSION) {
  const hash = createHash("sha256").update(String(text)).digest();
  const vec = new Float64Array(dimension);
  // Spread hash bytes across the vector
  for (let i = 0; i < dimension; i++) {
    const byteIndex = (i * 4) % hash.length;
    const b1 = hash[byteIndex];
    const b2 = hash[(byteIndex + 1) % hash.length];
    // Normalize to [-1, 1]
    vec[i] = ((b1 << 8) | b2) / 32768 - 1;
  }
  return Array.from(vec);
}

/**
 * FallbackEmbeddingProvider — deterministic, no external dependencies.
 *
 * @type {{ name: string, dimension: number, embed: (texts: string[]) => Promise<number[][]> }}
 */
export const fallbackEmbeddingProvider = {
  semantic: false,
  support_info: "non-semantic fallback embedding provider; deterministic hash-based vectors for testing/offline use",
  name: "fallback-hash-sha256",
  dimension: FALLBACK_DIMENSION,
  async embed(texts) {
    if (!Array.isArray(texts)) texts = [String(texts)];
    return texts.map((t) => hashEmbed(t, this.dimension));
  },
};

// ---------------------------------------------------------------------------
// Configurable / external provider
// ---------------------------------------------------------------------------

/**
 * Create an OpenAI-compatible embedding provider.
 *
 * Expects an OpenAI client (or compatible) with a `createEmbedding` method.
 *
 * @param {{ client: { embeddings: { create: (params: any) => Promise<any> } }, model?: string, dimension?: number }} options
 * @returns {{ name: string, dimension: number, embed: (texts: string[]) => Promise<number[][]> }}
 */
export function createOpenAiEmbeddingProvider(options) {
  const model = options.model || "text-embedding-3-small";
  const dimension = options.dimension || 1536;
  return {
    name: `openai:${model}`,
    dimension,
    semantic: true,
    support_info: "semantic embedding provider",
    async embed(texts) {
      if (!Array.isArray(texts)) texts = [String(texts)];
      const response = await options.client.embeddings.create({
        model,
        input: texts,
        ...(dimension < 1536 ? { dimensions: dimension } : {}),
      });
      return response.data.map((item) => item.embedding);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an embedding provider based on configuration.
 *
 * Strategy:
 * 1. If `config.provider` is `"openai"`, create an OpenAI provider (requires `config.openAIClient`).
 * 2. If `config.provider` is `"fallback"` or no config is given, use the deterministic fallback.
 * 3. Custom providers can be injected via `config.customProvider`.
 *
 * @param {{ provider?: string, openAIClient?: object, customProvider?: object, [key: string]: any }} [config={}]
 * @returns {{ name: string, dimension: number, embed: (texts: string[]) => Promise<number[][]> }}
 */
export function createEmbeddingProvider(config = {}) {
  if (config.customProvider) {
    return config.customProvider;
  }
  if (config.provider === "openai") {
    if (!config.openAIClient) {
      throw new Error(
        "OpenAI embedding provider requires config.openAIClient " +
        "(an OpenAI client instance with embeddings.create)"
      );
    }
    return createOpenAiEmbeddingProvider({
      client: config.openAIClient,
      model: config.model,
      dimension: config.dimension,
    });
  }
  // Default: fallback deterministic provider
  return fallbackEmbeddingProvider;
}

export function embeddingProviderDiagnostics(provider) {
  return {
    name: provider?.name || "unknown",
    dimension: Number.isFinite(Number(provider?.dimension)) ? Number(provider.dimension) : null,
    semantic: provider?.semantic !== undefined ? Boolean(provider.semantic) : true,
    ...(provider?.support_info ? { support_info: String(provider.support_info) } : {}),
  };
}
