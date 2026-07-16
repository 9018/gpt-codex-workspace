export function parseNativeCodexSessionId(text) {
  const match = String(text || "").match(/^session id:\s*([A-Za-z0-9-]+)/im);
  return match ? match[1] : null;
}
