import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeRetrievalIntent,
  extractRetrievalEntities,
  rerankRetrievalCandidates,
} from "../src/context-index/retrieval-policy.mjs";
import { evaluateRetrieval } from "../src/context-index/retrieval-evaluator.mjs";

describe("context retrieval policy", () => {
  it("classifies runtime diagnosis and extracts exact entities", () => {
    const plan = analyzeRetrievalIntent(
      "为什么 task_abc-123 一直 waiting_for_lock，检查 backend/src/context-index/retriever.mjs 和 b85468b",
      { taskId: "task_current", rootGoalId: "goal_root" },
    );
    assert.equal(plan.intent, "runtime_diagnosis");
    assert.equal(plan.requires_fresh_state, true);
    assert.deepEqual(plan.entities.task_ids, ["task_abc-123"]);
    assert.deepEqual(plan.entities.paths, ["backend/src/context-index/retriever.mjs"]);
    assert.ok(plan.entities.commits.includes("b85468b"));
  });

  it("ranks exact task ids above stronger semantic neighbors", () => {
    const plan = analyzeRetrievalIntent("检查 task_target 的失败原因", {
      taskId: "task_current",
      rootGoalId: "goal_root",
    });
    const results = rerankRetrievalCandidates([
      { id: "semantic", text: "task execution failure details", score: 0.95, metadata: { task_id: "task_other", root_goal_id: "goal_other", source_type: "result" } },
      { id: "exact", text: "result for task_target", score: 0.42, metadata: { task_id: "task_target", root_goal_id: "goal_other", source_type: "result" } },
    ], plan, 2);
    assert.equal(results[0].id, "exact");
    assert.ok(results[0].score_breakdown.exact_entity > 0);
  });

  it("penalizes unrelated deep followup chains", () => {
    const plan = analyzeRetrievalIntent("修复当前代码", {
      taskId: "task_current",
      rootGoalId: "goal_root",
    });
    const results = rerankRetrievalCandidates([
      { id: "current", text: "current implementation", score: 0.5, metadata: { task_id: "task_current", root_goal_id: "goal_root", source_type: "code" } },
      { id: "polluted", text: "Followup: Repair: Followup: unrelated result", score: 0.9, metadata: { task_id: "task_old", root_goal_id: "goal_old", source_type: "result", lineage_depth: 3 } },
    ], plan, 2);
    assert.equal(results[0].id, "current");
    assert.ok(results[1].score_breakdown.cross_lineage_penalty < 0);
    assert.ok(results[1].score_breakdown.followup_penalty < 0);
  });

  it("allows explicit historical task lookup across lineage", () => {
    const plan = analyzeRetrievalIntent("查看历史 task_old", {
      taskId: "task_current",
      rootGoalId: "goal_root",
    });
    const [result] = rerankRetrievalCandidates([
      { id: "old", text: "task_old previous result", score: 0.4, metadata: { task_id: "task_old", root_goal_id: "goal_old", source_type: "result", lineage_depth: 4 } },
    ], plan, 1);
    assert.equal(plan.allow_cross_lineage, true);
    assert.equal(result.score_breakdown.cross_lineage_penalty, 0);
    assert.equal(result.score_breakdown.followup_penalty, 0);
  });

  it("extracts ids, commits and paths deterministically", () => {
    const entities = extractRetrievalEntities("goal_xyz task_abc backend/src/a.mjs 0123456789abcdef");
    assert.deepEqual(entities.goal_ids, ["goal_xyz"]);
    assert.deepEqual(entities.task_ids, ["task_abc"]);
    assert.deepEqual(entities.paths, ["backend/src/a.mjs"]);
    assert.deepEqual(entities.commits, ["0123456789abcdef"]);
  });
});

describe("context retrieval evaluator", () => {
  it("computes ranking and pollution metrics", () => {
    const metrics = evaluateRetrieval([
      { id: "expected", metadata: { task_id: "task_current", root_goal_id: "goal_root", source_type: "task", freshness: "live" } },
      { id: "wrong", metadata: { task_id: "task_other", root_goal_id: "goal_other", source_type: "result", freshness: "stale" } },
    ], {
      k: 2,
      expected_ids: ["expected"],
      expected_source_types: ["task"],
      current_task_id: "task_current",
      root_goal_id: "goal_root",
      requires_fresh_state: true,
    });
    assert.equal(metrics.recall_at_k, 1);
    assert.equal(metrics.mrr, 1);
    assert.equal(metrics.source_routing_accuracy, 0.5);
    assert.equal(metrics.wrong_task_context_rate, 0.5);
    assert.equal(metrics.cross_lineage_pollution_rate, 0.5);
    assert.equal(metrics.stale_runtime_context_rate, 0.5);
  });
});

