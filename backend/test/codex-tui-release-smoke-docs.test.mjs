import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const releaseGatePath = resolve(import.meta.dirname, "../../docs/delivery/release-gate.md");

test("release gate documents the Codex TUI provider smoke path", async () => {
  const doc = await readFile(releaseGatePath, "utf8");

  assert.match(doc, /codex_exec[^\n]+default/i);
  assert.match(doc, /codex_tui_goal[^\n]+explicit optional provider/i);
  assert.match(doc, /codex_execution_provider:\s*codex_tui_goal/i);
  assert.match(doc, /codex_tui_start_goal[\s\S]+codex_tui_status[\s\S]+codex_tui_read[\s\S]+codex_tui_send[\s\S]+codex_tui_stop[\s\S]+codex_tui_collect/);
  assert.match(doc, /completion collection/i);
  assert.match(doc, /runtime_status/i);
  assert.match(doc, /recovery_plane_status|recovery_diagnose/i);
  assert.match(doc, /no-result|no result/i);
  assert.match(doc, /result\.md[\s\S]+result\.json/);
  assert.match(doc, /transcript contents/i);
  assert.match(doc, /tokens/i);

  assert.doesNotMatch(doc, /\bsk-[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(doc, /SECRET_TOKEN=/);
  assert.doesNotMatch(doc, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(doc, /session_logs\.log[\s\S]*(cat|tail|less)/i);
});
