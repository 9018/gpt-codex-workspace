#!/usr/bin/env node

/**
 * github-actions-dispatch.mjs
 *
 * GitHub Actions dispatch bridge for GPTWork/Codex.
 * Reads the GitHub event payload from GITHUB_EVENT_PATH, identifies task
 * payloads, and dispatches them to the GPTWork MCP/backend.
 *
 * Environment variables (set by GitHub Actions workflow secrets):
 *   GITHUB_EVENT_PATH        — Path to the GitHub event payload JSON
 *   GITHUB_EVENT_NAME        — Name of the GitHub event (push, issues, workflow_dispatch)
 *   GITHUB_TOKEN             — GitHub API token for issue comments
 *   GITHUB_REPOSITORY        — owner/repo
 *   GITHUB_SHA               — Commit SHA
 *   GITHUB_RUN_ID            — Workflow run ID
 *   GITHUB_STEP_SUMMARY      — Path to step summary file
 *   GPTWORK_MCP_URL          — MCP/backend URL (e.g., http://localhost:8787/mcp)
 *   GPTWORK_MCP_TOKEN        — MCP API token
 *   GPTWORK_WORKSPACE_ROOT   — Repository workspace root path
 *   DISPATCH_PAYLOAD_PATH    — (workflow_dispatch input) explicit payload path
 *   DISPATCH_ISSUE_NUMBER    — (workflow_dispatch input) issue number to reuse
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read JSON at ${path}: ${err.message}`);
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read text at ${path}: ${err.message}`);
  }
}

function appendSummary(text) {
  const summaryPath = getEnv("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    try {
      writeFileSync(summaryPath, text + "\n", { flag: "as" });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function githubApi(path, options = {}) {
  const token = getEnv("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repo = getEnv("GITHUB_REPOSITORY");
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");

  const url = `https://api.github.com/repos/${repo}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "gptwork-dispatch/1.0",
  };

  return fetch(url, {
    method: options.method || "GET",
    headers: { ...headers, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status} on ${options.method || "GET"} ${path}: ${text.slice(0, 300)}`);
    }
    return res.json();
  });
}

async function commentOnIssue(issueNumber, body) {
  await githubApi(`/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
}

// ---------------------------------------------------------------------------
// GPTWork MCP call
// ---------------------------------------------------------------------------

/**
 * Call a GPTWork MCP tool via JSON-RPC over HTTP.
 */
async function callMcpTool(toolName, args) {
  const mcpUrl = getEnv("GPTWORK_MCP_URL");
  const mcpToken = getEnv("GPTWORK_MCP_TOKEN");

  if (!mcpUrl) {
    throw new Error("GPTWORK_MCP_URL is not configured. Cannot dispatch to MCP backend.");
  }

  const id = randomUUID();
  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id,
  };

  const headers = {
    "Content-Type": "application/json",
    "mcp-session-id": `dispatch-${id}`,
  };

  if (mcpToken) {
    headers["Authorization"] = `Bearer ${mcpToken}`;
  }

  console.log(`[dispatch] Calling MCP tool '${toolName}' at ${mcpUrl}`);

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP call failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(`MCP error: ${result.error.message || JSON.stringify(result.error)}`);
  }

  return result.result;
}

// ---------------------------------------------------------------------------
// Payload dispatch
// ---------------------------------------------------------------------------

