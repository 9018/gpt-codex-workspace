import { GPTWORK_LEGACY_CARD_V1_URI, GPTWORK_LEGACY_CARD_V2_URI, GPTWORK_TOOL_CARD_URI } from "./mcp-tooling.mjs";

function normalizeCardUri(uri) {
  if (!uri) return "";
  if (uri === GPTWORK_LEGACY_CARD_V1_URI || uri === GPTWORK_LEGACY_CARD_V2_URI) return GPTWORK_TOOL_CARD_URI;
  return uri;
}

export function createTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    const {
      name,
      description,
      inputSchema: descriptorSchema,
      handler: descriptorHandler,
      audience = [],
      modes = [],
      outputCard = "",
      examples = [],
      tags = [],
      outputTemplate = "",
      resourceUri = "",
      annotations = {},
    } = descriptionOrDescriptor;
    return {
      description,
      inputSchema: descriptorSchema,
      handler: descriptorHandler,
      metadata: {
        name,
        audience,
        modes,
        outputCard,
        examples,
        tags,
        outputTemplate: normalizeCardUri(outputTemplate),
        resourceUri: normalizeCardUri(resourceUri || outputTemplate),
        annotations,
      },
    };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}
