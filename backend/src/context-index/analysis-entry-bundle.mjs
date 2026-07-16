import { createHash } from "node:crypto";

import { planContextBudget } from "./context-budget-planner.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactText(value, maxChars = 180) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function hotFiles(codeMap, taskIntent, recentChanges) {
  const recent = new Set(recentChanges || []);
  return Object.entries(codeMap?.files || {})
    .map(([path, file]) => ({
      path,
      line_count: Number(file.line_count) || 0,
      responsibilities: compactText(file.responsibilities),
      score: (String(taskIntent).includes(path) ? 4 : 0) + (recent.has(path) ? 3 : 0) + Math.min(2, (Number(file.line_count) || 0) / 1000),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map(({ score, ...entry }) => entry);
}

function relevantSymbols(codeMap, taskIntent) {
  const intent = String(taskIntent || "").toLowerCase();
  return Object.entries(codeMap?.files || {})
    .flatMap(([path, file]) => (file.symbols || []).map((symbol) => ({ path, ...symbol })))
    .sort((a, b) => {
      const aMatch = intent.includes(String(a.name).toLowerCase()) ? 1 : 0;
      const bMatch = intent.includes(String(b.name).toLowerCase()) ? 1 : 0;
      return bMatch - aMatch || a.path.localeCompare(b.path) || a.start_line - b.start_line;
    })
    .slice(0, 12);
}

function architectureSummary(codeMap) {
  const files = Object.keys(codeMap?.files || {});
  const exports = Object.values(codeMap?.files || {}).reduce((sum, file) => sum + (file.exports?.length || 0), 0);
  return {
    directories: (codeMap?.directories || []).slice(0, 20),
    indexed_files: files.length,
    exported_symbols: exports,
    code_map_revision: codeMap?.revision || null,
  };
}

function trimToBudget(bundle, maxBytes) {
  const arrayKeys = ["relevant_symbols", "hot_files", "recent_changes", "recommended_queries"];
  while (byteLength(bundle) > maxBytes) {
    const key = arrayKeys
      .filter((candidate) => bundle[candidate]?.length > 0)
      .sort((a, b) => byteLength(bundle[b]) - byteLength(bundle[a]))[0];
    if (!key) break;
    bundle[key].pop();
    bundle.truncated = true;
  }
  if (byteLength(bundle) > maxBytes) {
    bundle.context_budget = {
      must_read: bundle.context_budget.must_read.slice(0, 1),
      should_read: [],
      optional: [],
      excluded: [],
      estimated_size: bundle.context_budget.estimated_size,
      retrieval_queries: [],
    };
    bundle.truncated = true;
  }
  if (byteLength(bundle) > maxBytes) {
    bundle.architecture_summary = { code_map_revision: bundle.architecture_summary.code_map_revision };
    bundle.current_blockers = { total: Number(bundle.current_blockers?.total) || 0 };
    bundle.truncated = true;
  }
  return bundle;
}

export function buildAnalysisEntryBundle({
  repo = {},
  currentBlockers = {},
  taskIntent = "",
  codeMap = {},
  recentChanges = [],
  maxBytes = 32_000,
  telemetry = null,
  catalogRevision = "",
} = {}) {
  const cap = Math.max(1_200, Math.floor(Number(maxBytes) || 32_000));
  const contextBudget = planContextBudget({ taskIntent, codeMap, recentChanges, maxBytes: Math.floor(cap * 0.6) });
  const symbols = relevantSymbols(codeMap, taskIntent);
  const bundle = {
    repo,
    current_blockers: currentBlockers,
    architecture_summary: architectureSummary(codeMap),
    hot_files: hotFiles(codeMap, taskIntent, recentChanges),
    recent_changes: [...recentChanges].slice(0, 20),
    relevant_symbols: symbols,
    recommended_queries: contextBudget.retrieval_queries.slice(0, 12),
    context_budget: contextBudget,
    cache_key: sha256([repo?.head || "", codeMap?.revision || "", catalogRevision, taskIntent].join("\0")),
    truncated: false,
  };

  trimToBudget(bundle, cap);
  const bytes = byteLength(bundle);
  telemetry?.record?.({
    bundleBytes: bytes,
    candidateTokens: Math.ceil(Object.keys(codeMap?.files || {}).length * 24),
    finalTokens: Math.ceil(bytes / 4),
    cacheHit: Boolean(codeMap?.cache_hit),
  });
  return bundle;
}
