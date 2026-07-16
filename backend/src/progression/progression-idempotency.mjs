import { createHash } from "node:crypto";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function payloadDigest(payload) {
  return createHash("sha256").update(stableStringify(payload || {})).digest("hex");
}

export function buildProgressionIdempotencyKey({ task_id, decision_revision, action, payload } = {}) {
  return [
    String(task_id || "global"),
    String(decision_revision ?? "none"),
    String(action || "unknown"),
    payloadDigest(payload),
  ].join(":");
}
