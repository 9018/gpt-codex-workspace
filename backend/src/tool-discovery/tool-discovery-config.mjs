const TRUE_VALUES = new Set(["true", "1"]);
const FALSE_VALUES = new Set(["false", "0", ""]);

export function parseBooleanEnv(value, { defaultValue = false } = {}) {
  if (value === undefined || value === null) {
    return { value: Boolean(defaultValue), valid: true, configured: false, raw: null };
  }
  if (typeof value === "boolean") {
    return { value, valid: true, configured: true, raw: String(value) };
  }
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return { value: true, valid: true, configured: true, raw: String(value) };
  if (FALSE_VALUES.has(normalized)) return { value: false, valid: true, configured: true, raw: String(value) };
  return { value: Boolean(defaultValue), valid: false, configured: true, raw: String(value) };
}

export function resolveToolDiscoveryConfig({
  env = process.env,
  runtimeConfig = null,
  explicitValue,
} = {}) {
  let raw;
  let source;
  if (explicitValue !== undefined) {
    raw = explicitValue;
    source = "options";
  } else if (runtimeConfig && runtimeConfig.value !== undefined) {
    raw = runtimeConfig.value;
    source = runtimeConfig.source || "runtime_config";
  } else if (env?.GPTWORK_DELAYED_TOOL_DISCOVERY !== undefined) {
    raw = env.GPTWORK_DELAYED_TOOL_DISCOVERY;
    source = "process.env";
  } else {
    raw = false;
    source = "default";
  }

  const parsed = parseBooleanEnv(raw);
  return {
    enabled: parsed.value,
    mode: parsed.value ? "delayed" : "eager",
    configured_value: parsed.raw,
    source,
    valid: parsed.valid,
    warning: parsed.valid ? null : "GPTWORK_DELAYED_TOOL_DISCOVERY must be true or false",
  };
}
