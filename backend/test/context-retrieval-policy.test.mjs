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
