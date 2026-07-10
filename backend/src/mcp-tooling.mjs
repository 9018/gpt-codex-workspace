/**
 * mcp-tooling.mjs — HTTP/MCP protocol helpers
 *
 * Pure functions for MCP JSON-RPC, SSE transport, and HTTP utilities.
 * No coupling to gptwork-server internals.
 */
import { createHash } from "node:crypto";
import {
  canReadToolCardResource,
  readToolCardResource,
  resourceList as appsSdkCardResourceList,
} from "./apps-sdk-card/card-resource.mjs";
import { isToolCardEnabled, isWidgetResourceEnabled, toolCardMeta, toolCardResourceMeta } from "./apps-sdk-card/card-meta.mjs";
import { shapeToolResult, tagToolResult, toolResultMeta } from "./apps-sdk-card/tool-result.mjs";
export {
  GPTWORK_TOOL_CARD_URI,
  GPTWORK_LEGACY_CARD_V1_URI,
  GPTWORK_LEGACY_CARD_V2_URI,
  GPTWORK_LEGACY_TOOL_CARD_V1_URI,
  GPTWORK_TOOL_CARD_MIME_TYPE,
  GPTWORK_WIDGET_DOMAIN,
  normalizeToolCardUri,
} from "./apps-sdk-card/constants.mjs";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export { shapeToolResult, toolCardMeta, toolCardResourceMeta, tagToolResult, toolResultMeta };

export function schema(properties, required = []) {
  const mapped = {};
  for (const [key, descriptor] of Object.entries(properties)) {
    if (typeof descriptor === "string") mapped[key] = { type: descriptor };
    else if (descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)) mapped[key] = { ...descriptor };
    else mapped[key] = { type: "string" };
  }
  return { type: "object", properties: mapped, required, additionalProperties: false };
}

export function toolList(tools, renderMode = "card") {
  return Object.entries(tools).map(([name, value]) => {
    const descriptor = {
      name,
      description: value.description,
      inputSchema: value.inputSchema,
      outputSchema: { type: "object", additionalProperties: true }
    };
    if (isToolCardEnabled({ renderMode, toolName: name, metadata: value.metadata })) {
      descriptor._meta = toolCardMeta();
    }
    return descriptor;
  });
}

export function resourceList(renderMode = "card") {
  return isWidgetResourceEnabled(renderMode) ? appsSdkCardResourceList() : [];
}

