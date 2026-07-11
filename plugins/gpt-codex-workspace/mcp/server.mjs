#!/usr/bin/env node

import http from "node:http";
import https from "node:https";

const HTTP_TIMEOUT_MS = 60000;

const DEFAULT_ENDPOINT = "https://mcp.gptwork.cc.cd/mcp";
const endpoint = process.env.GPTWORK_MCP_URL || DEFAULT_ENDPOINT;
const token = process.env.GPTWORK_API_TOKEN || "";

let sessionId = null;
let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => {
  process.exit(0);
});

function drainInput() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      inputBuffer = Buffer.alloc(0);
      writeLog("Invalid MCP frame: missing Content-Length");
      return;
    }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) return;

    const raw = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);

    try {
      const message = JSON.parse(raw);
      handleMessage(message).catch((error) => {
        if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
          sendJsonRpcError(message.id, -32000, error.message);
        } else {
          writeLog(error.stack || error.message);
        }
      });
    } catch (error) {
      writeLog(`Invalid JSON-RPC message: ${error.message}`);
    }
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;

  const isRequest = Object.prototype.hasOwnProperty.call(message, "id");

  if (!token && !endpointHasPathToken(endpoint) && message.method !== "initialize") {
    if (isRequest) {
      sendJsonRpcError(
        message.id,
        -32001,
        "GPTWORK_API_TOKEN is required unless GPTWORK_MCP_URL includes a token path."
      );
    }
    return;
  }

  const response = await forwardToRemote(message);
  if (isRequest) {
    if (response) {
      writeFrame(response);
    } else {
      sendJsonRpcError(message.id, -32000, "Remote MCP server did not return a result response to the request");
    }
  }
}

async function forwardToRemote(payload) {
  const body = JSON.stringify(payload);
  const url = new URL(endpoint);

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Accept: "application/json, text/event-stream"
  };

  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const result = await request(url, body, headers);

  const nextSession = result.headers["mcp-session-id"];
  if (nextSession) sessionId = Array.isArray(nextSession) ? nextSession[0] : nextSession;

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`Remote MCP returned HTTP ${result.statusCode}: ${result.body.slice(0, 500)}`);
  }

  const { response, pendingFrames } = parseRemoteResponse(result.body);

  // Forward intermediate notification frames (no "id") to the client
  // BEFORE the final result frame so ordering is predictable.
  for (const frame of pendingFrames) {
    writeFrame(frame);
  }

  return response;
}

function request(url, body, headers) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "http:" ? http : https;
    const port = url.port || (url.protocol === "http:" ? 80 : 443);
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`HTTP request to ${url.hostname} timed out after ${HTTP_TIMEOUT_MS}ms`));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse the remote HTTP response body and return:
 *   { response: object|null, pendingFrames: object[] }
 *
 * pendingFrames holds intermediate SSE messages that have no "id"
 * (e.g. progress notifications). The caller must forward these first.
 */
function parseRemoteResponse(body) {
  const trimmed = body.trim();
  if (!trimmed) return { response: null, pendingFrames: [] };

  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const pendingFrames = [];
    let finalResponse = null;
    for (const line of dataLines) {
      if (!line || line === "[DONE]") continue;
      try {
        const message = JSON.parse(line);
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          pendingFrames.push(message);
          continue;
        }
        finalResponse = message;
      } catch (e) {
        writeLog(`SSE data line parse error: ${e.message} — line: ${line.slice(0, 120)}`);
      }
    }

    return { response: finalResponse, pendingFrames };
  }

  // Non-SSE JSON-RPC response (application/json)
  return { response: JSON.parse(trimmed), pendingFrames: [] };
}

function endpointHasPathToken(value) {
  try {
    return /^\/mcp\/[^/]+\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function writeFrame(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendJsonRpcError(id, code, message) {
  writeFrame({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}

function writeLog(message) {
  process.stderr.write(`[gptwork-mcp-proxy] ${message}\n`);
}
