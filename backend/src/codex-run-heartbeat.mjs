import { updateRunHeartbeat } from "./codex-run-lifecycle.mjs";

const _heartbeatThrottlers = new Map();

export function createThrottledHeartbeat(runFilePath, intervalMs = 1000, heartbeatFn = null) {
  let lastFlushAt = 0;
  let lastPhase = null;
  let pendingFields = null;
  let pendingPhase = null;
  let timer = null;

  const writeFn = heartbeatFn || ((path, phase, fields) => updateRunHeartbeat(path, phase, fields));

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const phase = pendingPhase || lastPhase || "unknown";
    const fields = pendingFields || {};
    lastFlushAt = Date.now();
    pendingPhase = null;
    pendingFields = null;
    writeFn(runFilePath, phase, fields).catch(() => {});
  }

  function throttledUpdate(phase, fields = {}) {
    const now = Date.now();
    const phaseChanged = phase !== lastPhase;
    lastPhase = phase;

    if (phaseChanged) {
      // Phase change: flush immediately
      pendingPhase = phase;
      pendingFields = fields;
      flush();
      return;
    }

    // Output-only update: throttle
    pendingFields = { ...pendingFields, ...fields };
    pendingPhase = phase;

    if (now - lastFlushAt >= intervalMs) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, intervalMs - (now - lastFlushAt));
    }
  }

  _heartbeatThrottlers.set(runFilePath, throttledUpdate);
  return throttledUpdate;
}

/**
 * Get an existing throttled heartbeat function, or create one.
 * @param {string} runFilePath
 * @returns {function}
 */
export function getThrottledHeartbeat(runFilePath) {
  let fn = _heartbeatThrottlers.get(runFilePath);
  if (!fn) {
    fn = createThrottledHeartbeat(runFilePath);
    _heartbeatThrottlers.set(runFilePath, fn);
  }
  return fn;
}

/**
 * Remove throttled heartbeat for a run (cleanup after final heartbeat).
 * @param {string} runFilePath
 */
export function removeThrottledHeartbeat(runFilePath) {
  const fn = _heartbeatThrottlers.get(runFilePath);
  if (fn) _heartbeatThrottlers.delete(runFilePath);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