async function dispatchZipB64(payloadPath) {
  console.log(`[dispatch] Processing .zip.b64 payload: ${payloadPath}`);

  // Read the base64-encoded ZIP
  const b64 = readText(payloadPath).trim();
  const zipBuffer = Buffer.from(b64, "base64");

  // Extract ZIP in memory to find goal.md and payload.json
  const tmpDir = `/tmp/gptwork-dispatch-${randomUUID()}`;
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Write to temp file and unzip
    const zipPath = `${tmpDir}/payload.zip`;
    writeFileSync(zipPath, zipBuffer);

    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: "pipe" });

    const goalPath = `${tmpDir}/goal.md`;
    const payloadJsonPath = `${tmpDir}/payload.json`;

    let userRequest = "";
    let goalPrompt = "";

    if (existsSync(goalPath)) {
      goalPrompt = readText(goalPath);
      userRequest = goalPrompt;
    }

    if (existsSync(payloadJsonPath)) {
      const payloadContent = readJson(payloadJsonPath);
      if (payloadContent.user_request) userRequest = payloadContent.user_request;
      if (payloadContent.goal_prompt) goalPrompt = payloadContent.goal_prompt;
    }

    if (!goalPrompt) {
      throw new Error("No goal.md or payload.json found in ZIP payload");
    }

    console.log(`[dispatch] Dispatched from ZIP: goal.md (${goalPrompt.length} chars)`);

    // Call GPTWork MCP to create the goal/task
    const result = await callMcpTool("create_goal", {
      user_request: userRequest,
      goal_prompt: goalPrompt,
      assign_to_codex: true,
    });

    return { result, dispatchedFrom: payloadPath };
  } finally {
    // Clean up tmp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function dispatchTaskMarkdown(payloadPath) {
  console.log(`[dispatch] Processing task markdown: ${payloadPath}`);

  const content = readText(payloadPath);

  // Parse YAML frontmatter if present
  let userRequest = content;
  let goalPrompt = content;

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    goalPrompt = frontmatterMatch[2].trim();
    const titleMatch = frontmatter.match(/title:\s*(.+)/i);
    if (titleMatch) {
      userRequest = titleMatch[1];
    } else {
      userRequest = goalPrompt.split("\n")[0] || goalPrompt;
    }
  } else {
    userRequest = content.split("\n")[0] || content;
  }

  console.log(`[dispatch] Dispatched from markdown: ${payloadPath}`);

  const result = await callMcpTool("create_goal", {
    user_request: userRequest,
    goal_prompt: goalPrompt,
    assign_to_codex: true,
  });

  return { result, dispatchedFrom: payloadPath };
}

async function dispatchPayload(payloadPath) {
  if (payloadPath.endsWith(".zip.b64")) {
    return dispatchZipB64(payloadPath);
  }

  if (payloadPath.endsWith(".md") || payloadPath.endsWith("-task.md") || payloadPath.endsWith("-restore.md")) {
    return dispatchTaskMarkdown(payloadPath);
  }

  throw new Error(`Unknown payload file type: ${payloadPath}`);
}

// ---------------------------------------------------------------------------
// Event-specific handlers
// ---------------------------------------------------------------------------

/**
 * Handle push events — find files under .gptwork/goal-inbox/**
 */
async function handlePush(payload) {
  const workspaceRoot = getEnv("GPTWORK_WORKSPACE_ROOT", process.cwd());

  // Aggregate added/modified files from ALL commits in the push to avoid
  // missing payload files that appear only in non-head commits.
  const commits = payload.commits || (payload.head_commit ? [payload.head_commit] : []);
  const changedSet = new Set();
  for (const commit of commits) {
    for (const f of [...(commit.added || []), ...(commit.modified || [])]) {
      if (f.startsWith(".gptwork/goal-inbox/")) {
        changedSet.add(f);
      }
    }
  }
  const changed = [...changedSet];

  if (changed.length === 0) {
    console.log("[dispatch] Push event: no files changed under .gptwork/goal-inbox/");
    appendSummary("### GPTWork Dispatch: Push skipped\n\nNo files changed under `.gptwork/goal-inbox/`.");
    return { handled: false, reason: "no_gptwork_files" };
  }

  console.log(`[dispatch] Push event: changed files under goal-inbox:\n  ${changed.join("\n  ")}`);

  // Prefer .zip.b64 files, otherwise use -task.md
  const zipB64Files = changed.filter((f) => f.endsWith(".zip.b64"));
  const taskMdFiles = changed.filter((f) => f.endsWith("-task.md"));
  const restoreMdFiles = changed.filter((f) => f.endsWith("-restore.md"));

  let selectedPath = null;

  if (zipB64Files.length > 0) {
    selectedPath = zipB64Files[0];
  } else if (taskMdFiles.length > 0) {
    selectedPath = taskMdFiles[0];
  } else if (restoreMdFiles.length > 0) {
    selectedPath = restoreMdFiles[0];
  }

  if (!selectedPath) {
    console.log("[dispatch] No dispatchable payload file found.");
    appendSummary("### GPTWork Dispatch: Push skipped\n\nNo dispatchable payload file found in changed files.");
    return { handled: false, reason: "no_payload_file" };
  }

  const fullPath = selectedPath.startsWith("/") ? selectedPath : `${workspaceRoot}/${selectedPath}`;
  console.log(`[dispatch] Full payload path: ${fullPath}`);

  const result = await dispatchPayload(fullPath);

  // Write step summary
  const sha = getEnv("GITHUB_SHA", payload.after || "unknown").slice(0, 12);
  const summary = [
    "### GPTWork Dispatch: Push processed",
    "",
    `- **Payload**: \`${selectedPath}\``,
    `- **Commit**: \`${sha}\``,
    `- **Status**: dispatched`,
    `- **Time**: ${new Date().toISOString()}`,
    `- **Workflow Run**: ${getEnv("GITHUB_RUN_ID", "?")}`,
  ].join("\n");
  appendSummary(summary);

  return { handled: true, result };
}

