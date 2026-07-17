export function createTuiProgressTracker({ noProgressMs = 120_000, now = Date.now } = {}) {
  let lastDigest = null;
  let lastProgressAt = now();
  return {
    observe(frame = {}, { at = now() } = {}) {
      const progressed = Boolean(frame.content_digest && frame.content_digest !== lastDigest);
      if (progressed) lastProgressAt = at;
      lastDigest = frame.content_digest || lastDigest;
      return { progressed, no_progress: at - lastProgressAt >= noProgressMs, last_progress_at: lastProgressAt, last_digest: lastDigest };
    },
  };
}
