import { GPTWORK_TOOL_CARD_URI, GPTWORK_WIDGET_DOMAIN } from "./constants.mjs";

export const GPTWORK_RENDER_MODES = Object.freeze(["text", "selective", "card"]);

const SELECTIVE_CARD_TOOLS = new Set([
  "show_changes",
  "get_task_review_packet",
  "read_handoff",
]);

export function normalizeCardRenderMode(value = "text") {
  const mode = String(value || "text").trim().toLowerCase();
  if (!GPTWORK_RENDER_MODES.includes(mode)) {
    throw new Error(`renderMode must be one of: ${GPTWORK_RENDER_MODES.join(", ")}; got: ${value}`);
  }
  return mode;
}

export function toolCardMeta() {
  return {
    ui: { resourceUri: GPTWORK_TOOL_CARD_URI },
    "openai/outputTemplate": GPTWORK_TOOL_CARD_URI,
  };
}

export function toolCardResourceMeta() {
  return {
    ui: {
      prefersBorder: true,
      domain: GPTWORK_WIDGET_DOMAIN,
      csp: {
        connectDomains: [],
        resourceDomains: [],
      },
    },
    "openai/widgetDescription": "Renders GPTWork runtime status, worker state, goals, tasks, queue items, diffs, handoff plans, and diagnostics as compact cards with safe fallbacks.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetDomain": GPTWORK_WIDGET_DOMAIN,
    "openai/widgetCSP": {
      connect_domains: [],
      resource_domains: [],
    },
  };
}

export function hasToolCardMetadata(metadata = {}) {
  return Boolean(metadata.outputTemplate || metadata.resourceUri);
}

export function isToolCardEnabled({ renderMode = "card", toolName = "", metadata = {} } = {}) {
  if (!hasToolCardMetadata(metadata)) return false;
  const mode = normalizeCardRenderMode(renderMode);
  if (mode === "text") return false;
  if (mode === "card") return true;
  return SELECTIVE_CARD_TOOLS.has(toolName);
}

export function isWidgetResourceEnabled(renderMode = "card") {
  return normalizeCardRenderMode(renderMode) !== "text";
}
