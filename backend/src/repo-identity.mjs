export function configuredDefaultRepoId(config = {}) {
  if (typeof config.defaultRepoId === "string" && config.defaultRepoId.trim()) return config.defaultRepoId.trim();
  if (typeof config.default_repo_id === "string" && config.default_repo_id.trim()) return config.default_repo_id.trim();
  if (typeof config.registeredRepoId === "string" && config.registeredRepoId.trim()) return config.registeredRepoId.trim();
  if (config.defaultRepo?.repo_id) return String(config.defaultRepo.repo_id).trim();
  if (config.canonicalRepo?.repo_id) return String(config.canonicalRepo.repo_id).trim();
  if (config.repo?.repo_id) return String(config.repo.repo_id).trim();
  if (config.registry && typeof config.registry.getDefaultRepo === "function") {
    try {
      const record = config.registry.getDefaultRepo();
      if (record?.repo_id) return String(record.repo_id).trim();
    } catch {}
  }
  return "";
}

export function normalizeRepoId(repoId, config = {}) {
  const value = typeof repoId === "string" ? repoId.trim() : "";
  const defaultRepoId = configuredDefaultRepoId(config);
  if (!value) return defaultRepoId || "";
  if (value === "default") return defaultRepoId || "default";
  return value;
}

export function repoIdsEqual(left, right, config = {}) {
  return normalizeRepoId(left, config) === normalizeRepoId(right, config);
}
