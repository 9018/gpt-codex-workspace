import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLogFile, streamToLog, trimUtf8Tail } from '../src/codex-run-logs.mjs';

test('trimUtf8Tail keeps a bounded UTF-8 tail', () => {
  const result = trimUtf8Tail('abc😀def😀ghi', 9);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.tail, 'utf8') <= 9);
  assert.doesNotMatch(result.tail, /\uFFFD/);
});

test('streamToLog returns bounded tail metadata', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'run-logs-'));
  try {
    const filePath = join(tmpDir, 'stdout.log');
    const result = streamToLog({ filePath, chunk: 'hello world', boundedTail: '', maxTailBytes: 5 });
    assert.equal(result.tail, 'world');
    assert.equal(result.truncated, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('appendLogFile serializes concurrent appends per file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'run-logs-'));
  try {
    const filePath = join(tmpDir, 'stdout.log');
    await Promise.all([
      appendLogFile(filePath, 'a'),
      appendLogFile(filePath, 'b'),
      appendLogFile(filePath, 'c'),
    ]);
    assert.equal(readFileSync(filePath, 'utf8'), 'abc');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
