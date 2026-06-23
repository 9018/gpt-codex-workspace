/**
 * context-index.test.mjs — Tests for P0.5 context retrieval MVP.
 *
 * Covers:
 * - Chunking determinism
 * - Embedding fallback determinism
 * - Store adapter fallback when zvec unavailable
 * - Bundle generation shape and token bound behavior
 * - Integration point does not break workflow
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

let chunker, embeddings, zvecStore, retriever, bundleBuilder, contextIndexHooks;

before(async () => {
  chunker = await import("../src/context-index/chunker.mjs");
  embeddings = await import("../src/context-index/embeddings.mjs");
  zvecStore = await import("../src/context-index/zvec-store.mjs");
  retriever = await import("../src/context-index/retriever.mjs");
  bundleBuilder = await import("../src/context-index/context-bundle-builder.mjs");
  contextIndexHooks = await import("../src/context-index/context-index-hooks.mjs");
});

// ---------------------------------------------------------------------------
// 1. Chunking determinism
// ---------------------------------------------------------------------------

describe("chunker — determinism and structure", () => {

  it("chunkText returns deterministic results for same input", () => {
    const text = "First paragraph about project planning.\n\nSecond paragraph about implementation details and code quality checks.\n\nThird paragraph with final remarks.";
    const opts = { chunkSize: 128, chunkOverlap: 16 };
    const a = chunker.chunkText(text, opts);
    const b = chunker.chunkText(text, opts);
    assert.strictEqual(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.strictEqual(a[i].text, b[i].text);
      assert.strictEqual(a[i].index, b[i].index);
      assert.strictEqual(a[i].tokens, b[i].tokens);
    }
  });

  it("chunkText returns empty array for empty input", () => {
    assert.deepStrictEqual(chunker.chunkText(""), []);
    assert.deepStrictEqual(chunker.chunkText(null), []);
    assert.deepStrictEqual(chunker.chunkText(undefined), []);
  });

  it("chunkText produces chunks with index, text, and tokens fields", () => {
    const text = "A ".repeat(500);
    const chunks = chunker.chunkText(text, { chunkSize: 200 });
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.ok(typeof c.index === "number");
      assert.ok(typeof c.text === "string" && c.text.length > 0);
      assert.ok(typeof c.tokens === "number" && c.tokens > 0);
    }
  });

  it("chunkMessages extracts metadata", () => {
    const messages = [
      { role: "user", content: "Hello, I need help with deployment." },
      { role: "codex", content: "Sure, let me check the configuration." },
    ];
    const chunks = chunker.chunkMessages(messages, {
      metadata: { workspace_id: "ws-1" },
    });
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.strictEqual(c.metadata.source_type, "conversation");
      assert.strictEqual(c.metadata.workspace_id, "ws-1");
    }
  });

  it("chunkGoalContent extracts goal metadata", () => {
    const goal = {
      title: "Test Goal",
      user_request: "Implement feature X",
      goal_prompt: "Long prompt about feature X",
      context_summary: "Summary here",
    };
    const chunks = chunker.chunkGoalContent(goal);
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.strictEqual(c.metadata.source_type, "goal");
    }
  });

  it("chunkResult works with result text", () => {
    const result = "Completed task 1: fixed bug. Completed task 2: added feature.";
    const chunks = chunker.chunkResult(result);
    assert.ok(chunks.length >= 1);
    assert.strictEqual(chunks[0].metadata.source_type, "result");
  });
});

// ---------------------------------------------------------------------------
// 2. Embedding fallback determinism
// ---------------------------------------------------------------------------

describe("embeddings — fallback provider determinism", () => {

  it("fallback provider returns correct dimension", () => {
    assert.strictEqual(embeddings.fallbackEmbeddingProvider.dimension, 64);
    assert.strictEqual(embeddings.fallbackEmbeddingProvider.name, "fallback-hash-sha256");
  });

  it("fallback provider produces deterministic vectors", async () => {
    const texts = ["hello world", "another text", "hello world"];
    const vecs = await embeddings.fallbackEmbeddingProvider.embed(texts);
    assert.strictEqual(vecs.length, 3);
    assert.strictEqual(vecs[0].length, 64);
    // Same input => same vector
    assert.deepStrictEqual(vecs[0], vecs[2]);
  });

  it("createEmbeddingProvider returns fallback by default", () => {
    const provider = embeddings.createEmbeddingProvider();
    assert.strictEqual(provider.name, "fallback-hash-sha256");
    assert.strictEqual(provider.dimension, 64);
  });

  it("createEmbeddingProvider accepts custom provider", () => {
    const custom = {
      name: "custom",
      dimension: 8,
      async embed(texts) { return texts.map(() => new Array(8).fill(0)); },
    };
    const provider = embeddings.createEmbeddingProvider({ customProvider: custom });
    assert.strictEqual(provider.name, "custom");
  });

  it("createEmbeddingProvider with openai but no client throws", () => {
    assert.throws(() => {
      embeddings.createEmbeddingProvider({ provider: "openai" });
    }, /openAIClient/);
  });
});

// ---------------------------------------------------------------------------
// 3. Store adapter fallback when zvec unavailable
// ---------------------------------------------------------------------------

describe("zvec-store — adapter fallback", () => {

  it("createVectorStore returns local store when zvec unavailable", async () => {
    const store = await zvecStore.createVectorStore({
      workspaceRoot: "/tmp",
      prefer: "local",
    });
    assert.ok(store.available);
    assert.strictEqual(store.name, "local-json-store");
    assert.strictEqual(typeof store.addChunks, "function");
    assert.strictEqual(typeof store.search, "function");
    assert.strictEqual(typeof store.removeGoalChunks, "function");
  });

  it("local store round-trip: addChunks and search", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-idx-test-"));
    try {
      const store = zvecStore.createLocalStore({
        workspaceRoot: tmpDir,
        dimension: 4,
      });

      const chunks = [
        { id: "c1", text: "deployment configuration", tokens: 5, metadata: { goal_id: "g1", source_type: "goal" } },
        { id: "c2", text: "database schema design", tokens: 5, metadata: { goal_id: "g1", source_type: "goal" } },
        { id: "c3", text: "unrelated note about weather", tokens: 5, metadata: { goal_id: "g1", source_type: "conversation" } },
      ];
      // Simple predictable vectors: [1,0,0,0] for c1 type, [0,1,0,0] for others
      const vectors = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ];
      await store.addChunks(chunks, vectors);

      // Search with a vector close to [1,0,0,0]
      const results = await store.search([0.9, 0.1, 0, 0], 2, { goal_id: "g1" });
      assert.ok(results.length >= 1);
      assert.strictEqual(results[0].id, "c1");
      assert.ok(results[0].score > 0.8);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("local store search returns empty for unknown goal_id", async () => {
    const store = zvecStore.createLocalStore({ workspaceRoot: "/tmp", dimension: 4 });
    const results = await store.search([1, 0, 0, 0], 5, { goal_id: "nonexistent" });
    assert.deepStrictEqual(results, []);
  });

  it("local store handles filters", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-idx-test-filter-"));
    try {
      const store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 2 });
      await store.addChunks(
        [
          { id: "r1", text: "result text", tokens: 2, metadata: { goal_id: "g2", source_type: "result" } },
          { id: "r2", text: "goal text", tokens: 2, metadata: { goal_id: "g2", source_type: "goal" } },
        ],
        [[1, 0], [0, 1]]
      );
      // Filter by source_type
      const results = await store.search([1, 0], 5, { goal_id: "g2", source_type: "result" });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, "r1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tryCreateZvecStore returns null gracefully", async () => {
    const store = await zvecStore.tryCreateZvecStore({ workspaceRoot: "/tmp" });
    assert.strictEqual(store, null);
  });
});

// ---------------------------------------------------------------------------
// 4. Bundle generation shape and token/size bound behavior
// ---------------------------------------------------------------------------

describe("context-bundle-builder — bundle generation", () => {

  it("buildContextBundle produces expected sections", () => {
    const goal = {
      id: "goal_test",
      title: "Bundle Test Goal",
      status: "assigned",
      mode: "builder",
    };
    const chunks = [
      {
        id: "chunk_1",
        text: "This is a relevant chunk about the goal.",
        tokens: 10,
        metadata: { source_type: "goal" },
        score: 0.95,
      },
    ];
    const result = bundleBuilder.buildContextBundle({ chunks, goal });
    assert.ok(result.bundle.includes("Context Bundle"));
    assert.ok(result.bundle.includes("Selected Context Summary"));
    assert.ok(result.bundle.includes("Constraints and Acceptance Hints"));
    assert.ok(result.bundle.includes("Omitted / Full Transcript Note"));
    assert.ok(result.bundle.includes("Retrieval Metadata"));
    assert.ok(typeof result.tokenEstimate === "number");
    assert.ok(result.tokenEstimate > 0);
  });

  it("buildContextBundle without chunks still produces valid bundle", () => {
    const goal = { id: "goal_empty", title: "Empty", status: "open" };
    const result = bundleBuilder.buildContextBundle({ chunks: [], goal });
    assert.ok(result.bundle.length > 50);
    assert.ok(result.bundle.includes("Context Bundle"));
  });

  it("buildContextBundle respects maxTokens bound", () => {
    const goal = { id: "goal_large", title: "Large", status: "assigned" };
    // Create many chunks to force large output
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      id: `chunk_${i}`,
      text: "Repeated content for testing bundle size limits and truncation behavior. ".repeat(50),
      tokens: 200,
      metadata: { source_type: "conversation" },
      score: 1.0 - i * 0.05,
    }));
    const result = bundleBuilder.buildContextBundle({ chunks, goal, maxTokens: 512 });
    assert.ok(result.tokenEstimate <= 512 || result.bundle.length < 3000);
  });

  it("buildContextBundle with retrieval metadata", () => {
    const goal = { id: "goal_meta", title: "Metadata Test", status: "assigned" };
    const chunks = [
      { id: "c1", text: "First result", tokens: 5, metadata: { source_type: "result" }, score: 0.98 },
      { id: "c2", text: "Conversation snippet", tokens: 8, metadata: { source_type: "conversation" }, score: 0.85 },
    ];
    const result = bundleBuilder.buildContextBundle({ chunks, goal });
    assert.ok(result.bundle.includes("Retrieved chunk types"));
    assert.ok(result.bundle.includes("result"));
    assert.ok(result.bundle.includes("conversation"));
  });
});

// ---------------------------------------------------------------------------
// 5. Integration point: maybeBuildContextBundle does not throw
// ---------------------------------------------------------------------------

describe("context-index-hooks — integration does not break workflow", () => {

  it("maybeBuildContextBundle returns { ok: false, warning } with no goal", async () => {
    const result = await contextIndexHooks.maybeBuildContextBundle(null, null, null);
    assert.strictEqual(result.ok, false);
    assert.ok(result.warning);
  });

  it("maybeBuildContextBundle returns { ok: false, warning } with empty goal", async () => {
    const result = await contextIndexHooks.maybeBuildContextBundle(null, null, { id: "g-empty", workspace_id: "ws-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.warning);
  });

  it("maybeBuildContextBundle works with a populated goal", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-hook-test-"));
    try {
      const config = { defaultWorkspaceRoot: tmpDir };
      const goal = {
        id: "goal_hook_test",
        workspace_id: "ws-test",
        conversation_id: "conv-test",
        title: "Hook Test Goal",
        user_request: "Implement context retrieval MVP",
        goal_prompt: "Add chunker, embeddings, store, retriever, bundle builder.",
        context_summary: "Build vector-based context retrieval for GPTWork.",
        status: "assigned",
        mode: "builder",
      };
      const result = await contextIndexHooks.maybeBuildContextBundle(
        { async load() { return { goals: [], memories: [] }; } },
        config,
        goal
      );
      assert.ok(result.ok);
      assert.ok(result.bundle);
      assert.ok(result.tokenEstimate > 0);
      // Should include goal content in the bundle
      assert.ok(result.bundle.includes("Hook Test Goal") || result.bundle.includes("context retrieval MVP"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tryBuildContextBundle returns null on failure", async () => {
    const bundle = await contextIndexHooks.tryBuildContextBundle(null, null, null);
    assert.strictEqual(bundle, null);
  });
});

// ---------------------------------------------------------------------------
// 6. Barrel import smoke
// ---------------------------------------------------------------------------

describe("context-index barrel import", () => {

  it("index.mjs exports all expected members", async () => {
    const idx = await import("../src/context-index/index.mjs");
    assert.strictEqual(typeof idx.chunkText, "function");
    assert.strictEqual(typeof idx.chunkMessages, "function");
    assert.strictEqual(typeof idx.chunkGoalContent, "function");
    assert.strictEqual(typeof idx.chunkResult, "function");
    assert.strictEqual(typeof idx.createEmbeddingProvider, "function");
    assert.strictEqual(typeof idx.fallbackEmbeddingProvider, "object");
    assert.strictEqual(typeof idx.createVectorStore, "function");
    assert.strictEqual(typeof idx.createLocalStore, "function");
    assert.strictEqual(typeof idx.tryCreateZvecStore, "function");
    assert.strictEqual(typeof idx.buildIndexChunks, "function");
    assert.strictEqual(typeof idx.indexGoalContext, "function");
    assert.strictEqual(typeof idx.retrieveContext, "function");
    assert.strictEqual(typeof idx.buildContextBundle, "function");
    assert.strictEqual(typeof idx.maybeBuildContextBundle, "function");
    assert.strictEqual(typeof idx.tryBuildContextBundle, "function");
  });
});
