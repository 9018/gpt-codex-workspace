import { GPTWORK_TOOL_CARD_URI, GPTWORK_WIDGET_DOMAIN } from "./constants.mjs";

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

