import { buildCodexPrompt } from "./codex-prompt-builder.mjs";
import { fireHeartbeat, initRun } from "./codex-run-metadata.mjs";
import { writeTaskPromptFile } from "./gptwork-tmp.mjs";

export async function prepareCodexTaskRun({
  task,
  goal,
  workspaceFiles,
  workspaceRoot,
  config,
}) {
  const { fullPrompt } = buildCodexPrompt({
    task,
    goal,
    workspaceFiles,
    workspaceRoot,
    defaultRepoPath: config.defaultRepoPath,
  });

  // Write prompt to managed tmp directory with ENOSPC recovery
  const promptFile = await writeTaskPromptFile({
    workspaceRoot: config.defaultWorkspaceRoot,
    taskId: task.id,
    content: fullPrompt,
  });

  let runFilePath = null;
  let runId = null;
  try {
    const initResult = await initRun({
      workspaceRoot: config.defaultWorkspaceRoot,
      taskId: task.id,
      workspaceId: task.workspace_id,
      repoPath: config.defaultRepoPath,
      promptPath: promptFile,
    });
    runFilePath = initResult.runFilePath;
    runId = initResult.runId;
    let promptBytes = 0;
    try { const { stat } = await import("node:fs/promises"); promptBytes = (await stat(promptFile)).size; } catch {}
    fireHeartbeat(runFilePath, "running_codex", {
      prompt_bytes: promptBytes,
      first_output_timeout_seconds: config.codexFirstOutputTimeout || 180,
      stdout_bytes: 0,
      stderr_bytes: 0,
    });
  } catch {}

  return { promptFile, runFilePath, runId };
}