/**
 * Handle issues events — only process if the issue has the gptwork-task label.
 */
async function handleIssues(payload) {
  const issue = payload.issue;
  if (!issue) {
    console.log("[dispatch] Issues event: no issue in payload");
    return { handled: false, reason: "no_issue" };
  }

  const labels = (issue.labels || []).map((label) =>
    typeof label === "string" ? label : (label.name || "")
  );

  const isDispatchLabel = labels.some((l) => l === "gptwork-dispatch" || l === "gptwork-payload");
  const isRegularTaskLabel = labels.some((l) => l === "gptwork-task");

  if (!isDispatchLabel) {
    if (isRegularTaskLabel) {
      console.log(`[dispatch] Issue #${issue.number} has gptwork-task label but no dispatch/payload label — skipping (regular task issues are handled by sync_from_github).`);
      appendSummary(`### GPTWork Dispatch: Skipped\n\nIssue #${issue.number} has \`gptwork-task\` label (no dispatch/payload label). Regular task issues are handled by \`sync_from_github\`. Skipping dispatch.`);
    } else {
      console.log(`[dispatch] Issue #${issue.number} does not have dispatch/payload label, skipping.`);
    }
    return { handled: false, reason: "no_dispatch_label" };
  }

  console.log(`[dispatch] Processing issue #${issue.number} with dispatch/payload label`);

  const body = issue.body || "";
  const workspaceRoot = getEnv("GPTWORK_WORKSPACE_ROOT", process.cwd());

  // Parse issue body for payload references
  const zipMatch = body.match(/ZIP\s*base64:\s*`([^`]+)`|ZIP\s*base64:\s*([^\s]+)/i);
  const restoreMatch = body.match(/Restore\s+instructions:\s*`([^`]+)`|Restore\s+instructions:\s*([^\s]+)/i);
  const fallbackMatch = body.match(/Fallback\s+queued\s+task\s+file:\s*`([^`]+)`|Fallback\s+queued\s+task\s+file:\s*([^\s]+)/i);

  let payloadPath = null;

  // Prefer ZIP base64 file
  if (zipMatch) {
    payloadPath = zipMatch[1] || zipMatch[2];
  } else if (restoreMatch) {
    const restorePath = restoreMatch[1] || restoreMatch[2];
    const fullRestorePath = restorePath.startsWith("/")
      ? restorePath
      : `${workspaceRoot}/${restorePath}`;

    if (existsSync(fullRestorePath)) {
      const restoreContent = readText(fullRestorePath);
      const payloadInRestore = restoreContent.match(/`([^`]+\.zip\.b64)`/);
      if (payloadInRestore) {
        payloadPath = payloadInRestore[1];
      }
    }
  } else if (fallbackMatch) {
    payloadPath = fallbackMatch[1] || fallbackMatch[2];
  }

  if (!payloadPath) {
    console.log(`[dispatch] Issue #${issue.number} has dispatch label but no payload reference found in body. Skipping.`);
    appendSummary(`### GPTWork Dispatch: Skipped\n\nIssue #${issue.number} has dispatch label but no payload reference found.`);
    return { handled: false, reason: "no_payload_ref" };
  }

  // Resolve payload path
  const fullPayloadPath = payloadPath.startsWith("/")
    ? payloadPath
    : `${workspaceRoot}/${payloadPath}`;

  if (!existsSync(fullPayloadPath)) {
    console.log(`[dispatch] Payload file not found at ${payloadPath}. Skipping.`);
    appendSummary(`### GPTWork Dispatch: Skipped\n\nPayload file not found at \`${payloadPath}\`.`);
    return { handled: false, reason: "payload_not_found" };
  }

  const result = await dispatchPayload(fullPayloadPath);

  // Comment on issue
  const sha = getEnv("GITHUB_SHA", "unknown").slice(0, 12);
  const comment = [
    "GPTWork dispatch queued",
    "",
    `- **Payload**: \`${payloadPath}\``,
    `- **Commit**: \`${sha}\``,
    `- **Status**: dispatched`,
    `- **Time**: ${new Date().toISOString()}`,
    `- **Workflow Run**: ${getEnv("GITHUB_RUN_ID", "?")}`,
  ].join("\n");

  await commentOnIssue(issue.number, comment);
  return { handled: true, result };
}

