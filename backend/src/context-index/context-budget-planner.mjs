import { dirname, normalize, posix } from "node:path";

function estimateEntryBytes(file, symbol = null) {
  const lines = symbol
    ? Math.max(1, Number(symbol.end_line) - Number(symbol.start_line) + 1)
    : Math.min(120, Math.max(1, Number(file?.line_count) || 1));
  return lines * 48;
}

function normalizeImport(fromPath, specifier) {
  if (!specifier?.startsWith(".")) return null;
  const joined = normalize(posix.join(dirname(fromPath), specifier)).replaceAll("\\", "/");
  return joined.match(/\.[cm]?[jt]sx?$/) ? joined : `${joined}.mjs`;
}

function intentMatches(intent, value) {
  if (!value) return false;
  return intent.toLowerCase().includes(String(value).toLowerCase());
}

function addUnique(list, entry) {
  if (!list.some((current) => current.path === entry.path && current.reason === entry.reason && current.symbol === entry.symbol)) {
    list.push(entry);
  }
}

export function planContextBudget({ taskIntent = "", codeMap = {}, recentChanges = [], maxBytes = 48_000 } = {}) {
  const files = codeMap?.files || {};
  const paths = Object.keys(files).sort();
  const cap = Math.max(512, Math.floor(Number(maxBytes) || 48_000));
  const mustRead = [];
  const shouldRead = [];
  const optional = [];
  const represented = new Set();
  let used = 0;

  for (const path of paths) {
    const file = files[path] || {};
    const matchedSymbol = (file.symbols || []).find((symbol) => intentMatches(taskIntent, symbol.name));
    if (!intentMatches(taskIntent, path) && !matchedSymbol) continue;
    const symbol = matchedSymbol || null;
    const entry = symbol
      ? { path, symbol: symbol.name, start_line: symbol.start_line, end_line: symbol.end_line, reason: "target_symbol" }
      : { path, reason: "target_file" };
    const cost = estimateEntryBytes(file, symbol);
    if (used + cost <= cap) {
      addUnique(mustRead, entry);
      represented.add(path);
      used += cost;
    }
  }

  for (const target of [...mustRead]) {
    const file = files[target.path] || {};
    for (const specifier of file.imports || []) {
      const resolved = normalizeImport(target.path, specifier);
      if (!resolved || !files[resolved]) continue;
      const cost = estimateEntryBytes(files[resolved]);
      if (used + cost <= cap) {
        addUnique(shouldRead, { path: resolved, reason: "direct_dependency" });
        represented.add(resolved);
        used += cost;
      }
    }
    for (const testPath of file.test_files || []) {
      if (!files[testPath]) continue;
      const cost = estimateEntryBytes(files[testPath]);
      if (used + cost <= cap) {
        addUnique(shouldRead, { path: testPath, reason: "related_test" });
        represented.add(testPath);
        used += cost;
      }
    }
  }

  for (const path of [...recentChanges].filter((value) => files[value]).sort()) {
    const cost = Math.min(estimateEntryBytes(files[path]), 4_000);
    if (used + cost <= cap) {
      addUnique(optional, { path, reason: "recent_change" });
      used += cost;
    }
  }

  const excluded = paths
    .filter((path) => !represented.has(path) && !optional.some((entry) => entry.path === path))
    .map((path) => ({ path, reason: "outside_budget_or_intent" }));
  const symbolQueries = mustRead.filter((entry) => entry.symbol).map((entry) => `${entry.symbol} references`);
  const retrievalQueries = [...new Set([
    ...symbolQueries,
    ...mustRead.map((entry) => `${entry.path} dependencies`),
    String(taskIntent || "").trim(),
  ].filter(Boolean))];

  return {
    must_read: mustRead,
    should_read: shouldRead,
    optional,
    excluded,
    estimated_size: { bytes: Math.min(used, cap), max_bytes: cap },
    retrieval_queries: retrievalQueries,
  };
}
