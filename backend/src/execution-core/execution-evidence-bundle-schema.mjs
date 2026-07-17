/**
 * execution-evidence-bundle-schema.mjs — EvidenceBundle schema.
 *
 * An EvidenceBundle is the single source of truth for all evidence
 * gathered during an execution run.  Provider claims, commands, test
 * results, repository snapshots, and acceptance decisions all belong
 * in the bundle.  Unverified provider self-reports ("884 tests passed")
 * must go into `rejected_claims`, NOT `verified_facts`.
 *
 * @module execution-evidence-bundle-schema
 */

import { randomUUID } from "node:crypto";

/**
 * Create a new EvidenceBundle with default values.
 *
 * @param {object} [input={}]
 * @returns {object} EvidenceBundle
 */
export function createEvidenceBundle(input = {}) {
  return {
    schema_version: 2,
    id: input.id || `evidence_bundle_${randomUUID()}`,
    run_id: input.run_id || null,
    attempt_ids: Array.isArray(input.attempt_ids) ? [...input.attempt_ids] : [],
    repository: {
      base_sha: input.repository?.base_sha || null,
      head_sha: input.repository?.head_sha || null,
      branch: input.repository?.branch || null,
      worktree_path: input.repository?.worktree_path || null,
      dirty_before: Array.isArray(input.repository?.dirty_before)
        ? [...input.repository.dirty_before]
        : [],
      dirty_after: Array.isArray(input.repository?.dirty_after)
        ? [...input.repository.dirty_after]
        : [],
      changed_files: Array.isArray(input.repository?.changed_files)
        ? [...input.repository.changed_files]
        : [],
      commit_sha: input.repository?.commit_sha || null,
      integrated_sha: input.repository?.integrated_sha || null,
    },
    commands: Array.isArray(input.commands) ? structuredClone(input.commands) : [],
    tests: {
      executed: input.tests?.executed === true,
      passed: input.tests?.passed !== false,
      total: input.tests?.total ?? null,
      passed_count: input.tests?.passed_count ?? null,
      failed_count: input.tests?.failed_count ?? null,
      skipped_count: input.tests?.skipped_count ?? null,
      coverage: input.tests?.coverage ?? null,
    },
    artifacts: Array.isArray(input.artifacts) ? structuredClone(input.artifacts) : [],
    document_validation: {
      executed: input.document_validation?.executed === true,
      passed: input.document_validation?.passed !== false,
      checks: Array.isArray(input.document_validation?.checks)
        ? [...input.document_validation.checks]
        : [],
    },
    readonly_proof: {
      required: input.readonly_proof?.required === true,
      before_sha: input.readonly_proof?.before_sha || null,
      after_sha: input.readonly_proof?.after_sha || null,
      mutation_detected: input.readonly_proof?.mutation_detected ?? null,
    },
    provider_claims: Array.isArray(input.provider_claims)
      ? structuredClone(input.provider_claims)
      : [],
    verified_facts: Array.isArray(input.verified_facts)
      ? structuredClone(input.verified_facts)
      : [],
    rejected_claims: Array.isArray(input.rejected_claims)
      ? structuredClone(input.rejected_claims)
      : [],
    completeness: {
      required_items: Array.isArray(input.completeness?.required_items)
        ? [...input.completeness.required_items]
        : [],
      present_items: Array.isArray(input.completeness?.present_items)
        ? [...input.completeness.present_items]
        : [],
      missing_items: Array.isArray(input.completeness?.missing_items)
        ? [...input.completeness.missing_items]
        : [],
    },
    created_at: input.created_at || new Date().toISOString(),
  };
}

/**
 * Reconcile provider claims against verified facts.
 * Any claim that cannot be backed by command evidence is moved to rejected_claims.
 *
 * @param {object} bundle - EvidenceBundle
 * @returns {object} Updated bundle with reconciled claims
 */
export function reconcileProviderClaims(bundle) {
  const verified = [...(bundle.verified_facts || [])];
  const rejected = [...(bundle.rejected_claims || [])];

  for (const claim of bundle.provider_claims || []) {
    const isVerifiable = claim.evidence_type &&
      ["command_exit_code", "test_report", "artifact", "commit_sha"].includes(claim.evidence_type);

    if (isVerifiable && hasCorroboratingEvidence(bundle, claim)) {
      verified.push({
        claim_id: claim.id || `claim_${verified.length + 1}`,
        statement: claim.statement || "Unspecified claim",
        evidence_type: claim.evidence_type,
        corroborated_by: claim.corroborated_by || [],
        verified_at: new Date().toISOString(),
      });
    } else {
      rejected.push({
        claim_id: claim.id || `claim_${rejected.length + 1}`,
        statement: claim.statement || "Unspecified claim",
        reason: isVerifiable
          ? "No corroborating command or artifact evidence"
          : "Cannot verify without command/artifact evidence",
        rejected_at: new Date().toISOString(),
      });
    }
  }

  return {
    ...bundle,
    verified_facts: verified,
    rejected_claims: rejected,
    provider_claims: [],
  };
}

function hasCorroboratingEvidence(bundle, claim) {
  if (!claim.evidence_type) return false;

  switch (claim.evidence_type) {
    case "command_exit_code":
      return bundle.commands.some((cmd) =>
        cmd.exit_code === claim.expected_exit_code ||
        claim.command_keywords?.some((kw) => cmd.command?.includes(kw))
      );
    case "commit_sha":
      return bundle.repository.commit_sha === claim.commit_sha;
    default:
      return false;
  }
}
