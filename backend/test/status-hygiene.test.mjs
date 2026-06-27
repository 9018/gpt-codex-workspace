import test from 'node:test';
import assert from 'node:assert/strict';

import { buildImportCheckDiagnostics, classifyImportCheckRunnerFailure } from '../src/import-check-diagnostics.mjs';

test('status hygiene: import runner 502 is classified as transient tool_error with local fallback', () => {
  const classification = classifyImportCheckRunnerFailure({ message: 'MCP runner failed: 502 Bad Gateway' });

  assert.equal(classification.transient, true);
  assert.equal(classification.tool_error, true);
  assert.equal(classification.kind, 'transient/tool_error');
  assert.equal(classification.local_fallback_command, 'npm --prefix backend run check:imports');
  assert.match(classification.recommendation, /directly in the repo\/worktree/);
});

test('status hygiene: import diagnostics exposes auto-runnable direct backend fallback', () => {
  const diagnostics = buildImportCheckDiagnostics({ stderr: 'upstream connect error: 502' });

  assert.equal(diagnostics.status, 'WARN');
  assert.equal(diagnostics.local_fallback.command, 'npm --prefix backend run check:imports');
  assert.equal(diagnostics.local_fallback.auto_runnable, true);
  assert.equal(diagnostics.classification.kind, 'transient/tool_error');
});
