import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyPath = join(__dirname, "..", "mcp", "server.mjs");

test("proxy forwards stdio JSON-RPC frames to an HTTP MCP endpoint", async () => {
  let observed = null;
  const remote = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
        contentType: req.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("mcp-session-id", "session-from-remote");
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: observed.body.id, result: { ok: true } })}\n\n`);
    });
  });

  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const { port } = remote.address();
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      GPTWORK_MCP_URL: `http://127.0.0.1:${port}/mcp/dev-token`,
      GPTWORK_API_TOKEN: "dev-token"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let output = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    output = Buffer.concat([output, chunk]);
  });

  const request = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  child.stdin.write(frame(request));

  const response = await readFrame(() => output);
  child.stdin.end();
  await once(child, "exit");
  await new Promise((resolve) => remote.close(resolve));

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.deepEqual(response.result, { ok: true });
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/mcp/dev-token");
  assert.equal(observed.authorization, "Bearer dev-token");
  assert.equal(observed.contentType, "application/json");
  assert.match(observed.accept, /text\/event-stream/);
  assert.equal(observed.body.method, "tools/list");
});

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

async function readFrame(getOutput) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const buffer = getOutput();
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(match, "response frame should include Content-Length");
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (buffer.length >= bodyEnd) {
        return JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for proxy response frame");
}
