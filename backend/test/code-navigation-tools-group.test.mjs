import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeNavigationToolsGroup } from "../src/tool-groups/code-navigation-tools-group.mjs";

function fakeTool(descriptor) {
  return {
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    handler: descriptor.handler,
    metadata: {
      name: descriptor.name,
      modes: descriptor.modes || [],
      audience: descriptor.audience || [],
      tags: descriptor.tags || [],
    },
  };
}

function fakeSchema(properties = {}, required = []) {
  return { type: "object", properties, required };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gptwork-code-nav-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "service.mjs"), [
    "export function runService(value) {",
    "  const normalized = value.trim();",
    "  return normalized.toUpperCase();",
    "}",
    "",
    "export function callService() {",
    "  return runService('x');",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "test", "service.test.mjs"), [
    'import { runService } from "../src/service.mjs";',
    "runService(' value ');",
  ].join("\n"));
  return root;
}

test("code navigation tools return bounded symbol, function, range, reference, and test results", async () => {
  const root = fixture();
  try {
    const tools = createCodeNavigationToolsGroup({
      tool: fakeTool,
      schema: fakeSchema,
      config: { defaultRepoPath: root },
    });
    assert.deepEqual(Object.keys(tools).sort(), [
      "find_references",
      "read_file_ranges",
      "read_function",
      "read_related_tests",
      "read_symbol",
    ]);

    const symbol = await tools.read_symbol.handler({ path: "src/service.mjs", symbol: "runService", max_lines: 3 });
    assert.equal(symbol.start_line, 1);
    assert.equal(symbol.end_line, 3);
    assert.equal(symbol.truncated, true);
    assert.equal(symbol.content.split("\n").length, 3);

    const fn = await tools.read_function.handler({ path: "src/service.mjs", function: "callService" });
    assert.equal(fn.symbol, "callService");
    assert.equal(fn.start_line, 6);

    const ranges = await tools.read_file_ranges.handler({
      path: "src/service.mjs",
      ranges: [{ start_line: 2, end_line: 4 }, { start_line: 6, end_line: 8 }],
      max_lines: 4,
    });
    assert.equal(ranges.total_lines, 4);
    assert.equal(ranges.truncated, true);
    assert.deepEqual(ranges.ranges.map((entry) => [entry.start_line, entry.end_line]), [[2, 4], [6, 6]]);

    const references = await tools.find_references.handler({ symbol: "runService", limit: 10 });
    assert.ok(references.references.some((entry) => entry.path === "src/service.mjs" && entry.line === 7));
    assert.ok(references.references.some((entry) => entry.path === "test/service.test.mjs" && entry.line === 2));

    const tests = await tools.read_related_tests.handler({ path: "src/service.mjs", max_lines: 10 });
    assert.deepEqual(tests.test_files.map((entry) => entry.path), ["test/service.test.mjs"]);
    assert.equal(tests.test_files[0].content.split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("code navigation tools reject paths outside the configured repository", async () => {
  const root = fixture();
  try {
    const tools = createCodeNavigationToolsGroup({ tool: fakeTool, schema: fakeSchema, config: { defaultRepoPath: root } });
    await assert.rejects(
      () => tools.read_symbol.handler({ path: "../outside.mjs", symbol: "runService" }),
      /path_outside_repository/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
