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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

let chunker, embeddings, zvecStore, retriever, bundleBuilder, contextIndexHooks, runtimeConfig;

before(async () => {
  chunker = await import("../src/context-index/chunker.mjs");
  embeddings = await import("../src/context-index/embeddings.mjs");
  zvecStore = await import("../src/context-index/zvec-store.mjs");
  retriever = await import("../src/context-index/retriever.mjs");
  bundleBuilder = await import("../src/context-index/context-bundle-builder.mjs");
  contextIndexHooks = await import("../src/context-index/context-index-hooks.mjs");
  runtimeConfig = await import("../src/runtime-config.mjs");
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

  it("createVectorStore returns local store when local mode is requested", async () => {
    const store = await zvecStore.createVectorStore({
      workspaceRoot: "/tmp",
      prefer: "local",
      importZvec: async () => {
        throw new Error("local mode should not import zvec");
      },
    });
    assert.ok(store.available);
    assert.strictEqual(store.name, "local-json-store");
    assert.strictEqual(typeof store.addChunks, "function");
    assert.strictEqual(typeof store.search, "function");
    assert.strictEqual(typeof store.removeGoalChunks, "function");
  });

  it("createVectorStore auto mode falls back to local when @zvec/zvec cannot load", async () => {
    const store = await zvecStore.createVectorStore({
      workspaceRoot: "/tmp",
      prefer: "auto",
      importZvec: async () => {
        throw new Error("simulated missing @zvec/zvec");
      },
    });
    assert.ok(store.available);
    assert.strictEqual(store.name, "local-json-store");
  });

  it("createVectorStore zvec mode fails clearly when @zvec/zvec cannot load", async () => {
    await assert.rejects(
      () => zvecStore.createVectorStore({
        workspaceRoot: "/tmp",
        prefer: "zvec",
        importZvec: async () => {
          throw new Error("simulated missing @zvec/zvec");
        },
      }),
      /Zvec vector store requested but unavailable.*simulated missing @zvec\/zvec/
    );
  });

  it("zvec-store source uses @zvec/zvec collection API, not the obsolete package/index API", () => {
    const source = readFileSync(join(process.cwd(), "src", "context-index", "zvec-store.mjs"), "utf8");
    assert.ok(source.includes("@zvec/zvec"), "should dynamically import @zvec/zvec");
    assert.ok(source.includes("ZVecCollectionSchema"), "should build a Zvec collection schema");
    assert.ok(source.includes("ZVecCreateAndOpen") || source.includes("ZVecOpen"), "should open a Zvec collection");
    const obsoletePackageImport = 'import("' + 'zvec' + '")';
    const obsoleteIndexCreation = ".create" + "Index(";
    const obsoleteAddCall = "idx" + ".add";
    const obsoleteSearchCall = "idx" + ".search";
    assert.ok(!source.includes(obsoletePackageImport), "should not import the obsolete package");
    assert.ok(!source.includes(obsoleteIndexCreation), "should not use the obsolete index-creation API");
    assert.ok(!source.includes(obsoleteAddCall), "should not use the obsolete index add API");
    assert.ok(!source.includes(obsoleteSearchCall), "should not use the obsolete index search API");
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
    const store = await zvecStore.tryCreateZvecStore({
      workspaceRoot: "/tmp",
      importZvec: async () => {
        throw new Error("simulated missing @zvec/zvec");
      },
    });
    assert.strictEqual(store, null);
  });
});

// ---------------------------------------------------------------------------
// 3b. Runtime config for vector store selection
// ---------------------------------------------------------------------------

