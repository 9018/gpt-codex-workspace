import { basename } from "node:path";

/**
 * Build the workspace file paths for a given goal.
 * @param {object} goal
 * @returns {{ dir: string, goal_md: string, context_json: string, transcript_md: string, result_md: string, payload_json: string, payload_base64: string, bundle_zip: string, attachments_dir: string }}
 */
export function goalWorkspaceFiles(goal) {
  const dir = `.gptwork/goals/${goal.id}`;
  return {
    dir,
    goal_md: `${dir}/goal.md`,
    context_json: `${dir}/context.json`,
    transcript_md: `${dir}/transcript.md`,
    result_md: `${dir}/result.md`,
    payload_json: `${dir}/payload.json`,
    payload_base64: `${dir}/payload.base64`,
    bundle_zip: `${dir}/bundle.zip`,
    attachments_dir: `${dir}/attachments`
  };
}

/**
 * Return the subset of workspace file paths visible to public MCP responses.
 * @param {object} goal
 * @param {object} [payload={}]
 * @returns {{ dir: string, goal_md: string, result_md: string } | { dir: string, goal_md: string, result_md: string, attachments_dir: string }}
 */
export function publicGoalWorkspaceFiles(goal, payload = {}) {
  const files = goalWorkspaceFiles(goal);
  const visible = {
    dir: files.dir,
    goal_md: files.goal_md,
    result_md: files.result_md
  };
  if (hasGoalBundles(payload)) visible.attachments_dir = files.attachments_dir;
  return visible;
}

/**
 * Return the subset of workspace file paths that are internal only.
 * @param {object} goal
 * @param {object} [payload={}]
 * @returns {{ context_json: string, transcript_md: string, payload_json: string, payload_base64: string } | { context_json: string, transcript_md: string, payload_json: string, payload_base64: string, attachments_dir: string }}
 */
export function internalGoalWorkspaceFiles(goal, payload = {}) {
  const files = goalWorkspaceFiles(goal);
  const internal = {
    context_json: files.context_json,
    transcript_md: files.transcript_md,
    payload_json: files.payload_json,
    payload_base64: files.payload_base64
  };
  if (hasGoalBundles(payload)) internal.attachments_dir = files.attachments_dir;
  return internal;
}

/**
 * Check whether a payload contains any ZIP bundles.
 * @param {object} [payload={}]
 * @returns {boolean}
 */
export function hasGoalBundles(payload = {}) {
  return Array.isArray(payload.bundles) && payload.bundles.some((bundle) => bundle?.zip_base64);
}

/**
 * Render the goal.md workspace file content.
 * @param {object} goal
 * @param {object} conversation
 * @param {Array} memories
 * @param {object} task
 * @param {object} workspaceFiles
 * @returns {string}
 */
export function renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) {
  return [
    `# GPTWork Goal ${goal.id}`,
    "",
    `Title: ${goal.title}`,
    `Status: ${goal.status}`,
    `Mode: ${goal.mode}`,
    `Workspace: ${goal.workspace_id}`,
    task ? `Task: ${task.id}` : "Task: none",
    "",
    "## User Request",
    "",
    goal.user_request || "(none)",
    "",
    "## GPTChat Preview",
    "",
    goal.preview_text || "(none)",
    "",
    "## Goal Prompt",
    "",
    goal.goal_prompt || "(none)",
    "",
    "## Context Summary",
    "",
    goal.context_summary || "(none)",
    "",
    "## Workspace Files",
    "",
    `- context: ${workspaceFiles.context_json}`,
    `- transcript: ${workspaceFiles.transcript_md}`,
    `- result: ${workspaceFiles.result_md}`,
    "",
    "## Memories",
    "",
    ...(memories.length ? memories.map((memory) => `- ${memory.key}: ${memory.value}`) : ["(none)"]),
    "",
    '## Autonomy Policy',
    '',
    `Mode: ${goal.autonomy_policy?.mode || 'subagent_first'}`,
    `GPT question budget: ${goal.autonomy_policy?.gpt_question_budget ?? 0}`,
    `Default decision rule: ${goal.autonomy_policy?.default_decision_rule || 'choose the smallest reversible goal-aligned change.'}`,
    '',
    'Do not ask ChatGPT for implementation decisions.',
    'Use Codex subagents to resolve uncertainty.',
    '',
    '## Subagent Policy',
    '',
    'Required roles:',
    ...(Array.isArray(goal.subagent_policy?.roles) ? goal.subagent_policy.roles.map(r => `- ${r}`) : ['- analyst', '- architect', '- implementer', '- tester', '- reviewer', '- escalation_judge']),
    '',
    "## Execution Contract",
    "",
    "Read context.json and transcript.md before acting. Execute the goal prompt, update result.md, and append progress with append_goal_message."
  ].join("\n");
}

/**
 * Render the transcript.md workspace file content.
 * @param {object} goal
 * @param {object} conversation
 * @returns {string}
 */
export function renderTranscriptMarkdown(goal, conversation) {
  const messages = conversation?.messages || [];
  return [
    `# Transcript for ${goal.id}`,
    "",
    ...messages.flatMap((message) => [
      `## ${message.role} - ${message.created_at}`,
      "",
      message.content || "",
      ""
    ])
  ].join("\n");
}

/**
 * Build the codex_instruction string embedded in context.json.
 * @param {object} goal
 * @returns {string}
 */
export function codexInstruction(goal) {
  const files = goalWorkspaceFiles(goal);
  const ap = goal.autonomy_policy || {};
  return [
    "You are executing a GPTWork encoded/shared goal.",
    `Read ${files.goal_md}, ${files.context_json}, and ${files.transcript_md} before acting.`,
    "Follow goal.md exactly, write result.md, and append progress/results with append_goal_message.",
    "",
    "## Execution Requirements",
    "",
    "You are the parent Codex agent.",
    "You must use subagent-first autonomous execution.",
    "",
    "Before asking ChatGPT:",
    "1. Use internal subagents to analyze the issue.",
    "2. Compare options.",
    "3. Choose the smallest reversible goal-aligned change.",
    "4. Continue execution unless the issue is a product/user decision.",
    "",
    "You must not ask ChatGPT for:",
    "- code navigation",
    "- implementation choices",
    "- test failures",
    "- refactoring choices",
    "- local verification strategy",
    "",
    "Only ask ChatGPT for:",
    "- contradictory requirements",
    "- product behavior decisions",
    "- destructive changes",
    "- public API breaking changes",
    "- production approval",
    "- credential/account/billing access",
  ].join("\n");
}

/**
 * Sanitize a bundle file name.
 * @param {string} name
 * @returns {string}
 */
export function safeBundleName(name) {
  return basename(String(name || "bundle.zip")).replace(/[^A-Za-z0-9._-]/g, "_") || "bundle.zip";
}
