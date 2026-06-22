import { GPTWORK_TOOL_CARD_URI } from "./constants.mjs";
import { hasToolCardMetadata } from "./card-meta.mjs";
import { createHash } from "node:crypto";

const VOLATILE_KEYS = new Set([
  "current_time",
  "last_event_time",
  "lastEventAt",
  "loadedAt",
  "random_id",
  "renderCount",
  "renders",
  "savedAt",
  "timestamp",
]);

function stableStringify(value) {
  const seen = new WeakSet();
  function normalize(v) {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.map(normalize);
      seen.delete(v);
      return out;
    }
    const out = {};
    for (const key of Object.keys(v).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      if (key.startsWith("gptwork_")) continue;
      out[key] = normalize(v[key]);
    }
    seen.delete(v);
    return out;
  }
  return JSON.stringify(normalize(value));
}

export function payloadHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function tagToolResult(name, toolDescriptor, structuredContent) {
  const base = structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)
    ? structuredContent
    : { value: structuredContent };
  const hash = payloadHash(base);
  return {
    ...base,
    gptwork_tool: name,
    gptwork_title: toolDescriptor?.metadata?.name || name,
    gptwork_type: "tool_result",
    gptwork_payload_hash: hash,
    gptwork_card_instance_id: `${name}:${hash}`,
  };
}

export function toolResultMeta(name, toolDescriptor) {
  if (!hasToolCardMetadata(toolDescriptor?.metadata)) return undefined;
  return {
    tool: name,
    resourceUri: GPTWORK_TOOL_CARD_URI,
  };
}

export function shapeToolResult({ name, toolDescriptor, rawStructuredContent, summarizeToolResult }) {
  const structuredContent = toolResultMeta(name, toolDescriptor)
    ? tagToolResult(name, toolDescriptor, rawStructuredContent)
    : rawStructuredContent;
  const summary = typeof summarizeToolResult === "function"
    ? summarizeToolResult(name, structuredContent)
    : JSON.stringify(structuredContent);
  const result = {
    content: [{ type: "text", text: summary }],
    structuredContent,
    isError: false,
  };
  const meta = toolResultMeta(name, toolDescriptor);
  if (meta) result._meta = meta;
  return result;
}
