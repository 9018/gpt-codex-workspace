import test from "node:test";
import assert from "node:assert/strict";

import { planContextBudget } from "../src/context-index/context-budget-planner.mjs";

test("planContextBudget prioritizes target symbols, direct dependencies, tests, and recent changes", () => {
  const codeMap = {
    files: {
      "src/service.mjs": {
        line_count: 400,
        imports: ["./helper.mjs"],
        exports: ["runService"],
        test_files: ["test/service.test.mjs"],
        symbols: [{ name: "runService", start_line: 120, end_line: 160 }],
      },
      "src/helper.mjs": { line_count: 80, imports: [], exports: ["helper"], test_files: [] },
      "test/service.test.mjs": { line_count: 220, imports: ["../src/service.mjs"], exports: [], test_files: [] },
      "src/unrelated.mjs": { line_count: 900, imports: [], exports: ["unrelated"], test_files: [] },
    },
  };

  const plan = planContextBudget({
    taskIntent: "Fix runService timeout in src/service.mjs",
    codeMap,
    recentChanges: ["src/helper.mjs"],
    maxBytes: 20_000,
  });

  assert.deepEqual(plan.must_read, [
    { path: "src/service.mjs", symbol: "runService", start_line: 120, end_line: 160, reason: "target_symbol" },
  ]);
  assert.ok(plan.should_read.some((entry) => entry.path === "src/helper.mjs" && entry.reason === "direct_dependency"));
  assert.ok(plan.should_read.some((entry) => entry.path === "test/service.test.mjs" && entry.reason === "related_test"));
  assert.ok(plan.optional.some((entry) => entry.path === "src/helper.mjs" && entry.reason === "recent_change"));
  assert.ok(plan.excluded.some((entry) => entry.path === "src/unrelated.mjs"));
  assert.ok(plan.estimated_size.bytes <= 20_000);
  assert.ok(plan.retrieval_queries.includes("runService references"));
});

test("planContextBudget keeps a deterministic hard budget and reports excluded candidates", () => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `src/file-${String(index).padStart(2, "0")}.mjs`,
    { line_count: 500, imports: [], exports: [`symbol${index}`], test_files: [] },
  ]));
  const input = { taskIntent: "inspect symbol1", codeMap: { files }, maxBytes: 2_000 };

  const first = planContextBudget(input);
  const second = planContextBudget(input);
  assert.deepEqual(first, second);
  assert.ok(first.estimated_size.bytes <= 2_000);
  assert.ok(first.excluded.length > 0);
});