/**
 * Handle workflow_dispatch events.
 */
async function handleWorkflowDispatch(payload) {
  const inputs = payload.inputs || {};
  const workspaceRoot = getEnv("GPTWORK_WORKSPACE_ROOT", process.cwd());

  // Prefer explicit payload_path
  let payloadPath = getEnv("DISPATCH_PAYLOAD_PATH") || inputs.payload_path;

  if (payloadPath) {
    const fullPayloadPath = payloadPath.startsWith("/")
      ? payloadPath
      : `${workspaceRoot}/${payloadPath}`;

    if (!existsSync(fullPayloadPath)) {
      throw new Error(`DISPATCH_PAYLOAD_PATH file not found: ${payloadPath}`);
    }

    console.log(`[dispatch] workflow_dispatch: using payload_path=${payloadPath}`);
    const result = await dispatchPayload(fullPayloadPath);

    const sha = getEnv("GITHUB_SHA", "unknown").slice(0, 12);
    const summary = [
      "### GPTWork Dispatch: Manual triggered",
      "",
      `- **Payload**: \`${payloadPath}\``,
      `- **Commit**: \`${sha}\``,
      `- **Status**: dispatched`,
      `- **Time**: ${new Date().toISOString()}`,
      `- **Workflow Run**: ${getEnv("GITHUB_RUN_ID", "?")}`,
    ].join("\n");
    appendSummary(summary);

    return { handled: true, result };
  }

  // If only issue_number is provided, fetch issue and apply issue parsing
  const issueNumber = getEnv("DISPATCH_ISSUE_NUMBER") || inputs.issue_number;

  if (issueNumber) {
    console.log(`[dispatch] workflow_dispatch: fetching issue #${issueNumber}`);

    const issue = await githubApi(`/issues/${issueNumber}`);
    const labels = (issue.labels || []).map((label) =>
      typeof label === "string" ? label : (label.name || "")
    );

    if (!labels.includes("gptwork-dispatch") && !labels.includes("gptwork-payload")) {
      const msg = `Issue #${issueNumber} does not have dispatch/payload label, skipping.`;
      console.log(`[dispatch] ${msg}`);
      return { handled: false, reason: "no_dispatch_label" };
    }

    // Reuse the issue handler logic by constructing a fake payload
    const fakePayload = { issue };
    return handleIssues(fakePayload);
  }

  console.log("[dispatch] workflow_dispatch: no payload_path or issue_number provided, nothing to do.");
  appendSummary("### GPTWork Dispatch: Manual triggered\n\nNo `payload_path` or `issue_number` input provided. Nothing to do.");
  return { handled: false, reason: "no_inputs" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("GPTWork Dispatch Bridge");
  console.log("=".repeat(60));
  console.log(`Event: ${getEnv("GITHUB_EVENT_NAME", "?")}`);
  console.log(`Repo:  ${getEnv("GITHUB_REPOSITORY", "?")}`);
  console.log(`SHA:   ${getEnv("GITHUB_SHA", "?").slice(0, 12)}`);
  console.log("");

  const eventName = getEnv("GITHUB_EVENT_NAME");
  const eventPath = getEnv("GITHUB_EVENT_PATH");

  if (!eventPath || !existsSync(eventPath)) {
    console.log("[dispatch] No GITHUB_EVENT_PATH, nothing to dispatch.");
    return;
  }

  const payload = readJson(eventPath);

  let result;

  try {
    if (eventName === "push") {
      result = await handlePush(payload);
    } else if (eventName === "issues") {
      result = await handleIssues(payload);
    } else if (eventName === "workflow_dispatch") {
      result = await handleWorkflowDispatch(payload);
    } else {
      console.log(`[dispatch] Unknown event: ${eventName}, nothing to do.`);
      return;
    }

    if (result?.handled) {
      console.log("[dispatch] Successfully dispatched.");
    } else {
      console.log(`[dispatch] Not handled: ${result?.reason || "unknown"}`);
    }
  } catch (err) {
    console.error(`[dispatch] Error: ${err.message}`);
    console.error(err.stack);

    // Try to comment on the triggering issue
    if (eventName === "issues" && payload.issue) {
      try {
        await commentOnIssue(payload.issue.number, `GPTWork dispatch failed: ${err.message}`);
      } catch {
        // best effort
      }
    }

    appendSummary(`### GPTWork Dispatch: Failed\n\n\`\`\`\n${err.message}\n\`\`\``);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[dispatch] Unhandled error: ${err.message}`);
  process.exit(1);
});
