import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodeSymbolIndex,
  findSymbolReferences,
  readSymbolRange,
} from "../src/context-index/code-symbol-index.mjs";

const SOURCE = [
  'import { readFile } from "node:fs/promises";',
  'import helper from "./helper.mjs";',
  "",
  "export const LIMIT = 5;",
  "",
  "export async function loadConfig(path) {",
  '  const content = await readFile(path, "utf8");',
  "  return helper(content, LIMIT);",
  "}",
  "",
  "class InternalRunner {",
  "  run(value) {",
  "    return loadConfig(value);",
  "  }",
  "}",
  "",
  "export { InternalRunner as Runner };",
].join("\n");

test("buildCodeSymbolIndex records imports, exports, declarations, and references with 1-based lines", () => {
  const index = buildCodeSymbolIndex({ filePath: "src/config.mjs", source: SOURCE });

  assert.equal(index.file_path, "src/config.mjs");
  assert.deepEqual(index.imports, [
    { source: "node:fs/promises", names: ["readFile"], line: 1 },
    { source: "./helper.mjs", names: ["helper"], line: 2 },
  ]);
  assert.deepEqual(index.exports, ["InternalRunner", "LIMIT", "Runner", "loadConfig"]);

  const loadConfig = index.symbols.find((symbol) => symbol.name === "loadConfig");
  assert.deepEqual(loadConfig, {
    name: "loadConfig",
    kind: "function",
    exported: true,
    start_line: 6,
    end_line: 9,
  });

  const runner = index.symbols.find((symbol) => symbol.name === "InternalRunner");
  assert.equal(runner.kind, "class");
  assert.equal(runner.start_line, 11);
  assert.equal(runner.end_line, 15);

  assert.deepEqual(findSymbolReferences(index, "loadConfig"), [
    { file_path: "src/config.mjs", line: 6, kind: "declaration" },
    { file_path: "src/config.mjs", line: 13, kind: "reference" },
  ]);
});

test("readSymbolRange returns only the requested symbol and enforces a hard line cap", () => {
  const index = buildCodeSymbolIndex({ filePath: "src/config.mjs", source: SOURCE });

  assert.deepEqual(readSymbolRange({ index, source: SOURCE, symbolName: "loadConfig", maxLines: 20 }), {
    file_path: "src/config.mjs",
    symbol: "loadConfig",
    start_line: 6,
    end_line: 9,
    truncated: false,
    content: [
      "export async function loadConfig(path) {",
      '  const content = await readFile(path, "utf8");',
      "  return helper(content, LIMIT);",
      "}",
    ].join("\n"),
  });

  const bounded = readSymbolRange({ index, source: SOURCE, symbolName: "InternalRunner", maxLines: 3 });
  assert.equal(bounded.start_line, 11);
  assert.equal(bounded.end_line, 13);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.content.split("\n").length, 3);
});

test("buildCodeSymbolIndex handles arrow exports and does not treat comments as references", () => {
  const source = [
    "export const normalize = (value) => value.trim();",
    "// normalize should not count here",
    "const result = normalize(' value ');",
  ].join("\n");
  const index = buildCodeSymbolIndex({ filePath: "src/normalize.js", source });

  assert.deepEqual(index.symbols[0], {
    name: "normalize",
    kind: "function",
    exported: true,
    start_line: 1,
    end_line: 1,
  });
  assert.deepEqual(findSymbolReferences(index, "normalize"), [
    { file_path: "src/normalize.js", line: 1, kind: "declaration" },
    { file_path: "src/normalize.js", line: 3, kind: "reference" },
  ]);
});
