import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTaskContextStore } from "./context-contract/task-context-store.mjs";
import { createWorkstreamContextStore } from "./workstream/workstream-context-store.mjs";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function fileBytes(path) {
  try { return (await stat(path)).size; } catch { return 0; }
}

export async function buildContextPreviewV2({ workspaceRoot, task = {}, goal = {}, contextJson = null } = {}) {
  const goalId = goal?.id || task?.goal_id || null;
  const goalDir = goalId ? join(workspaceRoot, ".gptwork", "goals", goalId) : null;
  let packet = null;
  let manifest = null;
  let roleViews = [];
  if (goalDir) {
    packet = await createTaskContextStore({ workspaceRoot }).readPacket(`.gptwork/goals/${goalId}`);
    manifest = await readJson(join(goalDir, "context.manifest.json"));
    try {
      const entries = await readdir(join(goalDir, "roles"));
      for (const name of entries.filter((item) => item.endsWith(".view.json")).sort()) {
        const path = join(goalDir, "roles", name);
        const view = await readJson(path);
        if (!view) continue;
        roleViews.push({
          role: view.role || name.replace(/\.view\.json$/, ""),
          path: `.gptwork/goals/${goalId}/roles/${name}`,
          bytes: await fileBytes(path),
          view_digest: view.view_digest || null,
          included_sections: view.included_sections || [],
          excluded_sources: view.excluded_sources || [],
          permissions: view.permissions || {},
        });
      }
    } catch {}
  }

  const workstreamId = task.workstream_id || goal.workstream_id || packet?.identity?.workstream_id || null;
  const workstreamSnapshot = workstreamId
    ? await createWorkstreamContextStore({ workspaceRoot }).readSnapshot(workstreamId).catch(() => null)
    : null;
  const transcriptBytes = Number(contextJson?.size_metrics?.transcript_bytes || contextJson?.transcript_bytes || 0);
  const messageCount = Number(contextJson?.size_metrics?.transcript_message_count || contextJson?.transcript_message_count || 0);
  const rawPolicy = packet?.raw_conversation_policy || {
    stored: messageCount > 0,
    indexed: null,
    injected: task.raw_conversation_injected === true || goal.task_context?.raw_conversation_injected === true,
    targeted_lookup_allowed: null,
  };
  const warnings = [];
  if (!packet && task.pipeline_version === "task_pipeline_v2") warnings.push({ code: "task_context_missing", message: "task_pipeline_v2 has no persisted task.context.json" });
  if (packet && task.task_context_digest && task.task_context_digest !== goal.task_context?.contract_digest) {
    warnings.push({ code: "task_context_binding_mismatch", message: "Task and Goal context digests differ." });
  }
  if (packet?.raw_conversation_policy?.injected === true) warnings.push({ code: "raw_conversation_injected", message: "Raw conversation is injected into execution context." });
  if (workstreamId && !workstreamSnapshot) warnings.push({ code: "workstream_context_missing", message: "Workstream has no context snapshot yet." });

  return {
    schema_version: "gptwork.context_preview.v2",
    task_context: {
      present: Boolean(packet),
      schema_version: packet?.schema_version || goal.task_context?.schema_version || null,
      revision: packet?.identity?.context_revision || task.task_context_revision || goal.task_context?.revision || null,
      digest: task.task_context_digest || goal.task_context?.contract_digest || null,
      objective: packet?.objective || null,
      path: goalId ? `.gptwork/goals/${goalId}/task.context.json` : null,
    },
    workstream_context: {
      id: workstreamId,
      present: Boolean(workstreamSnapshot),
      revision: workstreamSnapshot?.revision || null,
      digest: workstreamSnapshot?.digest || null,
      accepted_outcomes: workstreamSnapshot?.accepted_outcomes?.length || 0,
      path: workstreamId ? `.gptwork/workstreams/${workstreamId}/context.snapshot.json` : null,
    },
    raw_conversation: {
      stored: rawPolicy.stored === true,
      indexed: rawPolicy.indexed === true,
      injected: rawPolicy.injected === true,
      targeted_lookup_allowed: rawPolicy.targeted_lookup_allowed === true,
      message_count: messageCount,
      bytes: transcriptBytes,
    },
    role_views: roleViews,
    excluded_sources: manifest?.excluded_sources || manifest?.selection?.excluded_sources || [],
    source_policy: manifest?.source_policy || null,
    freshness: {
      task_context_bound: Boolean(task.task_context_digest || goal.task_context?.contract_digest),
      role_views_bound: roleViews.every((view) => Boolean(view.view_digest)),
    },
    warnings,
  };
}
