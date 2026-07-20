import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexSessionsRoot } from '../src/codex-session/codex-session-root.mjs';

test('resolveCodexSessionsRoot uses legacy .codex/sessions when GPTWORK_CODEX_HOME points at the user home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gptwork-codex-home-'));
  const legacy = join(home, '.codex', 'sessions');
  await mkdir(legacy, { recursive: true });
  assert.equal(resolveCodexSessionsRoot(home), legacy);
});

test('resolveCodexSessionsRoot uses direct sessions when codexHome is already the Codex directory', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'gptwork-dot-codex-'));
  const direct = join(codexHome, 'sessions');
  await mkdir(direct, { recursive: true });
  assert.equal(resolveCodexSessionsRoot(codexHome), direct);
});
