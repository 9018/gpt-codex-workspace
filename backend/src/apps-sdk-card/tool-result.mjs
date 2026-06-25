import { GPTWORK_TOOL_CARD_URI } from "./constants.mjs";
import { hasToolCardMetadata } from "./card-meta.mjs";
import { createHash } from "node:crypto";
import { buildCardViewModel, isCardViewModelEnabledTool, legacyFieldsFromCard } from "../card-view-model.mjs";
import { renderCardText } from "../card-render-text.mjs";

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

/**
 * Generate a compact safe summary and status from tool result data.
 * Used when the tool handler does not provide explicit summary/status fields.
 */
function generateAutoSummary(name, base) {
  const result = { summary: "", status: "" };

  // Use existing summary/status if present
  if (base && typeof base.summary === "string" && base.summary.length > 0) {
    result.summary = base.summary;
  }
  if (base && typeof base.status === "string" && base.status.length > 0) {
    result.status = base.status;
  }

  // Auto-detect status from ok/errors if not set
  if (!result.status) {
    if (base && typeof base.ok === "boolean") {
      result.status = base.ok ? "ok" : "error";
    } else if (base && (base.errors || base.crashed || base.failed)) {
      const errs = Array.isArray(base.errors) ? base.errors.length : 1;
      result.status = errs > 0 ? "error" : "ok";
    } else {
      result.status = "info";
    }
  }

  // Auto-generate summary from recognized patterns if not provided
  if (!result.summary && base && typeof base === "object" && !Array.isArray(base)) {
    const keys = Object.keys(base);
    const count = keys.length;

    // Self-test results pattern
    if (Array.isArray(base.results)) {
      const pass = base.results.filter(r => r.status === "PASS").length;
      const warn = base.results.filter(r => r.status === "WARN").length;
      const fail = base.results.filter(r => r.status === "FAIL").length;
      const parts = [];
      if (pass > 0) parts.push(pass + " PASS");
      if (warn > 0) parts.push(warn + " WARN");
      if (fail > 0) parts.push(fail + " FAIL");
      result.summary = parts.length > 0 ? (name + ": " + parts.join(", ")) : (name + ": " + count + " fields");
    }
    // Count-based summaries
    else if (base.tasks !== undefined || base.goals !== undefined || base.items !== undefined || base.queue !== undefined || base.active !== undefined) {
      const parts = [];
      if (base.tasks !== undefined) parts.push("tasks: " + base.tasks);
      if (base.goals !== undefined) parts.push("goals: " + base.goals);
      if (base.items !== undefined) parts.push("items: " + (Array.isArray(base.items) ? base.items.length : base.items));
      if (base.queue !== undefined) parts.push("queue: " + (typeof base.queue === "object" ? "present" : base.queue));
      result.summary = name + " — " + parts.join(", ");
    } else {
      result.summary = name + " — " + count + " fields";
    }
  }
  return result;
}

export function payloadHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function tagToolResult(name, toolDescriptor, structuredContent) {
  const base = structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)
    ? structuredContent
    : { value: structuredContent };
  const auto = generateAutoSummary(name, base);
  const hash = payloadHash(base);
  const title = toolDescriptor?.metadata?.name || name;
  const card = isCardViewModelEnabledTool(name)
    ? buildCardViewModel(name, base, { payload_hash: hash, card_instance_id: `${name}:${hash}`, title })
    : undefined;
  if (card) {
    if (base.summary) card.summary = base.summary;
    else if (auto.summary) card.summary = auto.summary;
    if (base.status) card.status = base.status;
  }
  const legacy = card ? legacyFieldsFromCard(card) : {};
  return {
    ...base,
    ...(card ? { card } : {}),
    gptwork_tool: name,
    gptwork_title: title,
    summary: card?.summary || base.summary || auto.summary,
    status: card?.status || base.status || auto.status,
    gptwork_type: "tool_result",
    gptwork_payload_hash: hash,
    gptwork_card_instance_id: `${name}:${hash}`,
    ...(legacy.keyValues ? { keyValues: base.keyValues || legacy.keyValues } : {}),
    ...(legacy.items ? { items: base.items || legacy.items } : {}),
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
    : structuredContent?.card
      ? renderCardText(structuredContent.card)
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
