import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { buildCodeSymbolIndex } from "./code-symbol-index.mjs";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function extension(path) {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1]?.toLowerCase() || "";
}

function trackedFiles(repoRoot) {
  const output = git(repoRoot, ["ls-files", "-z"]);
  if (!output) return [];
  return output.split("\0").filter(Boolean).filter((path) => SOURCE_EXTENSIONS.has(extension(path))).sort();
}

function importSources(symbolIndex) {
  return [...new Set(symbolIndex.imports.map((entry) => entry.source))].sort();
}

function responsibilities(path, symbolIndex) {
  const exported = symbolIndex.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name);
  if (exported.length > 0) return `Exports ${exported.slice(0, 8).join(", ")}`;
  return `Module ${path}`;
}

function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i.test(path);
}

function stem(path) {
  return path.split("/").pop().replace(/(?:\.test|\.spec)?\.[^.]+$/, "");
}

function mapTests(files) {
  const tests = files.filter(isTestPath);
  const mapping = new Map();
  for (const path of files) {
    if (isTestPath(path)) continue;
    const pathStem = stem(path);
    mapping.set(path, tests.filter((testPath) => stem(testPath) === pathStem).sort());
  }
  return mapping;
}

function canonicalPayload({ gitHead, directories, files }) {
  const base = { schema_version: 1, git_head: gitHead || null, directories, files };
  return { ...base, revision: sha256(JSON.stringify(base)) };
}

export function buildProjectCodeMap({ repoRoot, cachePath } = {}) {
  const root = resolve(repoRoot || process.cwd());
  const outputPath = cachePath || join(root, ".gptwork", "context-index", "code-map.json");
  const previous = readJson(outputPath);
  const paths = trackedFiles(root);
  const testMapping = mapTests(paths);
  const files = {};
  const refreshed = [];

  for (const path of paths) {
    let source;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const digest = sha256(source);
    const cached = previous?.files?.[path];
    if (cached?.content_digest === digest) {
      files[path] = cached;
      continue;
    }

    const index = buildCodeSymbolIndex({ filePath: path, source });
    files[path] = {
      line_count: index.line_count,
      exports: index.exports,
      imports: importSources(index),
      responsibilities: responsibilities(path, index),
      test_files: isTestPath(path) ? [] : (testMapping.get(path) || []),
      content_digest: digest,
      symbols: index.symbols,
    };
    refreshed.push(path);
  }

  const directories = [...new Set(paths.map((path) => dirname(path)).filter((path) => path !== "."))].sort();
  const payload = canonicalPayload({
    gitHead: git(root, ["rev-parse", "HEAD"]),
    directories,
    files,
  });
  const cacheHit = Boolean(previous?.revision === payload.revision && refreshed.length === 0);
  if (!cacheHit) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return {
    ...payload,
    cache_hit: cacheHit,
    refreshed_files: refreshed,
    cache_path: relative(root, outputPath) || outputPath,
  };
}
