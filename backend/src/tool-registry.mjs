import { normalizeToolCardUri } from "./mcp-tooling.mjs";

function normalizeCardUri(uri) {
  return normalizeToolCardUri(uri);
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
