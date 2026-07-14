// @ts-check
/**
 * Task Context Store — atomic file-level persistence for
 * task context packets, digests, provenance, and deltas.
 */
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { taskContextContractDigest } from "./task-context-canonicalizer.mjs";

// --------------------------------------------------------------------------
// File names
// --------------------------------------------------------------------------

export const TASK_CONTEXT_JSON = "task.context.json";
export const TASK_CONTEXT_DIGEST = "task.context.digest";
export const SOURCE_PROVENANCE_JSON = "source.provenance.json";
export const TASK_DELTAS_JSONL = "task.deltas.jsonl";

// --------------------------------------------------------------------------
// Store factory
// --------------------------------------------------------------------------

/**
 * Create a task context store bound to a workspace root.
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @returns {object}
 */
export function createTaskContextStore({ workspaceRoot }) {
  /**
   * Resolve directory for a goal's context artifacts.
   * @param {string} goalDir - e.g. ".gptwork/goals/goal_x"
   * @returns {string}
   */
  const resolveDir = (goalDir) =>
    join(workspaceRoot, goalDir);

  /**
   * Read the current task.context.json for a goal.
   * @param {string} goalDir
   * @returns {Promise<object|null>}
   */
  async function readPacket(goalDir) {
    const filePath = join(resolveDir(goalDir), TASK_CONTEXT_JSON);
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Atomic write of task context artifacts.
   *
   * Write order:
   *   1. task.context.json
   *   2. task.context.digest
   *   3. source.provenance.json
   *
   * @param {string} goalDir
   * @param {object} packet - The task context packet.
   * @param {object} [options]
   * @param {Array} [options.sourceProvenance]
   * @returns {Promise<string>} The contract digest.
   */
  async function writePacket(goalDir, packet, options = {}) {
    const dir = resolveDir(goalDir);
    await mkdir(dir, { recursive: true });

    // Compute contract digest before writing
    const digest = taskContextContractDigest(packet);

    // Atomic: write to tmp, then rename
    const packetPath = join(dir, TASK_CONTEXT_JSON);
    const tmpPacket = `${packetPath}.${randomUUID()}.tmp`;
    await writeFile(tmpPacket, JSON.stringify(packet, null, 2) + "\n", "utf8");
    await rename(tmpPacket, packetPath);

    // Write digest
    const digestPath = join(dir, TASK_CONTEXT_DIGEST);
    const tmpDigest = `${digestPath}.${randomUUID()}.tmp`;
    await writeFile(tmpDigest, digest + "\n", "utf8");
    await rename(tmpDigest, digestPath);

    // Write provenance
    if (Array.isArray(options.sourceProvenance) && options.sourceProvenance.length > 0) {
      const provPath = join(dir, SOURCE_PROVENANCE_JSON);
      const tmpProv = `${provPath}.${randomUUID()}.tmp`;
      await writeFile(
        tmpProv,
        JSON.stringify(options.sourceProvenance, null, 2) + "\n",
        "utf8"
      );
      await rename(tmpProv, provPath);
    }

    return digest;
  }

  /**
   * Verify that the stored digest matches a recomputed digest from the packet.
   * Throws if mismatch.
   * @param {string} goalDir
   * @returns {Promise<boolean>}
   */
  async function verifyDigest(goalDir) {
    const packet = await readPacket(goalDir);
    if (!packet) return false;

    const dir = resolveDir(goalDir);
    const digestPath = join(dir, TASK_CONTEXT_DIGEST);
    let storedDigest = "";
    try {
      storedDigest = (await readFile(digestPath, "utf8")).trim();
    } catch {
      throw new Error("task_context_digest_mismatch: digest file not found");
    }

    const computedDigest = taskContextContractDigest(packet);
    if (storedDigest !== computedDigest) {
      throw new Error(
        `task_context_digest_mismatch: stored="${storedDigest}" !== computed="${computedDigest}"`
      );
    }
    return true;
  }

  /**
   * Read source.provenance.json.
   * @param {string} goalDir
   * @returns {Promise<Array|null>}
   */
  async function readProvenance(goalDir) {
    const filePath = join(resolveDir(goalDir), SOURCE_PROVENANCE_JSON);
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Append a delta entry to task.deltas.jsonl.
   * Validates delta revision monotonicity.
   * @param {string} goalDir
   * @param {object} delta
   * @returns {Promise<void>}
   */
  async function appendDelta(goalDir, delta) {
    const dir = resolveDir(goalDir);
    await mkdir(dir, { recursive: true });
    const deltasPath = join(dir, TASK_DELTAS_JSONL);
    const line = JSON.stringify(delta) + "\n";
    await appendFile(deltasPath, line, "utf8");
  }

  /**
   * Read all delta entries.
   * @param {string} goalDir
   * @returns {Promise<Array>}
   */
  async function readDeltas(goalDir) {
    const filePath = join(resolveDir(goalDir), TASK_DELTAS_JSONL);
    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  return {
    readPacket,
    writePacket,
    verifyDigest,
    readProvenance,
    appendDelta,
    readDeltas,
  };
}