it("local store applies workstream and root-goal filters", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createLocalStore } = await import("../src/context-index/zvec-store.mjs");
  const root = mkdtempSync(join(tmpdir(), "retrieval-scope-"));
  try {
    const store = createLocalStore({ workspaceRoot: root, dimension: 2 });
    await store.addChunks([
      { id: "same", text: "same lineage", tokens: 2, metadata: { goal_id: "goal_a", workstream_id: "ws_a", root_goal_id: "goal_root_a", source_type: "result" } },
      { id: "other", text: "other lineage", tokens: 2, metadata: { goal_id: "goal_b", workstream_id: "ws_b", root_goal_id: "goal_root_b", source_type: "result" } },
    ], [[1, 0], [1, 0]]);
    const results = await store.search([1, 0], 10, { workstream_id: "ws_a", root_goal_id: "goal_root_a" });
    assert.deepStrictEqual(results.map((item) => item.id), ["same"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("bundle retrieval diagnostics expose policy context and deterministic evaluation", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { maybeBuildContextBundle } = await import("../src/context-index/context-index-hooks.mjs");
  const root = mkdtempSync(join(tmpdir(), "retrieval-hook-"));
  try {
    const store = { async load() { return { goals: [], tasks: [] }; } };
    const goal = {
      id: "goal_current",
      root_goal_id: "goal_root",
      workstream_id: "ws_current",
      workspace_id: "hosted-default",
      project_id: "default",
      title: "Diagnose task_current waiting_for_lock",
      user_request: "Why is task_current waiting_for_lock?",
    };
    const task = {
      id: "task_current",
      root_goal_id: "goal_root",
      workstream_id: "ws_current",
    };
    const result = await maybeBuildContextBundle(store, {
      defaultWorkspaceRoot: root,
      contextVectorStore: "local",
      contextEmbeddingConfig: { provider: "fallback" },
    }, goal, null, task);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.retrievalJson.policy.intent, "runtime_diagnosis");
    assert.strictEqual(result.retrievalJson.policy.current_task_id, "task_current");
    assert.strictEqual(result.retrievalJson.policy.root_goal_id, "goal_root");
    assert.strictEqual(result.retrievalJson.policy.workstream_id, "ws_current");
    assert.ok(result.retrievalJson.evaluation);
    assert.strictEqual(typeof result.retrievalJson.evaluation.wrong_task_context_rate, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retrieval recall counts unique expected entities and never exceeds one", async () => {
  const { evaluateRetrieval } = await import("../src/context-index/retrieval-evaluator.mjs");
  const results = [
    { id: "a", metadata: { task_id: "task_same" } },
    { id: "b", metadata: { task_id: "task_same" } },
    { id: "c", metadata: { task_id: "task_same" } },
  ];
  const metrics = evaluateRetrieval(results, { expected_ids: ["task_same"], k: 3 });
  assert.strictEqual(metrics.recall_at_k, 1);
  assert.strictEqual(metrics.exact_entity_hit_rate, 1);
});

it("time decay is applied before final top-k selection", async () => {
  const { retrieveContext } = await import("../src/context-index/retriever.mjs");
  const now = Date.now();
  const store = {
    name: "test-store",
    async search() {
      return [
        { id: "stale", text: "old result", score: 1, metadata: { source_type: "result", created_at: new Date(now - 10 * 86400000).toISOString() } },
        { id: "fresh", text: "fresh result", score: 0.9, metadata: { source_type: "result", created_at: new Date(now).toISOString() } },
      ];
    },
  };
  const embedder = { name: "test", dimension: 2, semantic: true, async embed() { return [[1, 0]]; } };
  const results = await retrieveContext({
    queryText: "history result",
    topK: 1,
    options: { storePrefer: store, embeddingConfig: { customProvider: embedder } },
    filters: { time_decay: 1 },
  });
  assert.strictEqual(results[0].id, "fresh");
});
