import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskContextStore } from "../src/context-contract/task-context-store.mjs";
import { createWorkstreamContextStore } from "../src/workstream/workstream-context-store.mjs";
import { buildContextPreviewV2 } from "../src/context-preview-v2.mjs";

test("context preview v2 exposes task/workstream/raw/role view isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-preview-v2-"));
  const goalId = "goal_preview";
  const packet = {
    schema_version: "gptwork.task_context.v1",
    identity: { workstream_id: "ws_preview", goal_id: goalId, task_id: "task_preview", context_revision: 2 },
    objective: "Preview bounded context", background: [], confirmed_findings: [], scope: { include: [], exclude: [] }, required_changes: [],
    acceptance_criteria: [{ id: "ac", description: "visible", blocking: true, verification_hint: null }], constraints: [], open_questions: [], carry_forward: [], source_provenance: [],
    raw_conversation_policy: { stored: true, indexed: false, injected: false, targeted_lookup_allowed: true }
  };
  await createTaskContextStore({ workspaceRoot: root }).writePacket(`.gptwork/goals/${goalId}`, packet);
  await createWorkstreamContextStore({ workspaceRoot: root }).writeSnapshot("ws_preview", {
    schema_version: "gptwork.workstream_context.v1", revision: 3, objective: "ws", durable_decisions: [], delivered_capabilities: [], open_blockers: [], repository_state: {}, accepted_outcomes: [{ task_id: "old" }], deprecated_facts: [], generated_from: []
  }, { expectedRevision: 0 });
  const rolesDir = join(root, ".gptwork", "goals", goalId, "roles");
  await mkdir(rolesDir, { recursive: true });
  await writeFile(join(rolesDir, "builder.view.json"), JSON.stringify({ role: "builder", view_digest: "sha256:view", included_sections: ["objective"], excluded_sources: ["raw_chatgpt_transcript"], permissions: { write_product_code: true } }));
  await writeFile(join(root, ".gptwork", "goals", goalId, "context.manifest.json"), JSON.stringify({ excluded_sources: [{ reason: "raw_conversation_default_excluded" }], source_policy: { include_raw_conversation: false } }));

  const preview = await buildContextPreviewV2({
    workspaceRoot: root,
    task: { id: "task_preview", goal_id: goalId, workstream_id: "ws_preview", task_context_digest: "sha256:task", task_context_revision: 2, pipeline_version: "task_pipeline_v2" },
    goal: { id: goalId, workstream_id: "ws_preview", task_context: { contract_digest: "sha256:task", revision: 2 } },
    contextJson: { size_metrics: { transcript_bytes: 123, transcript_message_count: 4 } }
  });
  assert.equal(preview.task_context.present, true);
  assert.equal(preview.workstream_context.revision, 3);
  assert.equal(preview.raw_conversation.stored, true);
  assert.equal(preview.raw_conversation.injected, false);
  assert.equal(preview.role_views[0].role, "builder");
  assert.ok(preview.role_views[0].excluded_sources.includes("raw_chatgpt_transcript"));
  assert.equal(preview.excluded_sources[0].reason, "raw_conversation_default_excluded");
});
