import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyPath = join(__dirname, "..", "mcp", "server.mjs");

const NOTIFICATION = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "progress 50%" } };
const FINAL_RESPONSE = { jsonrpc: "2.0", id: 1, result: { ok: true } };

test("proxy forwards SSE notifications and returns final response with id", async () => {
  // Fake SSE server: sends notification first, then final response
  const remote = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`event: message\ndata: ${JSON.stringify(NOTIFICATION)}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify(FINAL_RESPONSE)}\n\n`);
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

  // Wait until we have 2 frames (notification + final response)
  const parsed = await waitForFrames(() => output, 2, 5000);
  child.stdin.end();
  await once(child, "exit");
  await new Promise((resolve) => remote.close(resolve));

  // We expect exactly two frames: notification then final response
  assert.equal(parsed.length, 2, "should see 2 frames: notification + response");

  // First frame should be the notification (no id)
  assert.equal(parsed[0].method, "notifications/message");
  assert.equal(parsed[0].params.level, "info");

  // Second frame should be the final response with the correct id
  assert.equal(parsed[1].jsonrpc, "2.0");
  assert.equal(parsed[1].id, 1);
  assert.deepEqual(parsed[1].result, { ok: true });
});

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function parseAllFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd === -1) break;
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) break;
    frames.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
    offset = bodyEnd;
  }
  return frames;
}

async function waitForFrames(getOutput, expected, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const buffer = getOutput();
    const parsed = parseAllFrames(buffer);
    if (parsed.length >= expected) return parsed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Return what we have even if timeout
  return parseAllFrames(getOutput());
}