describe("runtime-config — context vector store selection", () => {
  it("defaults GPTWORK_CONTEXT_VECTOR_STORE to auto", () => {
    const previous = process.env.GPTWORK_CONTEXT_VECTOR_STORE;
    delete process.env.GPTWORK_CONTEXT_VECTOR_STORE;
    try {
      const { config, sources } = runtimeConfig.buildRuntimeConfig(process.cwd());
      assert.strictEqual(config.contextVectorStore, "auto");
      assert.strictEqual(sources.contextVectorStore, "default");
    } finally {
      if (previous === undefined) delete process.env.GPTWORK_CONTEXT_VECTOR_STORE;
      else process.env.GPTWORK_CONTEXT_VECTOR_STORE = previous;
    }
  });

  it("reads GPTWORK_CONTEXT_VECTOR_STORE from process.env", () => {
    const previous = process.env.GPTWORK_CONTEXT_VECTOR_STORE;
    process.env.GPTWORK_CONTEXT_VECTOR_STORE = "local";
    try {
      const { config, sources } = runtimeConfig.buildRuntimeConfig(process.cwd());
      assert.strictEqual(config.contextVectorStore, "local");
      assert.strictEqual(sources.contextVectorStore, "process.env");
    } finally {
      if (previous === undefined) delete process.env.GPTWORK_CONTEXT_VECTOR_STORE;
      else process.env.GPTWORK_CONTEXT_VECTOR_STORE = previous;
    }
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


// ===========================================================================
// 7. P1: loadPriorResults uses workspaceRoot (not process.cwd())
// ===========================================================================

describe("P1: loadPriorResults uses workspaceRoot", () => {

  it("loadPriorResults reads from workspaceRoot, not process.cwd()", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-pr-"));
    const fakeStatePath = join(tmpDir, "state.json");
    
    // Create a prior goal result in the workspaceRoot
    const goalDir = join(tmpDir, ".gptwork", "goals", "goal_prior_001");
    mkdirSync(goalDir, { recursive: true });
    writeFileSync(join(goalDir, "result.md"), "# Prior Result\n\nThis is a test prior result for workspaceRoot-based loading.");
    
    // Create a mock store with a prior goal
    const store = {
      async load() {
        return {
          goals: [
            { id: "goal_current", workspace_id: "ws-test", title: "Current" },
            { id: "goal_prior_001", workspace_id: "ws-test", title: "Prior Goal", created_at: "2026-01-01T00:00:00Z" },
          ],
        };
      },
    };
    
    // Call loadPriorResults with a workspaceRoot that's different from cwd
    // The tmpDir is our workspaceRoot - process.cwd() is different
    const results = await contextIndexHooks.loadPriorResults
      ? await contextIndexHooks.loadPriorResults(store, tmpDir, { id: "goal_current", workspace_id: "ws-test" })
      : [];
    
    if (contextIndexHooks.loadPriorResults) {
      assert.ok(results.length >= 1, "should find prior result");
      assert.ok(results[0].summary.includes("Prior Result"), "summary should contain result.md content");
    }
    
    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadPriorResults returns fallback summary when result.md missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-pr-missing-"));
    
    const store = {
      async load() {
        return {
          goals: [
            { id: "goal_current", workspace_id: "ws-test" },
            { id: "goal_prior_noresult", workspace_id: "ws-test", title: "No Result File", created_at: "2026-01-01T00:00:00Z" },
          ],
        };
      },
    };
    
    const results = contextIndexHooks.loadPriorResults
      ? await contextIndexHooks.loadPriorResults(store, tmpDir, { id: "goal_current", workspace_id: "ws-test" })
      : [];
    
    if (contextIndexHooks.loadPriorResults) {
      assert.ok(results.length >= 1, "should still return fallback");
      assert.ok(results[0].summary.includes("No Result File"), "fallback should include title");
    }
    
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// 8. P1: zvec adapter round-trip (text/tokens in search results)
// ===========================================================================

describe("P1: zvec adapter round-trip", () => {

  it("local store search returns text and tokens in results", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-zvec-"));
    try {
      const store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 4 });
      
      await store.addChunks(
        [
          { id: "c1", text: "deployment guide for kubernetes", tokens: 8, metadata: { goal_id: "g1", source_type: "goal" } },
          { id: "c2", text: "database migration scripts", tokens: 6, metadata: { goal_id: "g1", source_type: "goal" } },
        ],
        [[1, 0, 0, 0], [0, 1, 0, 0]]
      );
      
      const results = await store.search([1, 0, 0, 0], 5, { goal_id: "g1" });
      assert.ok(results.length >= 1, "should return at least one result");
      // Verify text and tokens are available in search results (regardless of sort order)
      const hasTextTokens = results.some(r => r.text && r.tokens > 0);
      assert.ok(hasTextTokens, "search results should contain text and tokens");
      const c1 = results.find(r => r.id === "c1");
      assert.ok(c1, "c1 should be in results");
      assert.strictEqual(c1.text, "deployment guide for kubernetes", "text should be preserved on c1");
      assert.strictEqual(c1.tokens, 8, "tokens should be preserved on c1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("local store round-trip: addChunks with replace mode clears old chunks", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-replace-"));
    try {
      const store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 2 });
      
      // Add first batch
      await store.addChunks(
        [
          { id: "c1", text: "first batch content", tokens: 5, metadata: { goal_id: "g_replace", source_type: "goal", chunk_index: 0 } },
        ],
        [[1, 0]]
      );
      
      let results = await store.search([1, 0], 5, { goal_id: "g_replace" });
      assert.strictEqual(results.length, 1, "first batch: should have 1 chunk");
      
      // Add second batch with replace mode
      await store.addChunks(
        [
          { id: "c2", text: "second batch content", tokens: 6, metadata: { goal_id: "g_replace", source_type: "goal", chunk_index: 0 } },
        ],
        [[1, 0]],
        { replace: true }
      );
      
      results = await store.search([1, 0], 5, { goal_id: "g_replace" });
      assert.strictEqual(results.length, 1, "after replace: should still have 1 chunk (replaced, not appended)");
      assert.strictEqual(results[0].text, "second batch content", "should have new content after replace");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("local store dedup prevents linear growth on repeated indexing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-dedup-"));
    try {
      const store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 2 });
      
      // Index same content 3 times (without replace flag - uses dedup mode)
      for (let i = 0; i < 3; i++) {
        await store.addChunks(
          [
            { id: `c_${i}`, text: "stable content", tokens: 5, metadata: { goal_id: "g_dedup", source_type: "goal", chunk_index: 0 } },
            { id: `c2_${i}`, text: "more stable", tokens: 4, metadata: { goal_id: "g_dedup", source_type: "conversation", chunk_index: 0 } },
          ],
          [[1, 0], [0, 1]]
        );
      }
      
      const results = await store.search([1, 0], 10, { goal_id: "g_dedup" });
      // Should have only 2 chunks (one goal + one conversation), not 6
      assert.strictEqual(results.length, 2, "dedup should keep only 2 unique chunks, not 6");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("local store dedup allows new chunks after append", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-append-"));
    try {
      const store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 2 });
      
      // First: 2 chunks
      await store.addChunks(
        [
          { id: "c1", text: "existing chunk 1", tokens: 3, metadata: { goal_id: "g_append", source_type: "goal", chunk_index: 0 } },
          { id: "c2", text: "existing chunk 2", tokens: 3, metadata: { goal_id: "g_append", source_type: "goal", chunk_index: 1 } },
        ],
        [[1, 0], [0, 1]]
      );
      
      // Second: same 2 chunks + 1 new chunk (new index)
      await store.addChunks(
        [
          { id: "c1b", text: "existing chunk 1 updated", tokens: 4, metadata: { goal_id: "g_append", source_type: "goal", chunk_index: 0 } },
          { id: "c2b", text: "existing chunk 2", tokens: 3, metadata: { goal_id: "g_append", source_type: "goal", chunk_index: 1 } },
          { id: "c3", text: "new chunk 3", tokens: 3, metadata: { goal_id: "g_append", source_type: "goal", chunk_index: 2 } },
        ],
        [[1, 0], [0, 1], [0.5, 0.5]]
      );
      
      const results = await store.search([1, 0], 10, { goal_id: "g_append" });
      assert.strictEqual(results.length, 3, "should have 3 chunks (2 replaced + 1 new), not 5");
      // Check existing chunk 1 was updated
      const c1Result = results.find(r => r.metadata?.chunk_index === 0);
      assert.ok(c1Result, "chunk index 0 should exist");
      assert.strictEqual(c1Result.text, "existing chunk 1 updated", "chunk index 0 should be updated");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 9. P1: loadPriorResults exported function
// ===========================================================================

describe("P1: loadPriorResults export", () => {
  it("loadPriorResults is exported from context-index-hooks", () => {
    assert.ok(typeof contextIndexHooks.loadPriorResults === "function", "loadPriorResults should be exported from hooks");
  });

  it("maybeBuildContextBundle passes workspaceRoot to loadPriorResults", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-p1-pass-"));
    try {
      // Create prior goal result in the workspaceRoot
      const priorGoalId = "goal_prior_pass";
      const priorDir = join(tmpDir, ".gptwork", "goals", priorGoalId);
      mkdirSync(priorDir, { recursive: true });
      writeFileSync(join(priorDir, "result.md"), "Prior content for passing test.");
      
      const config = { defaultWorkspaceRoot: tmpDir };
      const goal = {
        id: "goal_p1_pass",
        workspace_id: "ws-test",
        title: "P1 Pass Test",
        user_request: "Test workspaceRoot passing",
        goal_prompt: "Make sure workspaceRoot is used",
        context_summary: "Verification test",
      };
      
      // Store with prior goals
      const store = {
        async load() {
          return {
            goals: [
              { id: "goal_p1_pass", workspace_id: "ws-test" },
              { id: priorGoalId, workspace_id: "ws-test", title: "Prior Pass Goal", created_at: "2026-01-01T00:00:00Z" },
            ],
          };
        },
      };
      
      const result = await contextIndexHooks.maybeBuildContextBundle(store, config, goal);
      
      // The bundle should include the prior result content (from workspaceRoot)
      assert.ok(result.ok, "bundle should build ok");
      if (result.bundle) {
        assert.ok(
          result.bundle.includes("Prior content") || result.bundle.includes("Prior Pass Goal"),
          "bundle should reference prior goal"
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// P0: Issue 6 — maxGoalsScanned limits cross-goal scanning (regression test)
// ===========================================================================

describe("zvec-store — maxGoalsScanned limits (Issue 6)", () => {

  it("local store search with maxGoalsScanned limits scanned goals when no goal_id filter", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-issue6-"));
    try {
      const store = zvecStore.createLocalStore({
        workspaceRoot: tmpDir,
        dimension: 2,
        maxGoalsScanned: 2,
      });

      // Create chunks for 3 different goals
      for (const gid of ["g_a", "g_b", "g_c"]) {
        await store.addChunks(
          [{ id: `c_${gid}`, text: `content for ${gid}`, tokens: 3, metadata: { goal_id: gid, source_type: "goal" } }],
          [[1, 0]]
        );
      }

      // Search without goal_id filter — should only scan up to maxGoalsScanned (2)
      const results = await store.search([1, 0], 10, {});
      // With maxGoalsScanned=2, at most 2 goals' vectors are returned
      assert.ok(results.length <= 2, "should limit to maxGoalsScanned goals when no goal_id filter");

      // Search with specific goal_id should still work and return all from that goal
      const specificResults = await store.search([1, 0], 10, { goal_id: "g_c" });
      assert.equal(specificResults.length, 1);
      assert.equal(specificResults[0].metadata?.goal_id, "g_c");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("local store search with maxGoalsScanned default does not affect specific goal_id retrieval", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-issue6-specific-"));
    try {
      // Use default maxGoalsScanned (should be 50)
      const store = zvecStore.createLocalStore({
        workspaceRoot: tmpDir,
        dimension: 2,
      });

      await store.addChunks(
        [{ id: "c1", text: "specific goal content", tokens: 3, metadata: { goal_id: "g_specific", source_type: "goal" } }],
        [[1, 0]]
      );

      // Specific goal_id retrieval should find the chunk regardless of maxGoalsScanned
      const results = await store.search([1, 0], 10, { goal_id: "g_specific" });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "c1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 7b. P0: Real zvec regression — score semantics, project_id/repo_id
// ===========================================================================

describe("P0: zvec store regression — score semantics and filters", () => {

  it("zvec score normalization: same vector gets higher score than orthogonal", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-zvec-score-"));
    try {
      const store = await zvecStore.tryCreateZvecStore({
        workspaceRoot: tmpDir,
        dimension: 4,
      });
      if (!store) {
        // If zvec is somehow unavailable, fail hard (goal requirement)
        assert.fail("@zvec/zvec should be available in test environment");
      }

      await store.addChunks(
        [
          { id: "v_same", text: "same direction", tokens: 2, metadata: { goal_id: "g_zvec_test", source_type: "goal" } },
          { id: "v_orth", text: "orthogonal", tokens: 2, metadata: { goal_id: "g_zvec_test", source_type: "goal" } },
        ],
        [[1, 0, 0, 0], [0, 1, 0, 0]]
      );

      // Query with [1,0,0,0] — same vector is [1,0,0,0], orthogonal is [0,1,0,0]
      const results = await store.search([1, 0, 0, 0], 5, { goal_id: "g_zvec_test" });

      assert.ok(results.length >= 2, "should return at least 2 results");

      // The identical vector should be first (higher score = more relevant)
      assert.strictEqual(results[0].id, "v_same",
        "identical vector should rank first after score normalization");
      assert.strictEqual(results[1].id, "v_orth",
        "orthogonal vector should rank second");

      // Assert same-vector score > orthogonal-vector score
      assert.ok(results[0].score > results[1].score,
        `same-vector score (${results[0].score}) should be > orthogonal score (${results[1].score})`);

      // Assert the score values are sensible: same vector => ~1.0, orthogonal => ~0.0
      assert.ok(results[0].score > 0.99,
        `same-vector normalized score should be ~1.0, got ${results[0].score}`);
      assert.ok(results[1].score < 0.01,
        `orthogonal normalized score should be ~0.0, got ${results[1].score}`);

      // Assert raw_score and score_kind are present
      assert.ok(results[0].raw_score !== undefined, "result should include raw_score");
      assert.strictEqual(typeof results[0].raw_score, "number", "raw_score should be a number");
      assert.strictEqual(results[0].score_kind, "cosine_similarity", "score_kind should be cosine_similarity");
      assert.strictEqual(results[1].score_kind, "cosine_similarity", "score_kind should be cosine_similarity");

      // Verify raw_score is inverted from score
      // raw_score is the original zvec distance (0 for identical, 1 for orthogonal)
      assert.ok(results[0].raw_score < results[1].raw_score,
        "raw_score should preserve original zvec distance ordering (lower = more similar)");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("zvec search with project_id and repo_id filters", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ctx-zvec-filter-"));
    try {
      const store = await zvecStore.tryCreateZvecStore({
        workspaceRoot: tmpDir,
        dimension: 4,
      });
      if (!store) {
        assert.fail("@zvec/zvec should be available in test environment");
      }

      // Add chunks with different project_id and repo_id
      await store.addChunks(
        [
          { id: "c1", text: "project-A content", tokens: 2, metadata: { goal_id: "g_filter", source_type: "goal", project_id: "proj_a", repo_id: "repo_1" } },
          { id: "c2", text: "project-B content", tokens: 2, metadata: { goal_id: "g_filter", source_type: "goal", project_id: "proj_b", repo_id: "repo_1" } },
          { id: "c3", text: "repo-2 content", tokens: 2, metadata: { goal_id: "g_filter", source_type: "goal", project_id: "proj_a", repo_id: "repo_2" } },
        ],
        [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
      );

      // Filter by project_id
      const projAResults = await store.search([1, 0, 0, 0], 5, { goal_id: "g_filter", project_id: "proj_a" });
      assert.ok(projAResults.length >= 1, "should match project_a chunks");
      for (const r of projAResults) {
        assert.strictEqual(r.metadata?.project_id, "proj_a",
          `result ${r.id} should have project_id=proj_a`);
      }

      // Filter by repo_id
      const repo1Results = await store.search([0, 1, 0, 0], 5, { goal_id: "g_filter", repo_id: "repo_1" });
      assert.ok(repo1Results.length >= 2, "should match both repo_1 chunks");
      for (const r of repo1Results) {
        assert.strictEqual(r.metadata?.repo_id, "repo_1",
          `result ${r.id} should have repo_id=repo_1`);
      }

      // Filter by both project_id and repo_id
      const combinedResults = await store.search([1, 0, 0, 0], 5, {
        goal_id: "g_filter",
        project_id: "proj_a",
        repo_id: "repo_1",
      });
      assert.ok(combinedResults.length >= 1, "should match combined filter");
      for (const r of combinedResults) {
        assert.strictEqual(r.metadata?.project_id, "proj_a");
        assert.strictEqual(r.metadata?.repo_id, "repo_1");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
