/**
 * supervisor-review-revision.mjs — ReviewRevision builder.
 *
 * A ReviewRevision is a deterministic fingerprint of the facts that
 * ChatGPT needs to evaluate: the run state, checkpoint, repository diff,
 * context manifest, and supervisor plan. Any change to these facts
 * produces a different revision id.
 *
 * The revision id is a sha256 hex digest of the canonical JSON payload.
 * Fields are ordered, and arrays (e.g., dirty_paths) are sorted.
 *
 * @module supervisor-review/supervisor-review-revision
 */

import { createHash } from "node:crypto";

/**
 * Build a deterministic ReviewRevision from the given facts.
 *
 * @param {object} input
 * @param {object} input.run - ExecutionRun (must have id, version)
 * @param {object} [input.checkpoint] - SupervisorCheckpoint (optional)
 * @param {object} input.repository - Repository state
 * @param {string} input.repository.base_sha
 * @param {string} input.repository.head_sha
 * @param {string} [input.repository.diff_digest]
 * @param {string[]} [input.repository.dirty_paths]
 * @param {object} [input.contextManifest] - Context manifest (optional)
 * @param {object} [input.supervisorPlan] - SupervisorPlan (optional)
 * @returns {object} ReviewRevision with .id (sha256 hex)
 */
export function buildReviewRevision({
  run = {},
  checkpoint = null,
  repository = {},
  contextManifest = null,
  supervisorPlan = null,
} = {}) {
  const payload = {
    run_id: run.id || null,
    run_version: run.version ?? null,
    checkpoint_id: checkpoint?.id || null,
    checkpoint_digest: checkpoint?.digest || null,
    base_sha: repository.base_sha || null,
    head_sha: repository.head_sha || null,
    diff_digest: repository.diff_digest || null,
    dirty_paths: [...(repository.dirty_paths || [])].sort(),
    context_digest: contextManifest?.digest || null,
    plan_revision: supervisorPlan?.version ?? null,
    acceptance_contract_digest: run.acceptance_contract_digest || null,
  };

  return {
    ...payload,
    id: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}
