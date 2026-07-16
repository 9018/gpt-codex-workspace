/**
 * http-handler.mjs — HTTP/MCP transport handler
 *
 * Extracted from gptwork-server.mjs to reduce composition-root complexity.
 * Pure HTTP request/response wiring with no direct coupling to tool groups,
 * worker loop, or goal/task orchestration.
 */
import { randomUUID } from "node:crypto";
import {
  setCors, endJson, endSse, setSseHeaders, writeSseMessage, readRequest,
} from "./mcp-tooling.mjs";
import { headersWithPathToken } from "./auth-context.mjs";

/**
 * Handle incoming HTTP requests for the MCP server.
 *
 * Routes:
 *   OPTIONS *      → 204 CORS preflight
 *   GET /health    → 200 health check
 *   GET /mcp*      → SSE stream connection
 *   POST /mcp*     → JSON-RPC over SSE (delegates to server.handleRpc)
 *   other          → 404
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} server - The MCP server object (must expose handleRpc())
 */
export async function handleHttp(req, res, server) {
  setCors(res);
  if (req.method === "OPTIONS") return endJson(res, 204, {});
  if (req.url === "/health") return endJson(res, 200, { ok: true, service: "gptwork-mcp", time: new Date().toISOString() });
  if (!req.url?.startsWith("/mcp")) return endJson(res, 404, { error: "not found" });
  if (req.method === "GET") return endSse(res, ": connected\n\n");
  if (req.method !== "POST") return endJson(res, 406, { jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Not Acceptable: use POST with Accept: text/event-stream" } });

  try {
    const raw = await readRequest(req);
    const message = JSON.parse(raw || "{}");
    res.setHeader("mcp-session-id", req.headers["mcp-session-id"] || randomUUID());
    setSseHeaders(res);
    const response = await server.handleRpc(message, headersWithPathToken(req), (progress) => writeSseMessage(res, progress));
    if (response == null) {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (response) writeSseMessage(res, response);
    res.end();
  } catch (error) {
    const response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
    if (res.headersSent) {
      writeSseMessage(res, response);
      res.end();
    } else {
      endJson(res, 400, response);
    }
  }
}
