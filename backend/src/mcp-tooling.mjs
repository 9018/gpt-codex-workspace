/**
 * mcp-tooling.mjs — HTTP/MCP protocol helpers
 *
 * Pure functions for MCP JSON-RPC, SSE transport, and HTTP utilities.
 * No coupling to gptwork-server internals.
 */
import { createHash } from "node:crypto";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export function schema(properties, required = []) {
  const mapped = {};
  for (const [key, descriptor] of Object.entries(properties)) {
    if (typeof descriptor === "string") mapped[key] = { type: descriptor };
    else if (descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)) mapped[key] = { ...descriptor };
    else mapped[key] = { type: "string" };
  }
  return { type: "object", properties: mapped, required, additionalProperties: false };
}

export function toolList(tools) {
  return Object.entries(tools).map(([name, value]) => {
    const descriptor = {
      name,
      description: value.description,
      inputSchema: value.inputSchema,
      outputSchema: { type: "object", additionalProperties: true }
    };
    if (value.metadata?.outputTemplate) {
      descriptor._meta = { "openai/outputTemplate": value.metadata.outputTemplate };
    }
    return descriptor;
  });
}

export function resourceList() {
  return [{
    uri: "ui://widget/gptwork-card-v1.html",
    name: "GPTWork Compact Card",
    mimeType: "text/html",
    description: "Compact GPTWork status/result card for ChatGPT Apps SDK clients."
  }];
}

export function readResource(uri) {
  if (uri !== "ui://widget/gptwork-card-v1.html") return null;
  return {
    uri,
    mimeType: "text/html",
    text: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:12px;color:#17202a;background:#ffffff}
.card{border:1px solid #d8dee4;border-radius:8px;padding:12px;max-width:720px}.title{font-weight:650;margin-bottom:8px}.muted{color:#57606a;font-size:13px}
pre{white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:6px;padding:8px;overflow:auto}
</style></head><body><div class="card"><div class="title">GPTWork</div><div class="muted">Compact result card</div><pre id="content"></pre></div><script>
const data = window.openai?.toolOutput || window.openai?.structuredContent || {};
document.getElementById('content').textContent = JSON.stringify(data, null, 2);
</script></body></html>`
  };
}

export function initializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      experimental: {},
      logging: {},
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
      tools: { listChanged: true },
      extensions: { "io.modelcontextprotocol/ui": {} }
    },
    serverInfo: { name: "GPTWork MCP", version: "0.1.0" }
  };
}

export function jsonResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function endSse(res, body) {
  setSseHeaders(res);
  res.end(body);
}

export function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
}

export function writeSseMessage(res, message) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export function endJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(status === 204 ? "" : JSON.stringify(body));
}

export async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function shellQuotee(value) {
  if (process.platform === "win32") return `"${String(value).replaceAll('"', '\\"')}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
