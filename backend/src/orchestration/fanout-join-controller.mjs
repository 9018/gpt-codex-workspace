import { buildFanoutParentNodeId, buildShardNodeId } from "./task-fanout-service.mjs";
import { buildJoinNodeId } from "./task-join-service.mjs";

export function buildFanoutJoinPlan(profile = {}, { workstream_id, phase = "build", iteration = 0 } = {}) {
  const shards = Array.isArray(profile.shards) ? profile.shards : [];
  const parentId = buildFanoutParentNodeId({ workstream_id, phase, iteration });
  const shardNodes = shards.map((shard, index) => ({
    id: buildShardNodeId({ workstream_id, phase, shard_key: shard.key || `shard_${index}`, iteration }),
    role: shard.owner_role || "builder",
    shard_key: shard.key || `shard_${index}`,
    files: Array.isArray(shard.files) ? shard.files : [],
    fanout_parent_id: parentId,
  }));
  const joinId = buildJoinNodeId({ workstream_id, phase, shard_key: "integration", iteration });

  return {
    parent_node: { id: parentId, node_type: "fanout", shard_count: shardNodes.length },
    shard_nodes: shardNodes,
    join_node: {
      id: joinId,
      node_type: "join",
      join_condition: profile.join_policy?.type || "all_completed",
      conflict_policy: profile.join_policy?.conflict_policy || "integration_command",
    },
    edges: [
      ...shardNodes.map((node) => ({ from: parentId, to: node.id, condition: "all_completed" })),
      ...shardNodes.map((node) => ({ from: node.id, to: joinId, condition: profile.join_policy?.type || "all_completed" })),
    ],
  };
}
