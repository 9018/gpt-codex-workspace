function relevant(item, expectedIds) {
  const ids = [item.id, item.metadata?.task_id, item.metadata?.goal_id, item.metadata?.source_path].filter(Boolean);
  return ids.some((id) => expectedIds.includes(id));
}

export function evaluateRetrieval(results = [], expectation = {}) {
  const expectedIds = Array.isArray(expectation.expected_ids) ? expectation.expected_ids : [];
  const expectedSources = Array.isArray(expectation.expected_source_types) ? expectation.expected_source_types : [];
  const currentTaskId = expectation.current_task_id || null;
  const currentRootGoalId = expectation.root_goal_id || null;
  const k = Number(expectation.k || results.length || 1);
  const top = results.slice(0, k);
  const firstRelevant = top.findIndex((item) => relevant(item, expectedIds));
  const relevantCount = top.filter((item) => relevant(item, expectedIds)).length;
  const wrongTaskCount = currentTaskId
    ? top.filter((item) => item.metadata?.task_id && item.metadata.task_id !== currentTaskId && !relevant(item, expectedIds)).length
    : 0;
  const crossLineageCount = currentRootGoalId
    ? top.filter((item) => item.metadata?.root_goal_id && item.metadata.root_goal_id !== currentRootGoalId && !relevant(item, expectedIds)).length
    : 0;
  const staleRuntimeCount = expectation.requires_fresh_state
    ? top.filter((item) => item.metadata?.freshness && item.metadata.freshness !== "live").length
    : 0;
  const sourceHits = expectedSources.length === 0
    ? 0
    : top.filter((item) => expectedSources.includes(item.metadata?.source_type)).length;

  return {
    k,
    recall_at_k: expectedIds.length === 0 ? null : relevantCount / expectedIds.length,
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    source_routing_accuracy: expectedSources.length === 0 ? null : sourceHits / Math.max(1, top.length),
    exact_entity_hit_rate: expectedIds.length === 0 ? null : relevantCount / expectedIds.length,
    wrong_task_context_rate: wrongTaskCount / Math.max(1, top.length),
    cross_lineage_pollution_rate: crossLineageCount / Math.max(1, top.length),
    stale_runtime_context_rate: staleRuntimeCount / Math.max(1, top.length),
  };
}
