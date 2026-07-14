// @ts-check
/**
 * Workstream Context Store — manages versioned context snapshots
 * for workstream continuity.
 */
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestCanonical } from "../context-contract/task-context-canonicalizer.mjs";

/**
 * Create a workstream context store.
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @returns {object}
 */
export function createWorkstreamContextStore({ workspaceRoot }) {
  const wsDir = (id) => join(workspaceRoot, ".gptwork", "workstreams", id);
  const snapshotPath = (id) => join(wsDir(id), "context.snapshot.json");

  /**
   * Read the current snapshot for a workstream.
   * @param {string} workstreamId
   * @returns {Promise<object|null>}
   */
  async function readSnapshot(workstreamId) {
    try {
      return JSON.parse(await readFile(snapshotPath(workstreamId), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Write a new snapshot with optimistic concurrency control.
   * @param {string} workstreamId
   * @param {object} input
   * @param {object} [options]
   * @param {number|null} [options.expectedRevision]
   * @returns {Promise<object>}
   */
  async function writeSnapshot(workstreamId, input, { expectedRevision = null } = {}) {
    const existing = await readSnapshot(workstreamId);
    if (
      expectedRevision !== null &&
      Number(existing?.revision || 0) !== Number(expectedRevision)
    ) {
      const err = new Error("workstream context revision conflict");
      err.code = "workstream_context_revision_conflict";
      throw err;
    }

    const next = { ...input, workstream_id: workstreamId };
    const withoutDigest = { ...next };
    delete withoutDigest.digest;
    next.digest = digestCanonical(withoutDigest);

    const dir = wsDir(workstreamId);
    await mkdir(dir, { recursive: true });
    const target = snapshotPath(workstreamId);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, target);

    await appendFile(
      join(dir, "context.history.jsonl"),
      JSON.stringify({
        type: "snapshot_written",
        revision: next.revision,
        digest: next.digest,
        written_at: new Date().toISOString(),
      }) + "\n",
      "utf8"
    );

    return next;
  }

  /**
   * Append a history event.
   * @param {string} workstreamId
   * @param {object} event
   * @returns {Promise<void>}
   */
  async function appendHistory(workstreamId, event) {
    const dir = wsDir(workstreamId);
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, "context.history.jsonl"),
      JSON.stringify({
        ...event,
        written_at: event.written_at || new Date().toISOString(),
      }) + "\n",
      "utf8"
    );
  }

  return { readSnapshot, writeSnapshot, appendHistory };
}
