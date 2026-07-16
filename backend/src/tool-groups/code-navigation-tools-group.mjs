import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { buildCodeSymbolIndex, findSymbolReferences, readSymbolRange } from "../context-index/code-symbol-index.mjs";

const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRECTORIES = new Set([".git", ".gptwork", "node_modules", "coverage", "dist", "build"]);

function repoRoot(config) {
  return resolve(config?.defaultRepoPath || config?.defaultWorkspaceRoot || process.cwd());
}

function safePath(root, path) {
  const value = String(path || "");
  const candidate = resolve(root, value);
  const rel = relative(root, candidate);
  if (isAbsolute(value) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path_outside_repository");
  }
  return { absolute: candidate, relative: rel.replaceAll(sep, "/") };
}

function readSource(root, path) {
  const resolved = safePath(root, path);
  return { ...resolved, source: readFileSync(resolved.absolute, "utf8") };
}

function clamp(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
}

function sourceFiles(root, maxFiles = 2_000) {
  const files = [];
  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(resolve(dir, entry.name));
      } else if (SOURCE_PATTERN.test(entry.name)) {
        files.push(relative(root, resolve(dir, entry.name)).replaceAll(sep, "/"));
      }
    }
  }
  walk(root);
  return files;
}

function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i.test(path);
}

function fileStem(path) {
  return path.split("/").pop().replace(/(?:\.test|\.spec)?\.[^.]+$/, "");
}

function readNamedSymbol(root, { path, symbol, max_lines }) {
  const file = readSource(root, path);
  const index = buildCodeSymbolIndex({ filePath: file.relative, source: file.source });
  const result = readSymbolRange({ index, source: file.source, symbolName: symbol, maxLines: clamp(max_lines, 200, 1, 1_000) });
  if (!result) throw new Error(`symbol_not_found:${symbol}`);
  return result;
}

export function createCodeNavigationToolsGroup({ tool, schema, config }) {
  const root = repoRoot(config);
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["code", "navigation", "read-only"] };
  return {
    read_symbol: tool({
      name: "read_symbol",
      description: "Read one named JavaScript or TypeScript symbol using a bounded line range.",
      inputSchema: schema({ path: "string", symbol: "string", max_lines: "integer" }, ["path", "symbol"]),
      ...common,
      handler: async (args) => readNamedSymbol(root, args),
    }),
    read_function: tool({
      name: "read_function",
      description: "Read one named JavaScript or TypeScript function using a bounded line range.",
      inputSchema: schema({ path: "string", function: "string", max_lines: "integer" }, ["path", "function"]),
      ...common,
      handler: async ({ path, function: functionName, max_lines }) => readNamedSymbol(root, { path, symbol: functionName, max_lines }),
    }),
    read_file_ranges: tool({
      name: "read_file_ranges",
      description: "Read selected 1-based line ranges from one text file under a shared hard line cap.",
      inputSchema: schema({ path: "string", ranges: "array", max_lines: "integer" }, ["path", "ranges"]),
      ...common,
      handler: async ({ path, ranges = [], max_lines }) => {
        const file = readSource(root, path);
        const lines = file.source.split("\n");
        let remaining = clamp(max_lines, 400, 1, 2_000);
        const output = [];
        for (const requested of Array.isArray(ranges) ? ranges.slice(0, 50) : []) {
          if (remaining <= 0) break;
          const start = clamp(requested?.start_line, 1, 1, Math.max(1, lines.length));
          const requestedEnd = clamp(requested?.end_line, start, start, Math.max(start, lines.length));
          const end = Math.min(requestedEnd, start + remaining - 1);
          const content = lines.slice(start - 1, end).join("\n");
          output.push({ start_line: start, end_line: end, content, truncated: end < requestedEnd });
          remaining -= end - start + 1;
        }
        return {
          path: file.relative,
          ranges: output,
          total_lines: output.reduce((sum, entry) => sum + entry.end_line - entry.start_line + 1, 0),
          truncated: remaining === 0 && output.length < ranges.length || output.some((entry) => entry.truncated),
        };
      },
    }),
    find_references: tool({
      name: "find_references",
      description: "Find bounded JavaScript or TypeScript symbol declarations and references across the repository.",
      inputSchema: schema({ symbol: "string", path: "string", limit: "integer" }, ["symbol"]),
      ...common,
      handler: async ({ symbol, path = ".", limit }) => {
        const scope = safePath(root, path);
        const cap = clamp(limit, 100, 1, 500);
        const files = sourceFiles(scope.absolute);
        const references = [];
        const pattern = new RegExp(`\\b${String(symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        for (const scopedPath of files) {
          if (references.length >= cap) break;
          const absolute = resolve(scope.absolute, scopedPath);
          const repoPath = relative(root, absolute).replaceAll(sep, "/");
          let source = "";
          try { source = readFileSync(absolute, "utf8"); } catch { continue; }
          const index = buildCodeSymbolIndex({ filePath: repoPath, source });
          const indexed = findSymbolReferences(index, symbol);
          if (indexed.length > 0) {
            for (const entry of indexed) references.push({ path: entry.file_path, line: entry.line, kind: entry.kind });
          } else {
            source.split("\n").forEach((line, lineIndex) => {
              if (references.length < cap && pattern.test(line.replace(/\/\/.*$/, ""))) {
                references.push({ path: repoPath, line: lineIndex + 1, kind: "reference" });
              }
            });
          }
        }
        return { symbol, references: references.slice(0, cap), count: Math.min(references.length, cap), truncated: references.length >= cap };
      },
    }),
    read_related_tests: tool({
      name: "read_related_tests",
      description: "Read bounded test files whose names map to a source file.",
      inputSchema: schema({ path: "string", max_lines: "integer", limit: "integer" }, ["path"]),
      ...common,
      handler: async ({ path, max_lines, limit }) => {
        const sourcePath = safePath(root, path).relative;
        const targetStem = fileStem(sourcePath);
        const cap = clamp(limit, 10, 1, 50);
        let remaining = clamp(max_lines, 400, 1, 2_000);
        const candidates = sourceFiles(root).filter((candidate) => isTestPath(candidate) && fileStem(candidate) === targetStem).slice(0, cap);
        const testFiles = [];
        for (const candidate of candidates) {
          if (remaining <= 0) break;
          const file = readSource(root, candidate);
          const lines = file.source.split("\n");
          const count = Math.min(lines.length, remaining);
          testFiles.push({ path: candidate, start_line: 1, end_line: count, truncated: count < lines.length, content: lines.slice(0, count).join("\n") });
          remaining -= count;
        }
        return { source_path: sourcePath, test_files: testFiles, count: testFiles.length, truncated: testFiles.length < candidates.length || testFiles.some((entry) => entry.truncated) };
      },
    }),
  };
}
