import { createHash } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createToolCatalogIndex(descriptors = []) {
  return [...descriptors]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((descriptor) => ({
      name: descriptor.name,
      title: descriptor.title || descriptor.name,
      tags: descriptor.tags || [],
      audience: descriptor.audience || [],
      side_effect: descriptor.metadata?.side_effect || null,
      execution_class: descriptor.metadata?.execution_class || null,
      short_description: String(descriptor.description || "").slice(0, 240),
      schema_digest: digest(descriptor.inputSchema || {}),
    }));
}

export function computeToolCatalogRevision(index = []) {
  return digest(index);
}
