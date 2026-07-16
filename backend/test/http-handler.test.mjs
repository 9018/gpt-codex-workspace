import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleHttp } from "../src/http-handler.mjs";

/**
 * Build a minimal mock for http.IncomingMessage (req).
 */
function mockReq({ method = "GET", url = "/mcp", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json", ...headers };
  // Simulate async body reading via for-await
  let yielded = false;
  req[Symbol.asyncIterator] = function () {
    return {
      next() {
        if (yielded) return Promise.resolve({ done: true, value: undefined });
        yielded = true;
        return Promise.resolve({ done: false, value: Buffer.from(body || "", "utf8") });
      },
    };
  };
  return req;
}

/**
 * Build a minimal mock for http.ServerResponse (res).
 * Uses an object property for statusCode so external functions (endJson)
 * mutate the same reference that _statusCode inspects.
 * Headers stored with the exact key passed to setHeader (Node.js convention).
 */
function mockRes() {
  const chunks = [];
  const headers = {};
  const res = new EventEmitter();
  res.statusCode = 200;
  res._chunks = chunks;
  res._headers = headers;
  res._statusCode = () => res.statusCode;
  res._body = () => Buffer.concat(chunks).toString("utf8");
  res.setHeader = (k, v) => { headers[k] = v; };
  res.getHeader = (k) => headers[k];
  res.write = (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8")); };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    res.done = true;
    res.emit("finish");
  };
  res.writeHead = () => {}; // no-op for safety
  res.hasHeader = (k) => k in headers;
  return res;
}

/**
 * Build a minimal mock server (handleRpc conforming to createGptWorkServer return).
 */
function mockServer(response = null) {
  return {
    async handleRpc(message, _headers, _emitProgress) {
      return response;
    },
  };
}

test("OPTIONS returns 204 with CORS headers", async () => {
  const req = mockReq({ method: "OPTIONS", url: "/mcp" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 204);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
  assert.equal(res._body(), "");
});

test("GET /health returns 200 with service status", async () => {
  const req = mockReq({ method: "GET", url: "/health" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 200);
  const body = JSON.parse(res._body());
  assert.equal(body.ok, true);
  assert.equal(body.service, "gptwork-mcp");
  assert.ok(body.time);
});

test("non-MCP URL returns 404", async () => {
  const req = mockReq({ method: "GET", url: "/not-mcp" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 404);
  const body = JSON.parse(res._body());
  assert.equal(body.error, "not found");
});

test("GET /mcp opens SSE stream", async () => {
  const req = mockReq({ method: "GET", url: "/mcp" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 200);
  assert.equal(res._headers["Content-Type"], "text/event-stream");
  assert.equal(res._headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res._body(), ": connected\n\n");
});

test("POST /mcp with valid JSON-RPC delegates to handleRpc", async () => {
  const rpcResponse = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
  const server = mockServer(rpcResponse);

  const req = mockReq({
    method: "POST", url: "/mcp",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const res = mockRes();
  await handleHttp(req, res, server);

  assert.equal(res._statusCode(), 200);
  assert.equal(res._headers["Content-Type"], "text/event-stream");
  assert.ok(res.done);
  assert.match(res._body(), /"id":1/);
});

test("POST /mcp notification returns 202 Accepted with no body", async () => {
  const req = mockReq({
    method: "POST", url: "/mcp",
    headers: { "mcp-session-id": "notification-session" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const res = mockRes();
  await handleHttp(req, res, mockServer(null));

  assert.equal(res._statusCode(), 202);
  assert.equal(res._headers["mcp-session-id"], "notification-session");
  assert.equal(res._body(), "");
});

test("POST /mcp with invalid JSON returns parse error via 400", async () => {
  const req = mockReq({ method: "POST", url: "/mcp", body: "not-json" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 400);
  const body = JSON.parse(res._body());
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.ok(body.error);
  assert.match(body.error.message, /Unexpected token/);
});

test("PUT /mcp returns 406 Not Acceptable", async () => {
  const req = mockReq({ method: "PUT", url: "/mcp", body: "{}" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._statusCode(), 406);
  const body = JSON.parse(res._body());
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "server-error");
  assert.equal(body.error.code, -32600);
});

test("POST /mcp with path token is forwarded to handleRpc", async () => {
  const rpcResponse = { jsonrpc: "2.0", id: 5, result: { tools: [] } };
  const server = mockServer(rpcResponse);

  const req = mockReq({
    method: "POST", url: "/mcp/test-token",
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
  });
  const res = mockRes();
  await handleHttp(req, res, server);

  assert.equal(res._statusCode(), 200);
  assert.ok(res.done);
  assert.match(res._body(), /"id":5/);
});

test("handleRpc error returns 400 via endJson fallback", async () => {
  const server = {
    async handleRpc() {
      throw new Error("server blew up");
    },
  };

  const req = mockReq({
    method: "POST", url: "/mcp",
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} }),
  });
  const res = mockRes();
  await handleHttp(req, res, server);

  // Headers not sent yet -> endJson with 400
  assert.equal(res._statusCode(), 400);
  const body = JSON.parse(res._body());
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.equal(body.error.code, -32700);
  assert.match(body.error.message, /server blew up/);
});

test("mcp-session-id from request header is forwarded as response header", async () => {
  const server = {
    async handleRpc(message, _headers, _emitProgress) {
      return { jsonrpc: "2.0", id: 2, result: {} };
    },
  };

  const req = mockReq({
    method: "POST", url: "/mcp",
    headers: { "mcp-session-id": "my-session-123" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
  });
  const res = mockRes();
  await handleHttp(req, res, server);

  assert.equal(res._headers["mcp-session-id"], "my-session-123");
});

test("CORS headers set on all responses", async () => {
  const req = mockReq({ method: "GET", url: "/health" });
  const res = mockRes();
  await handleHttp(req, res, mockServer());

  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res._headers["Access-Control-Allow-Headers"]);
  assert.ok(res._headers["Access-Control-Allow-Methods"]);
});
