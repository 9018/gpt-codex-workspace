import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const canaryPath = join(__dirname, '..', '..', 'docs', 'e2e-tui-canary-2026-07-13.md');

describe('TUI E2E Canary 2026-07-13', () => {
  it('exists with exact three-line contents', () => {
    const content = readFileSync(canaryPath, 'utf8');
    const expected = `# TUI E2E Canary
status=PASS
date=2026-07-13
`;
    assert.equal(content, expected, 'Canary document must contain exactly three specified lines');
  });
});
