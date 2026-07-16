export function buildToolDiscoveryDiagnostics({
  catalog,
  discoveryConfig,
  callableToolCount,
  exposedToolCount,
} = {}) {
  return {
    mode: discoveryConfig?.mode || (discoveryConfig?.enabled ? "delayed" : "eager"),
    enabled: Boolean(discoveryConfig?.enabled),
    configured_value: discoveryConfig?.configured_value ?? null,
    source: discoveryConfig?.source || "default",
    valid: discoveryConfig?.valid !== false,
    warning: discoveryConfig?.warning || null,
    initial_tool_count: Number(exposedToolCount || 0),
    callable_tool_count: Number(callableToolCount || 0),
    catalog_revision: catalog?.revision || null,
  };
}
