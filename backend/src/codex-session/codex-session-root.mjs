import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveCodexSessionsRoot(codexHome) {
  if (!codexHome) return null;
  const root = resolve(String(codexHome));
  const direct = join(root, 'sessions');
  const legacy = join(root, '.codex', 'sessions');
  return !existsSync(direct) && existsSync(legacy) ? legacy : direct;
}
