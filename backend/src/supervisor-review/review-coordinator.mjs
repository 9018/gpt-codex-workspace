/**
 * review-coordinator.mjs — Review Coordinator.
 *
 * Provides the tick() function that replaces the old acceptance-service
 * orchestration in the checkpoint-supervisor-loop. Builds a review
 * packet from current run state and creates/returns a review request.
 *
 * @module supervisor-review/review-coordinator
 */

/**
 * Create the review coordinator.
 *
 * @param {object} deps
 * @param {object} deps.reviewPacketBuilder - { build({ runId }) }
 * @param {object} deps.reviewRequestStore - { getOrCreate({ runId, packet }), listByRun(runId) }
 * @returns {object} { tick }
 */
export function createReviewCoordinator(deps) {
  if (!deps.reviewPacketBuilder) throw new Error("reviewPacketBuilder is required");
  if (!deps.reviewRequestStore) throw new Error("reviewRequestStore is required");

  /**
   * Run one review tick for a given run.
   *
   * @param {string} runId
   * @returns {Promise<{ review_required: boolean, request: object|null, skipped_reason: string|null }>}
   */
  async function tick(runId) {
    const packet = await deps.reviewPacketBuilder.build({ runId });

    // Quick check via listByRun if available (avoids creating duplicate index entry)
    if (deps.reviewRequestStore.listByRun) {
      const existingRequests = await deps.reviewRequestStore.listByRun(runId);
      const match = existingRequests.find(
        (r) => r.revision_id === packet.revision.id
      );
      if (match) {
        return {
          review_required: false,
          request: match,
          skipped_reason: `Review already exists with status: ${match.status}`,
        };
      }
    }

    // Create or get existing request
    const request = await deps.reviewRequestStore.getOrCreate({ runId, packet });

    if (request.status === "pending") {
      return {
        review_required: true,
        request,
        skipped_reason: null,
      };
    }

    return {
      review_required: false,
      request,
      skipped_reason: `Review already in status: ${request.status} for revision ${request.revision_id}`,
    };
  }

  return { tick };
}
