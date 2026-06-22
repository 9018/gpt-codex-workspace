import { readFileSync } from "node:fs";
import {
  APPS_SDK_CARD_WIDGET_PATH,
  GPTWORK_LEGACY_CARD_V1_URI,
  GPTWORK_LEGACY_CARD_V2_URI,
  GPTWORK_LEGACY_TOOL_CARD_V1_URI,
  GPTWORK_LEGACY_TOOL_CARD_V2_URI,
  GPTWORK_LEGACY_TOOL_CARD_V3_URI,
  GPTWORK_LEGACY_TOOL_CARD_V4_URI,
  GPTWORK_TOOL_CARD_MIME_TYPE,
  GPTWORK_TOOL_CARD_URI,
} from "./constants.mjs";
import { toolCardResourceMeta } from "./card-meta.mjs";

const widgetHtml = readFileSync(APPS_SDK_CARD_WIDGET_PATH, "utf8");

export function resourceList() {
  return [
    {
      uri: GPTWORK_LEGACY_CARD_V1_URI,
      name: "GPTWork Compact Card (v1)",
      mimeType: "text/html",
      description: "Legacy compact GPTWork status/result card for ChatGPT Apps SDK clients.",
    },
    {
      uri: GPTWORK_TOOL_CARD_URI,
      name: "GPTWork Tool Card",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "GPTWork Apps SDK tool card for structured status, task, queue, diff, handoff, and diagnostic results.",
      ...toolCardResourceMeta(),
    },
    {
      uri: GPTWORK_LEGACY_TOOL_CARD_V1_URI,
      name: "GPTWork Tool Card (v1 legacy)",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "Legacy GPTWork tool card URI kept for older cached clients. New tool descriptors use the GPTWork Tool Card v5 URI.",
      ...toolCardResourceMeta(),
    },
    {
      uri: GPTWORK_LEGACY_TOOL_CARD_V2_URI,
      name: "GPTWork Tool Card (v2 legacy)",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "Legacy GPTWork tool card v2 URI kept for older cached clients. New tool descriptors use the GPTWork Tool Card v5 URI.",
      ...toolCardResourceMeta(),
    },
    {
      uri: GPTWORK_LEGACY_TOOL_CARD_V3_URI,
      name: "GPTWork Tool Card (v3 legacy)",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "Legacy GPTWork tool card v3 URI kept for older cached clients. New tool descriptors use the GPTWork Tool Card v5 URI.",
      ...toolCardResourceMeta(),
    },
    {
      uri: GPTWORK_LEGACY_TOOL_CARD_V4_URI,
      name: "GPTWork Tool Card (v4 legacy)",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "Legacy GPTWork tool card v4 URI kept for older cached clients. New tool descriptors use the GPTWork Tool Card v5 URI.",
      ...toolCardResourceMeta(),
    },
    {
      uri: GPTWORK_LEGACY_CARD_V2_URI,
      name: "GPTWork Apps SDK Card (v2 legacy)",
      mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
      description: "Legacy GPTWork Apps SDK card URI kept for older clients. New tool descriptors use the GPTWork Tool Card v2 URI.",
      ...toolCardResourceMeta(),
    },
  ];
}

export function readToolCardResource(uri) {
  return {
    uri,
    mimeType: GPTWORK_TOOL_CARD_MIME_TYPE,
    _meta: toolCardResourceMeta(),
    text: widgetHtml,
  };
}

export function canReadToolCardResource(uri) {
  return uri === GPTWORK_TOOL_CARD_URI ||
    uri === GPTWORK_LEGACY_TOOL_CARD_V1_URI ||
    uri === GPTWORK_LEGACY_TOOL_CARD_V2_URI ||
    uri === GPTWORK_LEGACY_TOOL_CARD_V3_URI ||
    uri === GPTWORK_LEGACY_TOOL_CARD_V4_URI ||
    uri === GPTWORK_LEGACY_CARD_V2_URI;
}
