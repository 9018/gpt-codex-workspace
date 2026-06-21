export function taskToIssueBody(task) {
  let body = "## Task: " + task.title + "\n\n";
  if (task.description) body += task.description + "\n\n";
  body += "**Status**: " + task.status + "\n";
  body += "**Assignee**: " + (task.assignee || "unassigned") + "\n";
  body += "**Workspace**: " + task.workspace_id + "\n";
  body += "**Project**: " + task.project_id + "\n";
  body += "**Mode**: " + (task.mode || "builder") + "\n\n";
  if (task.logs && task.logs.length > 0) {
    body += "### Logs\n\n";
    for (const log of task.logs.slice(-10)) {
      body += "- " + log.time + ": " + log.message + "\n";
    }
    body += "\n";
  }
  if (task.artifacts && task.artifacts.length > 0) {
    body += "### Artifacts\n\n";
    for (const art of task.artifacts) {
      body += "- " + (art.label || art.path) + ": " + art.path + "\n";
    }
    body += "\n";
  }
  if (task.result) {
    body += "### Result\n\n";
    if (task.result.summary) body += task.result.summary + "\n\n";
    if (task.result.tests) body += "**Tests**: " + task.result.tests + "\n";
    if (task.result.commit) body += "**Commit**: `" + task.result.commit + "`\n";
    if (task.result.remote_head) body += "**Remote HEAD**: `" + task.result.remote_head + "`\n";
    if (Array.isArray(task.result.changed_files) && task.result.changed_files.length > 0) {
      body += "**Changed Files**: " + task.result.changed_files.join(", ") + "\n";
    }
    if (Array.isArray(task.result.warnings) && task.result.warnings.length > 0) {
      body += "**Warnings**:\n";
      for (const w of task.result.warnings) body += "- " + w + "\n";
    }
    body += "\n";
  }
  body += "---\n*Sync from GPTWork MCP*\n";
  body += "**Task ID**: `" + task.id + "`\n";
  return body;
}

export function requestToIssueBody(request) {
  let body = "## ChatGPT Request: " + request.title + "\n\n";
  body += "**Prompt**: " + request.prompt + "\n\n";
  body += "**Status**: " + request.status + "\n";
  body += "**Source**: " + request.source + "\n";
  body += "**Task ID**: " + (request.task_id || "none") + "\n\n";
  if (request.response) {
    body += "### Response\n\n" + request.response + "\n\n";
  }
  body += "---\n*Sync from GPTWork MCP*\n";
  body += "**Request ID**: `" + request.id + "`\n";
  return body;
}

export function buildResultComment(task) {
let body = "## Task " + (task.status === "completed" ? "Complete" : "Finished") + "\n\n";
body += "**Status**: " + task.status + "\n";
if (task.result) {
  if (task.result.summary) body += "**Summary**: " + task.result.summary + "\n\n";
  if (task.result.tests) body += "**Tests**: " + task.result.tests + "\n";
  if (task.result.commit) body += "**Commit**: `" + task.result.commit + "`\n";
  if (task.result.remote_head) body += "**Remote HEAD**: `" + task.result.remote_head + "`\n";
  if (Array.isArray(task.result.changed_files) && task.result.changed_files.length > 0) {
    body += "**Changed Files**: " + task.result.changed_files.join(", ") + "\n";
  }
  if (Array.isArray(task.result.warnings) && task.result.warnings.length > 0) {
    body += "**Warnings**:\n";
    for (const w of task.result.warnings) body += "- " + w + "\n";
  }
}
body += "\n---\n*Synced from GPTWork MCP*\n";
body += "**Task ID**: `" + task.id + "`\n";
return body;
}
