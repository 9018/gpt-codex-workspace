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
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:12px;color:#17202a;background:transparent}
.card{border:1px solid #d8dee4;border-radius:8px;padding:14px;max-width:720px}.title{font-weight:650;font-size:16px;margin-bottom:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}.badge.queued{background:#f1f8ff;color:#0969da}
.badge.running{background:#fffbdd;color:#735c0f}.badge.completed{background:#dafbe1;color:#1a7f37}
.badge.failed,.badge.error{background:#ffebe9;color:#cf222e}.badge.waiting_for_review{background:#f3e8ff;color:#8250df}
.badge.cancelled,.badge.skipped{background:#f6f8fa;color:#656d76}.summary{margin:8px 0;font-size:14px;color:#24292f}
.kv-table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}.kv-table td{padding:3px 8px;vertical-align:top}
.kv-table td:first-child{color:#57606a;white-space:nowrap;width:30%}.kv-table tr:nth-child(odd){background:#f6f8fa}
.item-list{margin:8px 0;padding:0;list-style:none}.item-list li{padding:4px 8px;font-size:13px;border-left:3px solid #d0d7de;margin-bottom:4px;background:#f6f8fa}
.errors{margin:8px 0;padding:8px;background:#fff0f0;border:1px solid #ffc0c0;border-radius:6px;font-size:13px;color:#cf222e}
.muted{color:#57606a;font-size:13px;margin-bottom:8px}
pre.json{white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:6px;padding:8px;overflow:auto;max-height:300px}
@media(prefers-color-scheme:dark){body{color:#e6edf3;background:transparent}.card{border-color:#30363d}
.badge.queued{background:#0c2d6b;color:#58a6ff}.badge.running{background:#3d2e00;color:#d29922}
.badge.completed{background:#0b5e1a;color:#3fb950}.badge.failed,.badge.error{background:#490202;color:#ff7b72}
.badge.waiting_for_review{background:#3d1e6b;color:#bc8cff}.badge.cancelled,.badge.skipped{background:#21262d;color:#8b949e}
.kv-table tr:nth-child(odd){background:#161b22}.item-list li{background:#161b22;border-left-color:#30363d}
pre.json{background:#161b22}.errors{background:#3d0b0b;border-color:#792e2e;color:#ff7b72}}
</style></head><body><div class="card" id="root"><div class="title">GPTWork</div><div class="muted">Loading...</div></div><script>
const d = window.openai?.toolOutput || window.openai?.structuredContent || {};
const e = document.getElementById('root');
const h = [];
const title = d.title || d.summary || d.name || 'GPTWork Result';
h.push('<div class="title">' + title.replace(/</g,'&lt;') + '</div>');
if (d.status) {
  const s = String(d.status).toLowerCase().replace(/\s+/g,'_');
  h.push('<span class="badge ' + s + '">' + d.status.replace(/</g,'&lt;') + '</span>');
}
if (d.summary && d.summary !== title) {
  h.push('<div class="summary">' + d.summary.replace(/</g,'&lt;') + '</div>');
}
if (d.key_values) {
  h.push('<table class="kv-table">');
  for (const [k,v] of Object.entries(d.key_values)) {
    h.push('<tr><td>' + k.replace(/</g,'&lt;') + '</td><td>' + String(v).replace(/</g,'&lt;') + '</td></tr>');
  }
  h.push('</table>');
}
if (d.list && Array.isArray(d.list)) {
  h.push('<ul class="item-list">');
  for (const item of d.list) {
    h.push('<li>' + String(item).replace(/</g,'&lt;') + '</li>');
  }
  h.push('</ul>');
}
if (d.errors && Array.isArray(d.errors) && d.errors.length) {
  h.push('<div class="errors">' + d.errors.map(function(e){return String(e).replace(/</g,'&lt;')}).join('<br>') + '</div>');
}
if (d.changed_files && Array.isArray(d.changed_files)) {
  h.push('<div class="muted" style="margin-top:6px">Changed files: ' + d.changed_files.length + '</div>');
  h.push('<ul class="item-list">');
  for (const f of d.changed_files) {
    h.push('<li>' + (f.path || String(f)).replace(/</g,'&lt;') + '</li>');
  }
  h.push('</ul>');
}
if (d.metadata) {
  h.push('<pre class="json">' + JSON.stringify(d.metadata, null, 2).replace(/</g,'&lt;') + '</pre>');
}
if (!d.status && !d.summary && !d.key_values && !d.list && !d.changed_files && !d.metadata && !d.errors) {
  h.push('<pre class="json">' + JSON.stringify(d, null, 2).replace(/</g,'&lt;') + '</pre>');
}
e.innerHTML = h.join('');
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
