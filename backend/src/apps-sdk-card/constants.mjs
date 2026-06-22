import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GPTWORK_TOOL_CARD_URI = "ui://widget/gptwork-tool-card-v2.html";
export const GPTWORK_LEGACY_CARD_V1_URI = "ui://widget/gptwork-card-v1.html";
export const GPTWORK_LEGACY_CARD_V2_URI = "ui://widget/gptwork-card-v2.html";
export const GPTWORK_LEGACY_TOOL_CARD_V1_URI = "ui://widget/gptwork-tool-card-v1.html";
export const GPTWORK_TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const GPTWORK_WIDGET_DOMAIN = process.env.GPTWORK_WIDGET_DOMAIN || "https://chat.openai.com";
export const GPTWORK_TOOL_CARD_VERSION = "gptwork-tool-card-v2";

export const APPS_SDK_CARD_DIR = dirname(fileURLToPath(import.meta.url));
export const APPS_SDK_CARD_WIDGET_PATH = join(APPS_SDK_CARD_DIR, "widget.html");

export function normalizeToolCardUri(uri) {
  if (!uri) return "";
  if (
    uri === GPTWORK_LEGACY_CARD_V1_URI ||
    uri === GPTWORK_LEGACY_CARD_V2_URI ||
    uri === GPTWORK_LEGACY_TOOL_CARD_V1_URI
  ) {
    return GPTWORK_TOOL_CARD_URI;
  }
  return uri;
}

