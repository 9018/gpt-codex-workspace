import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Build the workspace file paths for a given goal.
 * @param {object} goal
 * @returns {{ dir: string, goal_md: string, context_json: string, transcript_md: string, result_md: string, payload_json: string, payload_base64: string, bundle_zip: string, attachments_dir: string, context_bundle_md: string, context_retrieval_json: string }}
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
    attachments_dir: `${dir}/attachments`,
    context_bundle_md: `${dir}/context.bundle.md`,
    context_retrieval_json: `${dir}/context.retrieval.json`
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
    context_bundle_md: files.context_bundle_md,
    context_retrieval_json: files.context_retrieval_json,
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
  const lines = [
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
  ];

  // Add context bundle reference if available
  if (workspaceFiles.context_bundle_md) {
    lines.push(`- context bundle: ${workspaceFiles.context_bundle_md} (prefer over transcript for initial context)`);
  }

  lines.push(
    "",
    "## Memories",
    "",
    ...(memories.length ? memories.map((memory) => `- ${memory.key}: ${memory.value}`) : ["(none)"]),
    "",
    "## Autonomy Policy",
    "",
    `Mode: ${goal.autonomy_policy?.mode || 'subagent_first'}`,
    `GPT question budget: ${goal.autonomy_policy?.gpt_question_budget ?? 0}`,
    `Default decision rule: ${goal.autonomy_policy?.default_decision_rule || 'choose the smallest reversible goal-aligned change.'}`,
    "",
    "Do not ask ChatGPT for implementation decisions.",
    "Use Codex subagents to resolve uncertainty.",
    "",
    "## Subagent Policy",
    "",
    "Required roles:",
    ...(Array.isArray(goal.subagent_policy?.roles) ? goal.subagent_policy.roles.map(r => `- ${r}`) : ["- analyst", "- architect", "- implementer", "- tester", "- reviewer", "- escalation_judge"]),
    "",
    "## Execution Contract",
    "",
    "Read context.json and goal.md before acting. Prefer context.bundle.md over transcript.md for initial context.",
    "Execute the goal prompt, update result.md, and append progress with append_goal_message."
  );

  return lines.join("\n");
}

/**
 * Try to load an existing context.bundle.md for inspection.
 * Returns null if the file does not exist or is unreadable.
 *
 * @param {string} workspaceRoot - Absolute workspace root.
 * @param {object} goal - Goal object.
 * @returns {Promise<string|null>}
 */
export async function loadContextBundle(workspaceRoot, goal) {
  if (!goal || !goal.id) return null;
  const path = `.gptwork/goals/${goal.id}/context.bundle.md`;
  const abs = workspaceRoot ? `${workspaceRoot.replace(/\/+$/, "")}/${path}` : path;
  try {
    if (!existsSync(abs)) return null;
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
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
 * Render a single message as a transcript.md append-only fragment.
 * @param {{ role: string, content: string, created_at: string }} message
 * @returns {string}
 */
export function renderTranscriptMessageAppend(message) {
  return `\n## ${message.role} - ${message.created_at}\n\n${message.content || ""}\n`;
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
    "You are executing a GPTWork encoded/shared goal. A context bundle may be available",
    `at ${files.context_bundle_md} \u2014 prefer it over the full transcript for initial context.`,
    `Read ${files.goal_md} and ${files.context_json} before acting.`,
    `Read ${files.context_bundle_md} first when present; use ${files.transcript_md} only for explicit deep lookup when the bundle is insufficient.`,
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
