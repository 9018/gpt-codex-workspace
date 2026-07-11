/**
 * workstream-card-view-model.mjs — Card View Model builder for
 * workstream_status tool results.
 *
 * Converts raw workstream data into the unified gptwork-card-v1
 * view model used by widget.html and legacy fallback rendering.
 *
 * Sections covered:
 *   1. Workstream Summary          — identity, phase, iteration
 *   2. Execution Graph (DAG)       — nodes, edges, ready/blocked nodes
 *   3. Task Execution              — task list, status distribution
 *   4. TUI / Subagent Progress     — active sessions, subagent count
 *   5. Acceptance & Repair         — verdict, checks, repair budget
 *   6. Open ChatGPT Requests       — pending decisions, escalations
 *   7. Diagnostics / Blockers      — warnings, errors
 *   8. Next Actions                — suggested actions for the user
 */

const CARD_VERSION = "gptwork-card-v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function str(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function short(value, length = 12) {
  const text = str(value, "-");
  return text.length > length ? text.slice(0, length) : text;
}

function truncate(value, length = 140) {
  const text = str(value, "");
  return text.length > length ? text.slice(0, Math.max(0, length - 3)) + "..." : text;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countsText(counts) {
  return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ");
}

function severityFromStatus(status, fallback = "info") {
  const s = str(status).toLowerCase();
  if (["ok", "pass", "passed", "completed", "success", "healthy", "enabled", "clean", "true", "planned"].includes(s)) return "ok";
  if (["warn", "warning", "waiting", "pending", "in_progress", "running", "stalled", "overdue", "drifted"].includes(s)) return "warning";
  if (["fail", "failed", "error", "crashed", "blocked", "false", "cancelled"].includes(s)) return "error";
  return fallback;
}

function normalizeDiagnostic(item, defaultSeverity = "warning") {
  if (typeof item === "string") return { severity: defaultSeverity, message: item };
  if (isObject(item)) return { severity: item.severity || defaultSeverity, message: str(item.message || item.code || item.finding || item.detail || item), code: item.code };
  return { severity: defaultSeverity, message: str(item) };
}

function addKeyValues(target, rows) {
  for (const row of rows) {
    if (!row || row.value === undefined) continue;
    target.push({ key: row.key, value: row.value === undefined ? null : row.value });
  }
}

function tableRowsFromObject(object, keys = null) {
  if (!isObject(object)) return [];
  const selected = keys || Object.keys(object);
  return selected
    .filter((key) => object[key] !== undefined)
    .map((key) => ({ key, value: object[key] === undefined ? null : object[key] }));
}

function baseCard(tool, data, meta = {}) {
  return {
    card_version: CARD_VERSION,
    card_type: "workstream_dashboard",
    title: meta.title || tool || "Workstream Status",
    subtitle: "",
    status: "info",
    severity: "info",
    summary: "",
    identity: {
      tool,
      payload_hash: meta.payload_hash,
      card_instance_id: meta.card_instance_id,
      workstream_id: meta.workstream_id,
    },
    progress: undefined,
    key_values: [],
    sections: [],
    actions: [],
    diagnostics: [],
    raw_available: data !== undefined,
  };
}

function finalize(card) {
  card.status = card.status || "info";
  card.severity = card.severity || severityFromStatus(card.status);
  card.summary = card.summary || card.subtitle || card.title;
  card.key_values = Array.isArray(card.key_values) ? card.key_values : [];
  card.sections = Array.isArray(card.sections) ? card.sections : [];
  card.actions = Array.isArray(card.actions) ? card.actions : [];
  card.diagnostics = Array.isArray(card.diagnostics) ? card.diagnostics : [];
  return card;
}

// ---------------------------------------------------------------------------
// Workstream Phase Progress
// ---------------------------------------------------------------------------

const WORKSTREAM_PHASE_STAGES = [
  ["planned", "Planned"],
  ["active", "Active"],
  ["review", "Review"],
  ["completed", "Completed"],
];

function workstreamPhaseProgress(phase) {
  const current = phase || "planned";
  const currentIndex = WORKSTREAM_PHASE_STAGES.findIndex(([key]) => key === current);
  return {
    current_stage: current,
    stages: WORKSTREAM_PHASE_STAGES.map(([key, label], index) => ({
      key,
      label,
      status: key === current ? "current" : (currentIndex >= 0 && index < currentIndex ? "done" : "pending"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Section Builders
// ---------------------------------------------------------------------------

/**
 * Section 1: Workstream Summary
 */
function addWorkstreamSummarySection(card, workstream = {}) {
  const summaryRows = tableRowsFromObject(workstream, [
    "id", "title", "status", "phase", "iteration",
    "project_id", "workspace_id", "repo_id",
    "root_goal_id", "workflow_id",
    "created_by", "created_at", "updated_at",
  ]);
  if (summaryRows.length > 0) {
    card.sections.push({ title: "Workstream Summary", type: "table", rows: summaryRows });
  }

  addKeyValues(card.key_values, [
    { key: "workstream_id", value: workstream.id },
    { key: "phase", value: workstream.phase },
    { key: "status", value: workstream.status },
    { key: "iteration", value: workstream.iteration },
    { key: "workflow_id", value: workstream.workflow_id },
  ]);
}

/**
 * Section 2: Execution Graph (DAG) / List Fallback
 */
function addExecutionGraphSection(card, dag = {}, tasks = []) {
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  const hasDag = nodes.length > 0 || dag.node_count != null || dag.edge_count != null || isObject(dag.summary);

  if (!hasDag) {
    // Fallback: list-style task status overview
    const statusCounts = countBy(tasks, (t) => t.status || "unknown");
    if (Object.keys(statusCounts).length > 0) {
      card.sections.push({
        title: "Execution Graph (list fallback)",
        type: "text",
        text: `Tasks by status: ${countsText(statusCounts)}\nTotal tasks: ${tasks.length}`,
      });
    }
    return;
  }

  const readyCount = dag.ready_count ?? dag.ready_nodes?.length ?? 0;
  const blockedCount = dag.blocked_count ?? dag.blocked_nodes?.length ?? 0;
  const completedCount = dag.completed_count ?? 0;

  addKeyValues(card.key_values, [
    { key: "dag_nodes", value: nodes.length || dag.node_count },
    { key: "dag_edges", value: dag.edge_count || dag.edges?.length },
    { key: "dag_ready_nodes", value: readyCount },
    { key: "dag_blocked_nodes", value: blockedCount },
    { key: "dag_completed_nodes", value: completedCount },
  ]);

  card.sections.push({
    title: "Execution Graph",
    type: "table",
    rows: tableRowsFromObject(dag, [
      "node_count", "edge_count",
      "ready_count", "ready_nodes",
      "blocked_count", "blocked_nodes",
      "completed_count", "completed_nodes",
      "running_count", "running_nodes",
      "phase", "iteration",
    ]),
  });

  // Show ready and blocked node names inline
  const readyItems = (dag.ready_nodes || []).slice(0, 8).map((n) =>
    isObject(n) ? `${n.label || n.name || n.id}` : `${n}`
  );
  const blockedItems = (dag.blocked_nodes || []).slice(0, 8).map((n) =>
    isObject(n) ? `${n.label || n.name || n.id}` : `${n}`
  );
  const dagItems = [...readyItems.map((i) => "ready: " + i), ...blockedItems.map((i) => "blocked: " + i)];
  if (dagItems.length > 0) {
    card.sections.push({
      title: "Ready / Blocked Nodes",
      type: "list",
      items: dagItems,
    });
  }

  // Warn if there are blocked nodes
  if (blockedCount > 0) {
    card.diagnostics.push({
      severity: "warning",
      message: `${blockedCount} blocked node(s) in execution graph`,
      code: "dag_blocked_nodes",
    });
  }
}

/**
 * Section 3: Task Execution
 */
function addTaskExecutionSection(card, tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const statusCounts = countBy(tasks, (t) => t.status || "unknown");
  const hasRisk = Object.keys(statusCounts).some((s) =>
    ["failed", "crashed", "blocked"].includes(s)
  );
  const activeCount = tasks.filter((t) =>
    ["assigned", "running", "in_progress"].includes(t.status)
  ).length;

  addKeyValues(card.key_values, [
    { key: "tasks_total", value: tasks.length },
    { key: "tasks_active", value: activeCount },
    { key: "task_statuses", value: countsText(statusCounts) },
  ]);

  if (hasRisk) {
    card.diagnostics.push({
      severity: "error",
      message: `Task execution has failures/blockages: ${countsText(
        Object.fromEntries(
          Object.entries(statusCounts).filter(([s]) =>
            ["failed", "crashed", "blocked"].includes(s)
          )
        )
      )}`,
      code: "task_execution_failures",
    });
  }

  card.sections.push({
    title: `Task Execution (${tasks.length})`,
    type: "table",
    rows: tasks.slice(0, 10).map((task) => ({
      id: task.id || "-",
      title: truncate(task.title || "", 50),
      status: task.status || "-",
      assignee: task.assignee || "-",
      mode: task.mode || "-",
    })),
  });
}

/**
 * Section 4: TUI / Subagent Progress
 */
function addTuiSubagentProgressSection(card, tui = {}, subagents = []) {
  const activeSessions = tui.active_sessions ?? tui.active_tui_sessions ?? 0;
  const totalSessions = tui.total_sessions ?? tui.tui_sessions ?? 0;
  const activeSubagents = subagents.length > 0
    ? subagents.filter((s) => s.status === "running" || s.status === "active").length
    : (tui.active_subagents ?? 0);

  const hasTuiData = totalSessions > 0 || activeSessions > 0 || activeSubagents > 0
    || isObject(tui.progress) || isObject(tui.sessions);

  if (!hasTuiData) return;

  addKeyValues(card.key_values, [
    { key: "tui_sessions", value: totalSessions || activeSessions },
    { key: "tui_active", value: activeSessions },
    { key: "subagents_active", value: activeSubagents },
  ]);

  const tuiRows = tableRowsFromObject(tui, [
    "active_sessions", "total_sessions", "active_tui_sessions", "tui_sessions",
    "active_subagents", "max_sessions", "phase", "iteration",
  ]);

  if (tuiRows.length > 0) {
    card.sections.push({
      title: "TUI / Subagent Progress",
      type: "table",
      rows: tuiRows,
    });
  }

  // Progress stages from TUI
  const progStages = tui.progress?.stages || tui.progress_stages || [];
  if (progStages.length > 0) {
    card.sections.push({
      title: "Progress Stages",
      type: "checklist",
      items: progStages.slice(0, 12).map((stage) => ({
        key: stage.key || stage.name || stage.label,
        label: stage.label || stage.name || stage.key || String(stage),
        status: stage.status || "pending",
        detail: stage.detail || "",
      })),
    });
  }

  // Individual subagent status if available
  if (Array.isArray(subagents) && subagents.length > 0) {
    card.sections.push({
      title: `Subagents (${subagents.length})`,
      type: "table",
      rows: subagents.slice(0, 8).map((sa) => ({
        id: sa.id || sa.subagent_id || "-",
        role: sa.role || sa.kind || "-",
        status: sa.status || "-",
        progress: sa.progress || "-",
      })),
    });
  }
}

/**
 * Section 5: Acceptance & Repair
 */
const ACCEPTANCE_CHECK_KEYS = [
  "result_json_valid",
  "summary_present",
  "safe_changed_paths",
  "verification_present_for_non_noop",
  "verification_passed",
  "worktree_clean",
  "no_blocker_or_major_findings",
  "tests_present",
  "commit_or_patch_evidence",
  "changed_files_match_diff",
];

function addAcceptanceRepairSection(card, acceptance = {}, repair = {}) {
  const hasAcceptance = isObject(acceptance) && (acceptance.overall_status || acceptance.verdict || acceptance.status);
  const hasRepair = isObject(repair) && (repair.repair_attempt != null || repair.max_attempts);

  if (!hasAcceptance && !hasRepair) return;

  // Acceptance checks as checklist
  const checks = acceptance.checks || {};
  const checkItems = ACCEPTANCE_CHECK_KEYS
    .filter((key) => checks[key] !== undefined)
    .map((key) => ({
      key,
      label: key,
      status: checks[key] === true ? "passed" : checks[key] === false ? "failed" : "unknown",
    }));

  const verdict = acceptance.overall_status || acceptance.verdict || acceptance.status;
  if (verdict) {
    addKeyValues(card.key_values, [
      { key: "acceptance_verdict", value: verdict },
    ]);
  }

  if (checkItems.length > 0) {
    card.sections.push({ title: "Acceptance Checks", type: "checklist", items: checkItems });
  }

  if (hasRepair) {
    const repairAttempt = repair.repair_attempt ?? repair.attempt;
    const maxAttempts = repair.max_attempts;
    const canContinue = repair.can_continue ??
      (repairAttempt != null && maxAttempts != null
        ? Number(repairAttempt) < Number(maxAttempts)
        : undefined);

    addKeyValues(card.key_values, [
      {
        key: "repair_attempts",
        value: repairAttempt != null && maxAttempts != null
          ? `${repairAttempt}/${maxAttempts}`
          : repairAttempt != null ? String(repairAttempt) : undefined,
      },
      { key: "repair_can_continue", value: canContinue },
    ]);

    card.sections.push({
      title: "Repair",
      type: "table",
      rows: tableRowsFromObject(repair, [
        "repair_attempt", "max_attempts", "repair_attempts",
        "root_task_id", "parent_task_id",
        "repair_of_goal_id", "repair_goal_id", "repair_task_id",
        "can_continue", "denied_reason",
        "retained_worktree", "retained_branch",
      ]),
    });

    if (canContinue === false) {
      card.diagnostics.push({
        severity: "warning",
        message: `Repair budget exhausted (${repairAttempt}/${maxAttempts})`,
        code: "repair_budget_exhausted",
      });
    }
  }

  // Acceptance findings
  const findings = [
    ...(Array.isArray(acceptance.findings) ? acceptance.findings : []),
    ...(Array.isArray(acceptance.acceptance_findings) ? acceptance.acceptance_findings : []),
  ];
  for (const finding of findings) {
    card.diagnostics.push(normalizeDiagnostic(finding, severityFromStatus(finding?.severity, "warning")));
  }

  // Acceptance repair proposals
  const proposals = Array.isArray(acceptance.repair_proposals) ? acceptance.repair_proposals : [];
  if (proposals.length > 0) {
    card.sections.push({
      title: "Repair Proposals",
      type: "list",
      items: proposals.slice(0, 5).map((p) =>
        typeof p === "string" ? p : (p.title || p.proposed_action || p.message || JSON.stringify(p))
      ),
    });
  }
}

/**
 * Section 6: Open ChatGPT Requests
 */
function addChatGptRequestsSection(card, chatgptRequests = []) {
  const requests = Array.isArray(chatgptRequests) ? chatgptRequests : [];
  if (requests.length === 0) {
    // Check if the requests are embedded in another field
    const escalation = chatgptRequests?.escalations || chatgptRequests?.pending_decisions || [];
    if (Array.isArray(escalation) && escalation.length > 0) {
      return addChatGptRequestsSection(card, escalation);
    }
    return;
  }

  const pendingCount = requests.filter((r) =>
    !r.resolved && r.status !== "resolved" && r.status !== "completed"
  ).length;

  addKeyValues(card.key_values, [
    { key: "chatgpt_requests_total", value: requests.length },
    { key: "chatgpt_requests_pending", value: pendingCount },
  ]);

  card.sections.push({
    title: `Open ChatGPT Requests (${pendingCount} pending)`,
    type: "table",
    rows: requests.slice(0, 8).map((req) => ({
      id: req.id || req.request_id || "-",
      kind: req.kind || req.type || "escalation",
      status: req.status || "pending",
      reason: truncate(req.reason || req.message || req.summary || "", 80),
      created: req.created_at ? short(req.created_at, 16) : "-",
    })),
  });

  if (pendingCount > 0) {
    card.diagnostics.push({
      severity: "info",
      message: `${pendingCount} open ChatGPT request(s) awaiting decision`,
      code: "chatgpt_requests_pending",
    });
  }
}

/**
 * Section 7: Diagnostics / Blockers
 */
function addDiagnosticsSection(card, diagnostics = [], warnings = [], errors = []) {
  for (const item of [...(Array.isArray(errors) ? errors : []), ...(Array.isArray(warnings) ? warnings : [])]) {
    if (typeof item === "string") {
      card.diagnostics.push({ severity: "warning", message: item });
    } else if (isObject(item)) {
      card.diagnostics.push(normalizeDiagnostic(item));
    }
  }

  // If the workstream has a summary of blockers, add it as a section
  if (Array.isArray(diagnostics) && diagnostics.length > 0 && !card.sections.some(s => s.title === "Blockers & Diagnostics")) {
    card.sections.push({
      title: "Blockers & Diagnostics",
      type: "list",
      items: diagnostics.slice(0, 10).map((d) =>
        isObject(d) ? `${d.severity || "info"}: ${d.message || d.code || ""}` : String(d)
      ),
    });
  }
}

/**
 * Section 8: Next Actions
 */
function addNextActionsSection(card, nextActions = []) {
  const actions = Array.isArray(nextActions) ? nextActions : [];
  if (actions.length === 0) return;

  card.sections.push({
    title: "Next Actions",
    type: "list",
    items: actions.slice(0, 8).map((a) =>
      isObject(a)
        ? `[${a.priority || "info"}] ${a.action || a.label || a.message}`
        : String(a)
    ),
  });
}

// ---------------------------------------------------------------------------
// Main Builder
// ---------------------------------------------------------------------------

/**
 * Build a workstream_status card view model.
 *
 * Expected data shape:
 * {
 *   workstream: { id, title, status, phase, iteration, ... },
 *   dag: { nodes, edges, node_count, ready_count, blocked_count, ... },
 *   tasks: [ { id, title, status, ... }, ... ],
 *   tui: { active_sessions, total_sessions, active_subagents, progress, sessions, ... },
 *   subagents: [ { id, role, status, progress }, ... ],
 *   acceptance: { overall_status, verdict, checks, findings, repair_proposals },
 *   repair: { repair_attempt, max_attempts, root_task_id, ... },
 *   chatgpt_requests: [ { id, kind, status, reason, ... }, ... ],
 *   diagnostics: [ ... ],
 *   warnings: [ ... ],
 *   errors: [ ... ],
 *   next_actions: [ ... ],
 *   summary: "...",
 *   status: "...",
 * }
 */
export function buildWorkstreamStatusCard(tool, data, meta = {}) {
  const workstream = data.workstream || data.workstream_record || {};
  const dag = data.dag || data.execution_graph || data.graph || {};
  const tasks = data.tasks || data.task_list || [];
  const tui = data.tui || data.tui_progress || data.tui_sessions || {};
  const subagents = data.subagents || data.subagent_progress || [];
  const acceptance = data.acceptance || data.acceptance_result || {};
  const repair = data.repair || data.repair_record || {};
  const chatgptRequests = data.chatgpt_requests || data.escalations || data.pending_decisions || [];
  const diagnostics = data.diagnostics || data.blockers || [];
  const warnings = data.warnings || [];
  const errors = data.errors || [];
  const nextActions = data.next_actions || data.suggested_actions || [];

  const title = workstream.title
    ? `Workstream: ${truncate(workstream.title, 64)}`
    : (meta.title || "Workstream Status");

  const card = baseCard(tool, data, {
    ...meta,
    title,
    workstream_id: workstream.id,
  });

  card.card_type = "workstream_dashboard";
  card.subtitle = workstream.id || "";

  // Compute overall status from workstream status and any error/warning signals
  const hasErrors = errors.length > 0 || diagnostics.some((d) =>
    isObject(d) && (d.severity === "error" || d.severity === "blocker")
  );
  const hasWarnings = warnings.length > 0 || diagnostics.some((d) =>
    isObject(d) && d.severity === "warning"
  ) || chatgptRequests.some((r) => !r.resolved && r.status !== "resolved");
  const hasBlockedNodes = (dag.blocked_count ?? 0) > 0;

  card.status = data.status || workstream.status || (hasErrors ? "error" : hasWarnings ? "warning" : "info");
  card.severity = hasErrors ? "error" : (hasWarnings || hasBlockedNodes) ? "warning" : severityFromStatus(card.status, "info");
  card.summary = data.summary || `${workstream.title || workstream.id || "workstream"}: ${workstream.status || "active"} — ${tasks.length} task(s), ${Object.keys(dag).length > 0 ? `${dag.node_count || dag.nodes?.length || "?"} DAG nodes` : "no DAG"}`;

  // Phase progress
  if (workstream.phase || workstream.status) {
    card.progress = workstreamPhaseProgress(workstream.phase || workstream.status);
  }

  // Build sections in order
  addWorkstreamSummarySection(card, workstream);
  addExecutionGraphSection(card, dag, tasks);
  addTaskExecutionSection(card, tasks);
  addTuiSubagentProgressSection(card, tui, subagents);
  addAcceptanceRepairSection(card, acceptance, repair);
  addChatGptRequestsSection(card, chatgptRequests);
  addDiagnosticsSection(card, diagnostics, warnings, errors);
  addNextActionsSection(card, nextActions);

  // Actions
  if (workstream.id) {
    card.actions.push({
      label: "View workstream",
      tool: "get_workstream",
      args: { workstream_id: workstream.id },
      kind: "secondary",
    });
    card.actions.push({
      label: "Run controller tick",
      tool: "run_workstream_tick",
      args: { workstream_id: workstream.id },
      kind: "secondary",
    });
  }
  if (workstream.workflow_id) {
    card.actions.push({
      label: "View workflow",
      tool: "get_workflow",
      args: { workflow_id: workstream.workflow_id },
      kind: "secondary",
    });
  }

  return finalize(card);
}
