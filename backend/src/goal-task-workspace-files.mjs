import { randomUUID } from "node:crypto";
import { defaultTokenContext } from "./auth-context.mjs";
import { goalWorkspaceFiles, renderGoalMarkdown, renderTranscriptMarkdown, renderCodexEntryMarkdown, codexInstruction, safeBundleName } from "./goal-files.mjs";
import { workspaceUploadBundleBase64, writeWorkspaceTextInternal } from "./workspace-service.mjs";

/**
 * Write initial workspace files for a goal/task.
 *
 * After writing the core files (goal.md, context.json, transcript, payload, result),
 * attempts to build a context bundle via the context-index hooks.
 * If context-index module is not available or fails, the bundle step is skipped
 * silently — it does not break existing behavior.
 */
export async function writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, extras = {}, context = defaultTokenContext("system")) {
  const workspaceFiles = goalWorkspaceFiles(goal);
  const appendTranscript = extras.append_transcript === true;
  const skipPayload = extras.skip_payload === true;

  // Always write goal.md for compatibility
  const files = [
    { path: workspaceFiles.codex_entry_md, content: renderCodexEntryMarkdown(goal, conversation, memories, task, workspaceFiles) },
    { path: workspaceFiles.goal_md, content: renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) },
    { path: workspaceFiles.context_json, content: JSON.stringify({ goal, conversation, memories, task, workspace_files: workspaceFiles, codex_instruction: codexInstruction(goal) }, null, 2) },
  ];

  if (goal.acceptance_contract) {
    files.push({ path: workspaceFiles.acceptance_contract_json, content: JSON.stringify(goal.acceptance_contract, null, 2) });
  }

  // Skip payload files during append-only operations (P0.2)
  if (!skipPayload) {
    const payload = extras.payload || {
      user_request: goal.user_request,
      goal_prompt: goal.goal_prompt,
      context_summary: goal.context_summary,
      mode: goal.mode,
      workspace_id: goal.workspace_id,
      messages: conversation?.messages || [],
      autonomy_policy: goal.autonomy_policy,
      subagent_policy: goal.subagent_policy,
      acceptance_contract: goal.acceptance_contract,
      memories
    };
    const payloadJson = JSON.stringify(payload, null, 2);
    const payloadBase64 = extras.payload_base64 || Buffer.from(payloadJson, "utf8").toString("base64");
    files.push(
      { path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) },
      { path: workspaceFiles.payload_json, content: payloadJson },
      { path: workspaceFiles.payload_base64, content: payloadBase64 }
    );
  } else if (!appendTranscript) {
    // When !skipPayload and !appendTranscript, write transcript normally
    files.push({ path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) });
  }
  // When appendTranscript && skipPayload, transcript is handled by caller via appendFile

  if (extras.initialize_result || typeof extras.result_content === "string") {
    files.push({ path: workspaceFiles.result_md, content: typeof extras.result_content === "string" ? extras.result_content : "# Result\n\nPending.\n" });
  }
  for (const file of files) {
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, file.path, file.content, context);
  }
  for (const bundle of Array.isArray(extras.bundles) ? extras.bundles : []) {
    if (!bundle?.zip_base64) continue;
    const name = safeBundleName(bundle.name || `bundle-${randomUUID()}.zip`);
    const zipPath = `${workspaceFiles.attachments_dir}/${name}`;
    await workspaceUploadBundleBase64(store, config, { path: zipPath, zip_base64: bundle.zip_base64, overwrite: true, extract: true, target_dir: `${workspaceFiles.attachments_dir}/${name.replace(/\.zip$/i, "")}`, sha256_expected: bundle.sha256, workspace_id: goal.workspace_id }, context);
  }

  // ---------------------------------------------------------------
  // P0.5: Attempt to build context bundle via context-index hooks.
  // This is best-effort — failures are logged but do not propagate.
  // ---------------------------------------------------------------
  try {
    const { maybeBuildContextBundle } = await import("./context-index/context-index-hooks.mjs");
    const bundleResult = await maybeBuildContextBundle(
      store, config, goal, conversation, task, workspaceFiles, context
    );
    if (bundleResult.ok && bundleResult.bundle) {
      await writeWorkspaceTextInternal(
        store, config, goal.workspace_id,
        workspaceFiles.context_bundle_md,
        bundleResult.bundle,
        context
      );
      if (bundleResult.retrievalJson) {
        await writeWorkspaceTextInternal(
          store, config, goal.workspace_id,
          workspaceFiles.context_retrieval_json,
          JSON.stringify(bundleResult.retrievalJson, null, 2),
          context
        );
      }
      if (bundleResult.contextManifest) {
        await writeWorkspaceTextInternal(
          store, config, goal.workspace_id,
          workspaceFiles.context_manifest_json,
          JSON.stringify(bundleResult.contextManifest, null, 2),
          context
        );
      }
    } else if (bundleResult.warning) {
      console.warn("[context-index] bundle build skipped:", bundleResult.warning);
    }
  } catch (err) {
    // Context-index is optional; if the module or any dep is missing,
    // or if bundle generation itself fails, log a warning and continue.
    console.warn("[context-index] bundle build unavailable or failed:", err.message);
  }

  return workspaceFiles;
}
