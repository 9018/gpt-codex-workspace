/**
 * supervisor-review-packet-builder.mjs — Review Packet Builder.
 *
 * Orchestrates parallel reads from multiple dependencies to build a
 * complete SupervisorReviewPacket. Optional reader failures are
 * captured as evidence_gaps rather than thrown errors.
 *
 * @module supervisor-review/supervisor-review-packet-builder
 */

import { buildReviewRevision } from "./supervisor-review-revision.mjs";
import { createSupervisorReviewPacket } from "./supervisor-review-packet-schema.mjs";

/**
 * Safely invoke an async reader, returning the result or adding
 * an evidence gap on failure.
 *
 * @param {Function} readerFn - Async function to invoke
 * @param {string} readerName - Name for gap reporting
 * @param {Array} gaps - Accumulated evidence gaps
 * @param {*} defaultValue - Default if reader fails
 * @returns {Promise<*>} Result or default
 */
async function safeRead(readerFn, readerName, gaps, defaultValue = null) {
  try {
    return await readerFn();
  } catch (err) {
    gaps.push(`${readerName}: ${err.message || String(err)}`);
    return defaultValue;
  }
}

/**
 * Create a Review Packet Builder.
 *
 * @param {object} deps
 * @param {object} deps.runStore - { readRun(runId) }
 * @param {object} deps.checkpointReader - { latest(runId) }
 * @param {object} deps.planReader - { readForRun(run) }
 * @param {object} deps.repositoryEvidence - { collect(run) }
 * @param {object} deps.tuiProgressReader - { read(run) }
 * @param {object} deps.tuiSessionReader - { read(run) }
 * @param {object} deps.decisionStore - { listByRun(runId, limit) }
 * @param {object} deps.contextReader - { read(contextRef) }
 * @param {object} deps.objectiveReader - { read(run) }
 * @param {object} deps.architectureBaselineReader - { read(run, plan) }
 * @returns {object} { build }
 */
export function createSupervisorReviewPacketBuilder(deps) {
  async function build({ runId }) {
    const gaps = [];

    // 1. Read the run (required)
    let run;
    try {
      run = await deps.runStore.readRun(runId);
    } catch (err) {
      throw new Error(`Failed to read run ${runId}: ${err.message}`);
    }

    // 2. Parallel reads (all optional)
    const [checkpoint, plan, repo, progressObj, session, history] =
      await Promise.all([
        safeRead(
          () => deps.checkpointReader.latest(runId),
          "checkpointReader", gaps, null
        ),
        safeRead(
          () => deps.planReader.readForRun(run),
          "planReader", gaps, null
        ),
        safeRead(
          () => deps.repositoryEvidence.collect(run),
          "repositoryEvidence", gaps, {
            worktree_path: null, base_sha: null, head_sha: null,
            changed_files: [], diff_summary: "", focused_diff: "",
            new_symbols: [], deleted_symbols: [], diff_digest: null, dirty_paths: [],
          }
        ),
        safeRead(
          () => deps.tuiProgressReader.read(run),
          "tuiProgressReader", gaps, null
        ),
        safeRead(
          () => deps.tuiSessionReader.read(run),
          "tuiSessionReader", gaps, null
        ),
        safeRead(
          () => deps.decisionStore.listByRun(runId, 10),
          "decisionStore", gaps, []
        ),
      ]);

    // 3. Context and objective reads (parallel)
    const [contextManifest, objective, architecture] = await Promise.all([
      safeRead(
        () => deps.contextReader.read(run.context_ref),
        "contextReader", gaps, { digest: null }
      ),
      safeRead(
        () => deps.objectiveReader.read(run),
        "objectiveReader", gaps, {}
      ),
      safeRead(
        () => deps.architectureBaselineReader.read(run, plan),
        "architectureBaselineReader", gaps, {}
      ),
    ]);

    // 4. Build revision
    const revision = buildReviewRevision({
      run,
      checkpoint,
      repository: repo,
      contextManifest,
      supervisorPlan: plan,
    });

    // 5. Build packet
    return createSupervisorReviewPacket({
      run,
      revision,
      repository: repo,
      progress: progressObj?.progress || null,
      session: session || null,
      priorDecisions: history || [],
      evidenceGaps: gaps,
      ...objective,
      ...architecture,
    });
  }

  return { build };
}