export function readResource(uri, renderMode = "card") {
  if (!isWidgetResourceEnabled(renderMode)) return null;
  if (uri === "ui://widget/gptwork-card-v1.html") {
    return {
      uri,
      mimeType: "text/html",
      text: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:12px;color:#17202a;background:transparent}
.card{border:1px solid #d8dee4;border-radius:8px;padding:14px;max-width:720px}.card-section{margin-top:10px}.card-section:first-child{margin-top:0}
.title{font-weight:650;font-size:16px;margin-bottom:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}.badge.queued{background:#f1f8ff;color:#0969da}
.badge.running{background:#fffbdd;color:#735c0f}.badge.completed{background:#dafbe1;color:#1a7f37}
.badge.failed,.badge.error{background:#ffebe9;color:#cf222e}.badge.waiting_for_review{background:#f3e8ff;color:#8250df}
.badge.cancelled,.badge.skipped{background:#f6f8fa;color:#656d76}.badge.in_progress{background:#fffbdd;color:#735c0f}
.summary{margin:8px 0;font-size:14px;color:#24292f}
.kv-table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}.kv-table td{padding:3px 8px;vertical-align:top}
.kv-table td:first-child{color:#57606a;white-space:nowrap;width:30%}.kv-table tr:nth-child(odd){background:#f6f8fa}
.item-list{margin:8px 0;padding:0;list-style:none}.item-list li{padding:4px 8px;font-size:13px;border-left:3px solid #d0d7de;margin-bottom:4px;background:#f6f8fa}
.errors{margin:8px 0;padding:8px;background:#fff0f0;border:1px solid #ffc0c0;border-radius:6px;font-size:13px;color:#cf222e}
.warnings{margin:8px 0;padding:8px;background:#fff8e0;border:1px solid #e0c040;border-radius:6px;font-size:13px;color:#8a6d00}
.muted{color:#57606a;font-size:13px;margin-bottom:8px}
.fold-toggle{background:none;border:1px solid #d0d7de;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;color:#57606a;margin-top:6px}
.fold-toggle:hover{background:#f6f8fa}
pre.json{white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:6px;padding:8px;overflow:auto;max-height:300px;margin-top:4px}
pre.json.collapsed{display:none}
@media(prefers-color-scheme:dark){body{color:#e6edf3;background:transparent}.card{border-color:#30363d}
.badge.queued{background:#0c2d6b;color:#58a6ff}.badge.running{background:#3d2e00;color:#d29922}
.badge.completed{background:#0b5e1a;color:#3fb950}.badge.failed,.badge.error{background:#490202;color:#ff7b72}
.badge.waiting_for_review{background:#3d1e6b;color:#bc8cff}.badge.cancelled,.badge.skipped{background:#21262d;color:#8b949e}
.badge.in_progress{background:#3d2e00;color:#d29922}
.kv-table tr:nth-child(odd){background:#161b22}.item-list li{background:#161b22;border-left-color:#30363d}
pre.json{background:#161b22}.errors{background:#3d0b0b;border-color:#792e2e;color:#ff7b72}
.warnings{background:#3d2e00;border-color:#705000;color:#d29922}
.fold-toggle{border-color:#30363d;color:#8b949e}.fold-toggle:hover{background:#21262d}}
</style></head><body><div class="card" id="root"><div class="title">GPTWork</div><div class="muted">Loading...</div></div><script>
(function(){
var d = window.openai && (window.openai.toolOutput || window.openai.structuredContent) || {};
var e = document.getElementById('root');
function esc(s){return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function renderCard(data){
  var parts=[];
  var title = data.title || data.summary || data.name || 'GPTWork Result';
  parts.push('<div class="card-section"><div class="title">'+esc(title)+'</div>');
  if(data.status){
    var s=String(data.status).toLowerCase().replace(/\s+/g,'_');
    parts.push('<span class="badge '+s+'">'+esc(data.status)+'</span>');
  }
  if(data.summary&&data.summary!==title){
    parts.push('<div class="summary">'+esc(data.summary)+'</div>');
  }
  parts.push('</div>');
  var kv = data.keyValues || data.key_values || null;
  if(kv){
    parts.push('<div class="card-section"><table class="kv-table">');
    if(Array.isArray(kv)){
      for(var i=0;i<kv.length;i++){
        parts.push('<tr><td>'+esc(kv[i].key||kv[i].k||'')+'</td><td>'+esc(kv[i].value||kv[i].v||'')+'</td></tr>');
      }
    } else if(typeof kv==='object'){
      for(var k in kv){
        if(Object.prototype.hasOwnProperty.call(kv,k)){
          parts.push('<tr><td>'+esc(k)+'</td><td>'+esc(String(kv[k]))+'</td></tr>');
        }
      }
    }
    parts.push('</table></div>');
  }
  var items = data.items || data.list || null;
  if(items&&Array.isArray(items)&&items.length){
    parts.push('<div class="card-section"><ul class="item-list">');
    for(var i=0;i<items.length;i++){
      parts.push('<li>'+esc(String(items[i]))+'</li>');
    }
    parts.push('</ul></div>');
  }
  if(data.changed_files&&Array.isArray(data.changed_files)){
    parts.push('<div class="card-section"><div class="muted">Changed files: '+data.changed_files.length+'</div>');
    parts.push('<ul class="item-list">');
    for(var i=0;i<data.changed_files.length;i++){
      var f=data.changed_files[i];
      parts.push('<li>'+esc(f.path||String(f))+'</li>');
    }
    parts.push('</ul></div>');
  }
  if(data.staged!=null||data.unstaged!=null||data.total_changes!=null){
    parts.push('<div class="card-section"><table class="kv-table">');
    if(data.staged!=null) parts.push('<tr><td>Staged</td><td>'+esc(String(data.staged))+'</td></tr>');
    if(data.unstaged!=null) parts.push('<tr><td>Unstaged</td><td>'+esc(String(data.unstaged))+'</td></tr>');
    if(data.total_changes!=null) parts.push('<tr><td>Total changes</td><td>'+esc(String(data.total_changes))+'</td></tr>');
    parts.push('</table></div>');
  }
  if(data.warnings&&Array.isArray(data.warnings)&&data.warnings.length){
    parts.push('<div class="card-section"><div class="warnings">'+data.warnings.map(function(w){return esc(String(w))}).join('<br>')+'</div></div>');
  }
  if(data.errors&&Array.isArray(data.errors)&&data.errors.length){
    parts.push('<div class="card-section"><div class="errors">'+data.errors.map(function(e){return esc(String(e))}).join('<br>')+'</div></div>');
  }
  var hasContent = data.status||data.summary||kv||(items&&items.length)||data.changed_files||data.errors||data.warnings||data.staged!=null;
  if(!hasContent){
    parts.push('<pre class="json">'+esc(JSON.stringify(data,null,2))+'</pre>');
  } else {
    var jsonStr = JSON.stringify(data,null,2);
    parts.push('<div class="card-section"><button class="fold-toggle" onclick="(function(b){var p=b.nextElementSibling;if(p){p.classList.toggle(\'collapsed\');b.textContent=p.classList.contains(\'collapsed\')?\'Show raw JSON\':\'Hide raw JSON\'}})(this)">Show raw JSON</button>');
    parts.push('<pre class="json collapsed">'+esc(jsonStr)+'</pre></div>');
  }
  return parts.join('');
}
e.innerHTML = renderCard(d);
})();
</script></body></html>`
    };
  }

 if (canReadToolCardResource(uri)) return readToolCardResource(uri);

  return null;
}

export function initializeResult(renderMode = "card") {
  const capabilities = {
    experimental: {},
    logging: {},
    prompts: { listChanged: true },
    resources: { subscribe: false, listChanged: true },
    tools: { listChanged: true },
  };
  if (isWidgetResourceEnabled(renderMode)) {
    capabilities.extensions = { "io.modelcontextprotocol/ui": {} };
  }
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities,
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
