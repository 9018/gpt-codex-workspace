#!/usr/bin/env node
import { appendFileSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { createGptWorkServer } from "./gptwork-server.mjs";
import { startCodexWorker } from "./gptwork-server.mjs";

// Force unbuffered stdout/stderr 
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
if (process.stderr._handle) process.stderr._handle.setBlocking(true);

const PID_FILE = "/tmp/gptwork-mcp.pid";
const LOG = process.env.GPTWORK_LOG_PATH || "";
function w(msg) {
  if (LOG) appendFileSync(LOG, msg);
  try { process.stdout.write(msg); } catch {}
}

// Step 1: Kill any zombie holding our port
const PORT = Number(process.env.GPTWORK_PORT || 8787);
try { execSync(`lsof -ti :${PORT} 2>/dev/null | xargs kill -9 2>/dev/null`); } catch {}

// Step 2: PID file lock
try {
  const oldPid = parseInt(readFileSync(PID_FILE, "utf8").trim());
  try { process.kill(oldPid, 0); w(`[gptwork] PID ${oldPid} already running, exiting.\n`); process.exit(0); } catch {}
} catch {}
writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const host = process.env.GPTWORK_HOST || "127.0.0.1";
const server = await createGptWorkServer();
await server.listen({ host, port: PORT });

if (process.env.GPTWORK_CODEX_WORKER === "true") {
  startCodexWorker(server);
  w("GPTWork safe Codex worker enabled\n");
}
w(`GPTWork MCP listening on http://${host}:${PORT}/mcp\n`);
