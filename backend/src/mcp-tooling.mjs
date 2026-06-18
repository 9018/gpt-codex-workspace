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
  for (const [key, type] of Object.entries(properties)) mapped[key] = { type };
  return { type: "object", properties: mapped, required, additionalProperties: false };
}

export function toolList(tools) {
  return Object.entries(tools).map(([name, value]) => ({
    name,
    description: value.description,
    inputSchema: value.inputSchema,
    outputSchema: { type: "object", additionalProperties: true }
  }));
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
