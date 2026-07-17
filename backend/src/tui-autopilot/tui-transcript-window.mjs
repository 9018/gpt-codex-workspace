export function createTuiTranscriptWindow({ maxChars = 32_000, maxFrames = 8 } = {}) {
  let text = "";
  const frames = [];
  const events = [];
  return {
    append(chunk) { text = (text + String(chunk || "")).slice(-maxChars); return text; },
    addFrame(frame) { frames.push(frame); if (frames.length > maxFrames) frames.shift(); },
    addEvent(event) { events.push(event); if (events.length > maxFrames * 4) events.shift(); },
    snapshot() { return { text, frames: structuredClone(frames), events: structuredClone(events) }; },
  };
}
