export function planDynamicTeam(profile = {}, { task_id = null } = {}) {
  const roles = Array.isArray(profile.roles) ? profile.roles : [];
  const shards = Array.isArray(profile.shards) ? profile.shards : [];
  const nodes = [];

  if (profile.strategy === "fanout_join" && shards.length > 0) {
    for (const shard of shards) {
      nodes.push({
        id: `${task_id || "task"}:${shard.key}`,
        role: shard.owner_role || "builder",
        shard_key: shard.key,
        files: Array.isArray(shard.files) ? shard.files : [],
        dependencies: [],
      });
    }
    for (const role of roles.filter((role) => !nodes.some((node) => node.role === role))) {
      nodes.push({ id: `${task_id || "task"}:${role}`, role, shard_key: null, files: [], dependencies: [] });
    }
  } else {
    roles.forEach((role, index) => {
      nodes.push({
        id: `${task_id || "task"}:${role}`,
        role,
        shard_key: null,
        files: [],
        dependencies: index === 0 ? [] : [`${task_id || "task"}:${roles[index - 1]}`],
      });
    });
  }

  return {
    schema_version: profile.schema_version || 1,
    task_id,
    strategy: profile.strategy || "sequential",
    nodes,
    edges: nodes.flatMap((node) => node.dependencies.map((from) => ({ from, to: node.id }))),
    creates_agent_runs: false,
  };
}
