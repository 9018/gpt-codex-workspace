// @ts-check
/**
 * Canonical JSON digest for Task Context packets.
 * Provides key-order-independent SHA-256 hashing with transient field exclusion.
 */
import { createHash } from "node:crypto";

/** Fields excluded from the contract digest (transient instance metadata). */
const CONTRACT_TRANSIENT_FIELDS = Object.freeze(
  new Set(["compiled_at", "goal_id", "task_id", "instance_digest"])
);

/** Fields excluded from the instance digest. */
const INSTANCE_TRANSIENT_FIELDS = Object.freeze(
  new Set(["compiled_at", "instance_digest"])
);

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Produce a key-order-independent copy of `value`.
 * Removes keys present in the `transient` set.
 * @param {any} value
 * @param {Set<string>} transient
 * @returns {any}
 */
export function canonicalizeJson(value, transient = CONTRACT_TRANSIENT_FIELDS) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, transient));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !transient.has(key))
        .sort()
        .map((key) => [
          key,
          canonicalizeJson(value[key], transient),
        ])
    );
  }
  return value;
}

/**
 * Compute a SHA-256 digest of the canonical form of `value`.
 * @param {any} value
 * @returns {string} "sha256:<hex>"
 */
export function digestCanonical(value) {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return (
    "sha256:" +
    createHash("sha256").update(canonical, "utf8").digest("hex")
  );
}

/**
 * Contract digest — excludes compiled_at, goal_id, task_id.
 * Used for equivalence checking across contexts.
 * @param {object} packet
 * @returns {string}
 */
export function taskContextContractDigest(packet) {
  return digestCanonical(packet);
}

/**
 * Instance digest — includes goal/task identity, excludes compiled_at.
 * Used for tracking the exact instance.
 * @param {object} packet
 * @returns {string}
 */
export function taskContextInstanceDigest(packet) {
  return digestCanonical({
    ...packet,
    identity: {
      ...(packet.identity || {}),
      contract_digest: taskContextContractDigest(packet),
    },
  });
}

/**
 * Compute a diff summary between two packets (before → after).
 * Returns only the top-level keys that differ.
 * @param {object} before
 * @param {object} after
 * @returns {Array<{key: string, change: string}>}
 */
export function diffTaskContextPackets(before, after) {
  const result = [];
  const allKeys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const key of [...allKeys].sort()) {
    const b = JSON.stringify(canonicalizeJson(before[key]));
    const a = JSON.stringify(canonicalizeJson(after[key]));
    if (b !== a) {
      result.push({ key, change: "modified" });
    }
  }
  return result;
}
