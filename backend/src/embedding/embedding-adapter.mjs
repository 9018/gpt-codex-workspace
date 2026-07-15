/**
 * embedding-adapter.mjs
 *
 * Resilience adapter for embedding providers.
 *
 * Exports:
 *   withTimeout(promise, ms, msg?)   — wraps promise with timeout
 *   withRetry(fn, options)            — retry with exponential backoff
 *   withFallback(primary, fallback)   — fallback chain
 *   benchmarkAdapter(adapter, n)      — measure latency/throughput/errors
 *   checkpointDigest(content)         — deterministic SHA-256 digest
 *   failClosed(fn, defaultValue)      — default on unrecoverable failure
 */

import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

/**
 * Wraps a promise with a timeout.
 * Rejects with TimeoutError if the promise does not settle within ms.
 *
 * @param {Promise} promise
 * @param {number} ms — timeout in milliseconds
 * @param {string} [msg] — custom error message
 * @returns {Promise} resolves with promise value or rejects on timeout
 */
export function withTimeout(promise, ms, msg) {
  const errorMsg = msg || `Operation timed out after ${ms}ms`;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMsg);
      err.name = 'TimeoutError';
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retry an async function with exponential backoff.
 *
 * @param {Function} fn — async function to retry
 * @param {object} [options]
 * @param {number} [options.maxRetries=2] — max number of retries
 * @param {number} [options.baseMs=100] — base delay in ms
 * @param {number} [options.maxMs=5000] — max delay in ms
 * @returns {Promise} resolves with fn result
 */
export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 5000;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseMs * (2 ** attempt) + Math.random() * baseMs, maxMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Try primary async function; fall back to secondary on failure.
 *
 * @param {Function} primary
 * @param {Function} fallback
 * @returns {Promise} resolves with primary or fallback result
 */
export async function withFallback(primary, fallback) {
  try {
    return await primary();
  } catch (primaryError) {
    // Fall through to fallback
  }
  return await fallback();
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

/**
 * Run an adapter function n times and collect latency stats.
 *
 * @param {Function} adapter — async function
 * @param {number} iterations — number of runs
 * @returns {Promise<object>} { minLatencyMs, maxLatencyMs, avgLatencyMs,
 *   totalRequests, errorCount, successCount, throughputPerSec }
 */
export async function benchmarkAdapter(adapter, iterations) {
  const latencies = [];
  let errors = 0;
  const started = Date.now();

  for (let i = 0; i < iterations; i++) {
    const opStart = Date.now();
    try {
      await adapter();
      latencies.push(Date.now() - opStart);
    } catch {
      errors++;
    }
  }

  const elapsedMs = Math.max(1, Date.now() - started);
  const successCount = latencies.length;

  return {
    minLatencyMs: successCount > 0 ? Math.min(...latencies) : 0,
    maxLatencyMs: successCount > 0 ? Math.max(...latencies) : 0,
    avgLatencyMs: successCount > 0
      ? latencies.reduce((a, b) => a + b, 0) / successCount
      : 0,
    totalRequests: iterations,
    errorCount: errors,
    successCount,
    throughputPerSec: (iterations / elapsedMs) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint Digest
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic SHA-256 hex digest of content for embedding
 * checkpoint verification.
 *
 * @param {string} content
 * @returns {string} hex digest (64 chars)
 */
export function checkpointDigest(content) {
  return createHash('sha256').update(String(content)).digest('hex');
}

// ---------------------------------------------------------------------------
// Fail-Closed
// ---------------------------------------------------------------------------

/**
 * Execute an async function; return defaultValue on any failure.
 * Never throws.
 *
 * @param {Function|Promise} fn — async function or promise
 * @param {*} defaultValue — returned on failure
 * @returns {Promise<*>} result or defaultValue
 */
export async function failClosed(fn, defaultValue) {
  try {
    if (typeof fn === 'function') {
      return await fn();
    }
    return await fn;
  } catch {
    return defaultValue;
  }
}
