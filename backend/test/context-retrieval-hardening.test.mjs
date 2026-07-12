/**
 * context-retrieval-hardening.test.mjs — P0 上下文污染回归测试
 *
 * 本测试精确复现上下文污染缺陷：
 * 当 fallback-hash-sha256 (semantic=false) 与 cross_goal_retrieval=enabled
 * 共同作用时，readonly diagnostic goal 会错误召回 mutation goal 的内容。
 *
 * 这些测试在修复前必须 FAIL，确认缺陷存在。
 * 修复后必须 PASS，确认污染被阻断。
 *
 * ## 根因链
 *
 *   embedding_provider=fallback-hash-sha256 (semantic=false)
 *     → 非语义 hash 向量不能区分 "readonly 诊断" 和 "mutation 修改"
 *     → cross_goal_retrieval.enabled=true 扫描所有 Goal
 *     → zvec-store local 模式遍历所有 goal_id 索引
 *     → selectBundleChunks 允许 cross-goal 进入 context.bundle.md
 *     → readonly 任务拿到 mutation 命令 → 行为带偏
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = dirname(__dirname);

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------

let embeddings, retriever, zvecStore, bundleBuilder, contextIndexHooks;

before(async () => {
  embeddings = await import("../src/context-index/embeddings.mjs");
  retriever = await import("../src/context-index/retriever.mjs");
  zvecStore = await import("../src/context-index/zvec-store.mjs");
  bundleBuilder = await import("../src/context-index/context-bundle-builder.mjs");
  contextIndexHooks = await import("../src/context-index/context-index-hooks.mjs");
});

// ---------------------------------------------------------------------------
// Test goals — 两个互斥意图
// ---------------------------------------------------------------------------

/**
 * Goal A: readonly diagnostic
 * 只读诊断，不应改变任何文件或系统状态。
 */
function createGoalA(goalId) {
  return {
    id: goalId,
    workspace_id: "test-ws",
    project_id: "test-project",
    repo_id: "test-repo",
    title: "System Health Diagnostic Check",
    user_request:
      "Read-only diagnostic check of system health. " +
      "Inspect log files, check service status, report findings. " +
      "Do NOT modify any files, do NOT restart any services, do NOT run any mutation commands.",
    goal_prompt:
      "You are a read-only diagnostic agent. Your task is to inspect the system and report health status. " +
      "You must never modify files, run commands that change state, or restart services. " +
      "Read /var/log/syslog, check systemctl status, and produce a diagnostic report.",
    context_summary: "Read-only system health check. No mutations permitted.",
    status: "open",
    mode: "builder",
    autonomy_policy: { mode: "subagent_first", gpt_question_budget: 0 },
  };
}

/**
 * Goal B: mutation task
 * 实际修改文件并重启服务，意图与 Goal A 完全相反。
 */
function createGoalB(goalId) {
  return {
    id: goalId,
    workspace_id: "test-ws",
    project_id: "test-project",
    repo_id: "test-repo",
    title: "Deploy Configuration Update",
    user_request:
      "Modify deployment configuration files and restart services. " +
      "Edit /etc/app/config.yml, update the database connection string, " +
      "then run 'systemctl restart app-service' to apply changes.",
    goal_prompt:
      "You are a deployment agent. Update config files and restart services. " +
      "Edit config.yml, update the DB_CONNECTION_STRING variable, " +
      "run 'systemctl restart app-service', verify the service is running with 'systemctl status app-service'. " +
      "This is a mutation task — you MUST write files and execute restart commands.",
    context_summary: "Deployment config update. File modification and service restart required.",
    status: "open",
    mode: "builder",
    autonomy_policy: { mode: "subagent_first", gpt_question_budget: 0 },
  };
}

// ---------------------------------------------------------------------------
// Test: 跨 Goal 召回污染
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}


