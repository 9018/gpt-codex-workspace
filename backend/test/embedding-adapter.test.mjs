import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Embedding Adapter Resilience', () => {
  let withTimeout, withRetry, withFallback, benchmarkAdapter, checkpointDigest, failClosed;

  before(async () => {
    const mod = await import('../src/embedding/embedding-adapter.mjs');
    withTimeout = mod.withTimeout;
    withRetry = mod.withRetry;
    withFallback = mod.withFallback;
    benchmarkAdapter = mod.benchmarkAdapter;
    checkpointDigest = mod.checkpointDigest;
    failClosed = mod.failClosed;
  });

  describe('withTimeout', () => {
    it('resolves when operation completes within timeout', async () => {
      const result = await withTimeout(
        Promise.resolve('ok'),
        1000,
      );
      assert.equal(result, 'ok');
    });

    it('rejects when operation exceeds timeout', async () => {
      const slow = new Promise((resolve) => setTimeout(resolve, 500, 'slow'));
      await assert.rejects(
        () => withTimeout(slow, 50),
        /timed out/i,
      );
    });

    it('rejects with custom error message', async () => {
      const slow = new Promise((resolve) => setTimeout(resolve, 500, 'slow'));
      await assert.rejects(
        () => withTimeout(slow, 50, 'Embedding call timed out'),
        /Embedding call timed out/,
      );
    });
  });

  describe('withRetry', () => {
    it('succeeds on first attempt when no error', async () => {
      let calls = 0;
      const fn = async () => { calls++; return 'ok'; };
      const result = await withRetry(fn, { maxRetries: 3, baseMs: 10 });
      assert.equal(result, 'ok');
      assert.equal(calls, 1);
    });

    it('retries on failure and eventually succeeds', async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      };
      const result = await withRetry(fn, { maxRetries: 3, baseMs: 10 });
      assert.equal(result, 'recovered');
      assert.equal(calls, 3);
    });

    it('exhausts maxRetries and throws', async () => {
      let calls = 0;
      const fn = async () => { calls++; throw new Error('persistent'); };
      await assert.rejects(
        () => withRetry(fn, { maxRetries: 2, baseMs: 5 }),
        /persistent/,
      );
      assert.equal(calls, 3); // initial + 2 retries
    });
  });

  describe('withFallback', () => {
    it('returns primary result on success', async () => {
      const primary = async () => 'primary';
      const fallback = async () => 'fallback';
      const result = await withFallback(primary, fallback);
      assert.equal(result, 'primary');
    });

    it('falls back to secondary on primary failure', async () => {
      const primary = async () => { throw new Error('primary down'); };
      const fallback = async () => 'fallback';
      const result = await withFallback(primary, fallback);
      assert.equal(result, 'fallback');
    });

    it('throws when both primary and fallback fail', async () => {
      const primary = async () => { throw new Error('p fail'); };
      const fallback = async () => { throw new Error('f fail'); };
      await assert.rejects(
        () => withFallback(primary, fallback),
        /f fail/,
      );
    });
  });

  describe('benchmarkAdapter', () => {
    it('returns stats for successful adapter', async () => {
      let count = 0;
      const adapter = async () => { count++; return `result-${count}`; };
      const stats = await benchmarkAdapter(adapter, 5);
      assert.ok(stats.minLatencyMs >= 0);
      assert.ok(stats.maxLatencyMs >= stats.minLatencyMs);
      assert.ok(stats.avgLatencyMs >= 0);
      assert.equal(stats.totalRequests, 5);
      assert.equal(stats.errorCount, 0);
      assert.equal(stats.successCount, 5);
    });

    it('reports error count', async () => {
      let calls = 0;
      const adapter = async () => {
        calls++;
        if (calls % 2 === 0) throw new Error('err');
        return 'ok';
      };
      const stats = await benchmarkAdapter(adapter, 4);
      assert.equal(stats.totalRequests, 4);
      assert.ok(stats.errorCount > 0);
      assert.ok(stats.throughputPerSec >= 0);
    });
  });

  describe('checkpointDigest', () => {
    it('produces deterministic digest', () => {
      const d1 = checkpointDigest('hello world');
      const d2 = checkpointDigest('hello world');
      assert.equal(d1, d2);
    });

    it('produces different digests for different inputs', () => {
      const d1 = checkpointDigest('content a');
      const d2 = checkpointDigest('content b');
      assert.notEqual(d1, d2);
    });

    it('returns hex string of expected length', () => {
      const digest = checkpointDigest('test');
      assert.equal(typeof digest, 'string');
      assert.equal(digest.length, 64); // SHA-256 hex length
    });

    it('handles empty string', () => {
      const digest = checkpointDigest('');
      assert.equal(digest.length, 64);
    });
  });

  describe('failClosed', () => {
    it('returns default value when operation throws', async () => {
      const fn = async () => { throw new Error('fail'); };
      const result = await failClosed(fn, 'default');
      assert.equal(result, 'default');
    });

    it('returns actual result on success', async () => {
      const fn = async () => 'success';
      const result = await failClosed(fn, 'default');
      assert.equal(result, 'success');
    });

    it('returns default value when promise rejects', async () => {
      const result = await failClosed(
        Promise.reject(new Error('nope')),
        { safe: true },
      );
      assert.deepEqual(result, { safe: true });
    });
  });
});
