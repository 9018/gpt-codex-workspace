import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNativeCodexSessionId } from "../src/codex-session/native-session-id-parser.mjs";
import { createCodexSessionManifestStore } from "../src/codex-session/codex-session-manifest-store.mjs";
import { snapshotNativeSessions } from "../src/codex-session/codex-session-inventory.mjs";
import { resolveNativeSessionBinding } from "../src/codex-session/codex-session-resolver.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

test("parseNativeCodexSessionId extracts the Codex banner session id", () => {
  assert.equal(parseNativeCodexSessionId("model: gpt-test\nsession id: 019f-session-123\nprovider: openai"), "019f-session-123");
  assert.equal(parseNativeCodexSessionId("no session banner"), null);
});

test("session manifest persists control-to-native bindings under the project", async () => {
  const projectRoot = track(await mkdtemp(join(tmpdir(), "gptwork-session-manifest-")));
  const store = createCodexSessionManifestStore({ projectRoot });
  const written = await store.write({
    control_session_id: "control_1",
    native_session_id: "native_1",
    task_id: "task_1",
    goal_id: "goal_1",
    execution_id: "exec_1",
    cwd: "/worktrees/task_1",
    codex_home: join(projectRoot, ".codex-runtime"),
    provider: "codex_exec",
    status: "running",
  });

  assert.equal(written.control_session_id, "control_1");
  assert.equal((await store.read("control_1")).native_session_id, "native_1");
  assert.equal((await store.findByNativeSessionId("native_1")).task_id, "task_1");
});

test("native session resolver uses output first and refuses ambiguous newest-file guesses", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-native-sessions-")));
  const sessionsRoot = join(root, "sessions", "2026", "07", "17");
  await mkdir(sessionsRoot, { recursive: true });
  const before = await snapshotNativeSessions(join(root, "sessions"));

  await writeFile(join(sessionsRoot, "rollout-a.jsonl"), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id: "native_a", cwd: "/repo/a" },
  })}\n`);
  await writeFile(join(sessionsRoot, "rollout-b.jsonl"), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id: "native_b", cwd: "/repo/b" },
  })}\n`);
  const after = await snapshotNativeSessions(join(root, "sessions"));

  assert.equal(resolveNativeSessionBinding({ output: "session id: native-output", before, after, cwd: "/repo/a" }).nativeSessionId, "native-output");
  assert.equal(resolveNativeSessionBinding({ before, after, cwd: "/repo/a" }).nativeSessionId, "native_a");
  const ambiguous = resolveNativeSessionBinding({ before, after, cwd: "/repo/missing" });
  assert.equal(ambiguous.nativeSessionId, null);
  assert.equal(ambiguous.reason, "native_session_ambiguous");
});
