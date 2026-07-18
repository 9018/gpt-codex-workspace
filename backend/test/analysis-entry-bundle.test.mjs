import test from "node:test";
import assert from "node:assert/strict";

import { buildAnalysisEntryBundle } from "../src/context-index/analysis-entry-bundle.mjs";
import { createContextTelemetry } from "../src/context-index/context-telemetry.mjs";

test("buildAnalysisEntryBundle returns the canonical compact entry shape under a hard byte cap", () => {
  const codeMap = {
    revision: "map-rev",
    directories: ["src", "test"],
    files: {
      "src/service.mjs": {
        line_count: 1500,
        exports: ["runService"],
        imports: ["./helper.mjs"],
        responsibilities: "Runs service orchestration ".repeat(100),
        test_files: ["test/service.test.mjs"],
        symbols: [{ name: "runService", kind: "function", start_line: 100, end_line: 180 }],
      },
      "test/service.test.mjs": {
        line_count: 400,
        exports: [],
        imports: ["../src/service.mjs"],
        responsibilities: "Tests service orchestration",
        test_files: [],
        symbols: [],
      },
    },
  };
  const telemetry = createContextTelemetry();
  const bundle = buildAnalysisEntryBundle({
    repo: { root: "/repo", branch: "main", head: "abc123", dirty: true },
    currentBlockers: { waiting_for_repair: 2, total: 2 },
    taskIntent: "repair runService",
    codeMap,
    recentChanges: ["src/service.mjs"],
    maxBytes: 2_400,
    telemetry,
  });

  assert.deepEqual(Object.keys(bundle), [
    "repo",
    "current_blockers",
    "architecture_summary",
    "hot_files",
    "recent_changes",
    "relevant_symbols",
    "recommended_queries",
    "context_budget",
    "cache_key",
    "truncated",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle), "utf8") <= 2_400);
  assert.equal(bundle.hot_files[0].path, "src/service.mjs");
  assert.equal(bundle.relevant_symbols[0].name, "runService");
  assert.match(bundle.cache_key, /^[a-f0-9]{64}$/);
  assert.equal(telemetry.snapshot().bundle_bytes, Buffer.byteLength(JSON.stringify(bundle), "utf8"));
});

test("context telemetry records cache and supplemental-read diagnostics", () => {
  const telemetry = createContextTelemetry();
  telemetry.record({ candidateTokens: 900, finalTokens: 300, cacheHit: true });
  telemetry.recordSupplementalRead();
  telemetry.recordSupplementalRead();

  assert.deepEqual(telemetry.snapshot(), {
    initial_tool_schema_bytes: 0,
    bundle_bytes: 0,
    candidate_tokens: 900,
    final_bundle_tokens: 300,
    cache_hits: 1,
    cache_misses: 0,
    supplemental_reads: 2,
    first_effective_tool_call_ms: null,
  });
});