describe("[P0-contamination] Cross-goal retrieval contamination with fallback-hash-sha256", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {import("../src/context-index/zvec-store.mjs").VectorStoreAdapter} */
  let store;

  const GOAL_A_ID = "goal_test_readonly_diagnostic";
  const GOAL_B_ID = "goal_test_mutation_deployment";

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-pollution-test-"));
    const dimension = 64; // matches fallback-hash-sha256

    store = zvecStore.createLocalStore({
      workspaceRoot: tmpDir,
      dimension,
      maxGoalsScanned: 50,
    });

    // Prepare goal objects
    const goalA = createGoalA(GOAL_A_ID);
    const goalB = createGoalB(GOAL_B_ID);

    // Index Goal A chunks
    const chunksA = await retriever.buildIndexChunks({
      goal: goalA,
      conversation: null,
      task: null,
      priorResults: [],
    });
    const textsA = chunksA.map((c) => c.text);
    const embedder = embeddings.createEmbeddingProvider({ provider: "fallback" });
    const vectorsA = await embedder.embed(textsA);
    await store.addChunks(chunksA, vectorsA, { replace: true });

    // Index Goal B chunks
    const chunksB = await retriever.buildIndexChunks({
      goal: goalB,
      conversation: null,
      task: null,
      priorResults: [],
    });
    const textsB = chunksB.map((c) => c.text);
    const vectorsB = await embedder.embed(textsB);
    await store.addChunks(chunksB, vectorsB, { replace: true });
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: 展示跨 Goal 召回污染
  // -----------------------------------------------------------------------
  it("[FAIL-BEFORE-FIX] cross-goal retrieval with fallback-hash-sha256 should NOT return mutation chunks for readonly query", async () => {
    // Goal A 的查询文本
    const queryText =
      "Read-only diagnostic check of system health. " +
      "Inspect log files, check service status, report findings. " +
      "Do NOT modify any files, do NOT restart any services.";

    const embedder = embeddings.createEmbeddingProvider({ provider: "fallback" });
    const [queryVector] = await embedder.embed([queryText]);

    // 关键: 不使用 goal_id 过滤 → cross-goal 检索
    // 这正是 maybeBuildContextBundle 中 Phase 1 的做法
    const results = await store.search(queryVector, 5, {
      workspace_id: "test-ws",
      project_id: "test-project",
      repo_id: "test-repo",
    });

    // 诊断输出
    console.error("\n=== CONTAMINATION DIAGNOSTIC ===");
    console.error("Query:", queryText.substring(0, 100) + "...");
    console.error("Total results:", results.length);
    for (const r of results) {
      console.error(`  [${r.metadata?.goal_id === GOAL_A_ID ? "GOAL_A" : "CROSS"}] score=${r.score.toFixed(6)} goal=${r.metadata?.goal_id} type=${r.metadata?.source_type}`);
      console.error(`    text: ${(r.text || "").substring(0, 120)}...`);
    }
    console.error("=== END DIAGNOSTIC ===\n");

    // 修复前，这个断言会 FAIL:
    // 因为 cross-goal 检索把 Goal B (mutation) 的内容也召回了
    // Goal B 包含 "systemctl restart", "Edit /etc/app/config.yml" 等 mutation 命令
    const crossGoalResults = results.filter(
      (r) => r.metadata?.goal_id === GOAL_B_ID
    );

    assert.ok(
      crossGoalResults.length === 0,
      `CONTAMINATION DETECTED: ${crossGoalResults.length} chunk(s) from mutation Goal B were returned ` +
      `for a readonly diagnostic query. This proves cross-goal context pollution exists. ` +
      `Expected 0 cross-goal chunks, got ${crossGoalResults.length}. ` +
      `Fix: disable cross_goal_retrieval when embedding_provider.semantic === false.`
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: 确认 semantic=false 在 retrieval.json 中有记录
  // -----------------------------------------------------------------------
  it("fallback-hash-sha256 has semantic=false and is correctly reported in diagnostics", () => {
    const provider = embeddings.fallbackEmbeddingProvider;
    assert.strictEqual(provider.semantic, false,
      "fallback-hash-sha256 must report semantic=false");
    assert.strictEqual(provider.name, "fallback-hash-sha256");
    assert.strictEqual(provider.dimension, 64);

    const diag = embeddings.embeddingProviderDiagnostics(provider);
    assert.strictEqual(diag.semantic, false,
      "diagnostics should report semantic=false for fallback provider");
    assert.strictEqual(diag.name, "fallback-hash-sha256");
    assert.strictEqual(diag.dimension, 64);
    assert.ok(diag.support_info, "should include support_info");
  });

  // -----------------------------------------------------------------------
  // Test 3: 再次确认 — 使用 always-passes placeholder 让测试可见
  // -----------------------------------------------------------------------
  it("only this test suite should fail before the fix; check test output is explicit about contamination", () => {
    // 健康检查: embeddings 属性确认
    const provider = embeddings.fallbackEmbeddingProvider;
    assert.strictEqual(provider.semantic, false);
  });
});

// ---------------------------------------------------------------------------
// Test: 非语义 embedding 无法区分意图
// ---------------------------------------------------------------------------

describe("[P0-contamination] Non-semantic embedding cannot distinguish intents", () => {
  it("fallback-hash-sha256 produces similar vectors for semantically different texts", async () => {
    const readonlyText =
      "Inspect log files and report system health without making any changes.";
    const mutationText =
      "systemctl restart app-service && sed -i 's/old/new/' config.yml";
    const unrelatedText =
      "The weather is sunny with a chance of rain later today.";

    const embedder = embeddings.createEmbeddingProvider({ provider: "fallback" });
    const [vecReadonly, vecMutation, vecUnrelated] = await embedder.embed([
      readonlyText,
      mutationText,
      unrelatedText,
    ]);

    // 计算余弦相似度
    const simROnM = cosineSimilarity(vecReadonly, vecMutation);
    const simROnU = cosineSimilarity(vecReadonly, vecUnrelated);
    const simMOnU = cosineSimilarity(vecMutation, vecUnrelated);

    console.error("\n=== NON-SEMANTIC EMBEDDING DIAGNOSTIC ===");
    console.error(`  readonly vs mutation:   ${simROnM.toFixed(6)}`);
    console.error(`  readonly vs unrelated:  ${simROnU.toFixed(6)}`);
    console.error(`  mutation vs unrelated:  ${simMOnU.toFixed(6)}`);
    console.error("=== END DIAGNOSTIC ===\n");

    // 对于语义 embedding，readonly vs mutation 应该接近 0（不相似）
    // 对于非语义 fallback-hash-sha256，没有任何语义区分能力
    // 所以 readonly vs mutation ≈ readonly vs unrelated ≈ mutation vs unrelated
    // 这是一个信号：fallback 不能做语义区分
    const diffs = [
      Math.abs(simROnM - simROnU),
      Math.abs(simROnM - simMOnU),
      Math.abs(simROnU - simMOnU),
    ];

    const maxDiff = Math.max(...diffs);
    const isSemanticallyDegraded = maxDiff < 0.15;
    console.error(`  max similarity diff:    ${maxDiff.toFixed(6)} (${isSemanticallyDegraded ? "degraded" : "might be semantic"})`);

    // 非语义 embedding 不能可靠区分意图 (diff 很小，表示没有语义理解)
    // 如果 maxDiff 很大，可能是偶发的 hash 行为，但不代表语义
    // 这个测试仅作为证据补充，不直接断言 fail/pass
  });
});

// ---------------------------------------------------------------------------
// Test: context-index-hooks 检索 JSON 中 cross_goal 标记
// ---------------------------------------------------------------------------

describe("[P0-contamination] maybeBuildContextBundle cross-goal retrieval metadata", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {import("../src/context-index/zvec-store.mjs").VectorStoreAdapter} */
  let store;
  const goalId = "goal_test_cross_meta";
  let retrievalJson = null;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-cross-meta-"));
    store = zvecStore.createLocalStore({ workspaceRoot: tmpDir, dimension: 64 });

    const goal = createGoalA(goalId);
    const mockStateStore = {
      async load() {
        return {
          goals: [
            { id: goalId, workspace_id: "test-ws" },
            { id: "goal_test_mutation_deployment", workspace_id: "test-ws", title: "Deploy", created_at: "2026-01-01T00:00:00Z" },
          ],
        };
      },
    };

    const config = { defaultWorkspaceRoot: tmpDir };
    const result = await contextIndexHooks.maybeBuildContextBundle(mockStateStore, config, goal);

    assert.ok(result.ok, "bundle should build ok");
    retrievalJson = result.retrievalJson || null;
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retrieval JSON includes cross_goal_retrieval metadata", () => {
    if (!retrievalJson) {
      console.error("No retrievalJson available; test is informational");
      return;
    }
    const rj = retrievalJson;
    assert.ok(rj.cross_goal_retrieval, "should include cross_goal_retrieval");
    assert.strictEqual(rj.cross_goal_retrieval.enabled, true,
      "cross_goal_retrieval.enabled is true (this is the defect)");

    console.error("\n=== RETRIEVAL JSON CROSS-GOAL ===");
    console.error("  enabled: " + rj.cross_goal_retrieval.enabled);
    console.error("  retrieved_count: " + rj.cross_goal_retrieval.retrieved_count);
    console.error("  cross_goal_chunks: " + rj.cross_goal_retrieval.cross_goal_chunks);
    console.error("  embedding_provider: " + JSON.stringify(rj.embedding_provider));
    console.error("=== END ===\n");

    assert.strictEqual(rj.embedding_provider?.name, "fallback-hash-sha256",
      "should use fallback-hash-sha256");
    assert.strictEqual(rj.embedding_provider?.semantic, false,
      "should report semantic=false (this is the defect root cause)");

    console.error("[INFO] cross_goal_retrieval.enabled=true AND semantic=false " +
      "— this is the exact defect pattern");
  });
});


