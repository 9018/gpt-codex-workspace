import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkstreamContextStore } from "./workstream-context-store.mjs";

function digest(value) {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function blockerFindings(result = {}) {
  return [
    ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
    ...(Array.isArray(result.findings) ? result.findings : []),
    ...(Array.isArray(result.verification?.findings) ? result.verification.findings : []),
  ].filter((finding) => finding?.severity === "blocker" && finding?.resolved !== true);
}

function contractRequiresIntegration(task = {}, goal = {}) {
  const contract = task.acceptance_contract || goal.acceptance_contract || {};
  return contract.requirements?.requires_integration
    ?? contract.requires_integration
    ?? null;
}

async function writeOutcomeFile(workspaceRoot, outcome) {
  const dir = join(workspaceRoot, ".gptwork", "goals", outcome.goal_id);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "outcome.json");
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(outcome, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return `.gptwork/goals/${outcome.goal_id}/outcome.json`;
}

export function integrationSatisfied(result = {}) {
  const integration = result.integration || {};
  const unified = result.unified_decision || result.finalizer_decision?.unified_decision || {};
  return integration.merged === true
    || integration.satisfied === true
    || ["merged", "ff_only_merged", "skipped", "already_integrated", "not_required"].includes(String(integration.status || ""))
    || result.auto_integration_completion?.completed === true
    || unified.integration_effect?.satisfied === true
    || result.integration_not_required === true;
}

export function buildTaskOutcomeSummary({ task = {}, goal = {}, result = {} } = {}) {
  const completed = task.status === "completed"
    || result.unified_decision?.status === "completed"
    || result.finalizer_decision?.status === "completed";
  if (!completed) return { eligible: false, reason: "task_not_completed" };
  if (!task.workstream_id && !goal.workstream_id) return { eligible: false, reason: "workstream_missing" };
  if (!task.task_context_digest && !goal.task_context?.contract_digest) return { eligible: false, reason: "context_digest_missing" };
  if (blockerFindings(result).length > 0) return { eligible: false, reason: "blocker_findings_present" };
  if (result.verification?.passed !== true && result.unified_decision?.status !== "completed") {
    return { eligible: false, reason: "verification_not_passed" };
  }
  const contractIntegrationRequired = contractRequiresIntegration(task, goal);
  const integrationNotRequired = contractIntegrationRequired === false || result.integration_not_required === true;
  if (!integrationSatisfied({ ...result, integration_not_required: integrationNotRequired })) {
    return { eligible: false, reason: "integration_not_satisfied" };
  }

  const outcome = {
    schema_version: "gptwork.task_outcome.v1",
    workstream_id: task.workstream_id || goal.workstream_id,
    task_id: task.id,
    goal_id: goal.id || task.goal_id,
    status: "accepted",
    context_digest: task.task_context_digest || goal.task_context?.contract_digest,
    commit: result.commit || result.local_head || null,
    integrated: result.integration?.merged === true || result.auto_integration_completion?.completed === true,
    integration_not_required: integrationNotRequired
      || ["skipped", "already_integrated", "not_required"].includes(String(result.integration?.status || "")),
    canonical_head: result.auto_integration_completion?.canonical_head_after || result.repo_head || result.local_head || result.commit || null,
    delivered_capabilities: Array.isArray(result.delivered_capabilities) ? result.delivered_capabilities : [],
    durable_decisions: Array.isArray(result.durable_decisions) ? result.durable_decisions : [],
    remaining_blockers: [],
    future_relevance: Array.isArray(result.future_relevance) ? result.future_relevance : [],
    evidence_refs: [
      result.verification?.report_path,
      result.auto_integration_completion?.verification_report_path,
    ].filter(Boolean),
    created_at: new Date().toISOString(),
  };
  outcome.digest = digest(outcome);
  return { eligible: true, outcome };
}

function mergeById(existing = [], incoming = []) {
  const result = [...existing];
  const seen = new Set(result.map((item) => item?.id || item?.statement || JSON.stringify(item)));
  for (const item of incoming) {
    const key = item?.id || item?.statement || JSON.stringify(item);
    if (!seen.has(key)) {
      result.push(item);
      seen.add(key);
    }
  }
  return result;
}

export function applyOutcomeToSnapshot(snapshot, outcome) {
  const current = snapshot || {
    schema_version: "gptwork.workstream_context.v1",
    workstream_id: outcome.workstream_id,
    revision: 0,
    objective: "",
    durable_decisions: [],
    delivered_capabilities: [],
    open_blockers: [],
    repository_state: { repo_id: null, canonical_head: null, target_branch: null },
    accepted_outcomes: [],
    deprecated_facts: [],
    generated_from: [],
  };
  if ((current.accepted_outcomes || []).some((item) => item.task_id === outcome.task_id)) {
    return { changed: false, snapshot: current, reason: "outcome_already_applied" };
  }
  return {
    changed: true,
    snapshot: {
      ...current,
      revision: Number(current.revision || 0) + 1,
      durable_decisions: mergeById(current.durable_decisions, outcome.durable_decisions),
      delivered_capabilities: mergeById(current.delivered_capabilities, outcome.delivered_capabilities),
      repository_state: {
        ...(current.repository_state || {}),
        canonical_head: outcome.canonical_head || current.repository_state?.canonical_head || null,
      },
      accepted_outcomes: [
        ...(current.accepted_outcomes || []),
        { task_id: outcome.task_id, outcome_digest: outcome.digest, commit: outcome.commit, canonical_head: outcome.canonical_head }
      ],
      generated_from: [
        ...(current.generated_from || []),
        { kind: "task_outcome", task_id: outcome.task_id, digest: outcome.digest }
      ],
    },
  };
}

export async function updateWorkstreamContextFromCompletedTask({ store, workspaceRoot, task, goal, result } = {}) {
  const built = buildTaskOutcomeSummary({ task, goal, result });
  if (!built.eligible) return { applied: false, reason: built.reason };
  const contextStore = createWorkstreamContextStore({ workspaceRoot });
  const current = await contextStore.readSnapshot(built.outcome.workstream_id);
  const applied = applyOutcomeToSnapshot(current, built.outcome);
  if (!applied.changed) return { applied: false, reason: applied.reason, outcome: built.outcome, snapshot: applied.snapshot };
  const written = await contextStore.writeSnapshot(built.outcome.workstream_id, applied.snapshot, { expectedRevision: Number(current?.revision || 0) });
  const outcomePath = await writeOutcomeFile(workspaceRoot, built.outcome);
  if (store?.mutate) {
    await store.mutate((state) => {
      const ws = (state.workstreams || []).find((item) => item.id === built.outcome.workstream_id);
      if (ws) {
        ws.context_revision = written.revision;
        ws.context_digest = written.digest;
        ws.context_snapshot_path = `.gptwork/workstreams/${ws.id}/context.snapshot.json`;
        ws.context_updated_at = new Date().toISOString();
        ws.last_accepted_task_id = task.id;
        ws.updated_at = ws.context_updated_at;
      }
      state.activities ||= [];
      state.activities.push({
        time: new Date().toISOString(),
        type: "workstream.context_outcome_applied",
        workstream_id: built.outcome.workstream_id,
        task_id: task.id,
        revision: written.revision,
        digest: written.digest,
      });
    });
  }
  return { applied: true, outcome: built.outcome, outcome_path: outcomePath, snapshot: written };
}
