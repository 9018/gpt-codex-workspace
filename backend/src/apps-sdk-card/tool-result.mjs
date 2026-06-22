import { GPTWORK_TOOL_CARD_URI } from "./constants.mjs";
import { hasToolCardMetadata } from "./card-meta.mjs";

export function tagToolResult(name, toolDescriptor, structuredContent) {
  const base = structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)
    ? structuredContent
    : { value: structuredContent };
  return {
    ...base,
    gptwork_tool: name,
    gptwork_title: toolDescriptor?.metadata?.name || name,
    gptwork_type: "tool_result",
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
