import { isResolvedLegacyReviewTask, legacyResolutionSummary } from "./legacy-reconciliation.mjs";
import {
  ACTIVE_EXECUTION_STATUSES,
  TASK_STATUSES,
  isHumanReviewStatus,
  isRepairStatus,
  isReviewOrRepairStatus,
  normalizeTaskStatus,
} from "./task-status-taxonomy.mjs";

const CARD_VERSION = "gptwork-card-v1";
const CARD_ENABLED_TOOLS = new Set([
  "runtime_status",
  "worker_status",
  "list_tasks",
  "get_task",
  "create_encoded_goal",
  "preview_codex_context",
  "context_status",
  "project_context_status",
  "list_goal_queue",
  "get_goal_queue",
  "get_goal_context",
  "run_assigned_codex_tasks",
]);

const TASK_STAGES = [
  ["created", "Created"],
  [TASK_STATUSES.ASSIGNED, "Assigned"],
  ["materializing_worktree", "Worktree"],
  [TASK_STATUSES.RUNNING, "Running"],
  [TASK_STATUSES.WAITING_FOR_INTEGRATION, "Integration"],
  [TASK_STATUSES.WAITING_FOR_REPAIR, "Repair"],
  [TASK_STATUSES.WAITING_FOR_REVIEW, "Review"],
  [TASK_STATUSES.COMPLETED, "Completed"],
];

const DISPLAY_WARNING_STATUSES = new Set([
  ...ACTIVE_EXECUTION_STATUSES,
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
]);

const ACCEPTANCE_CHECKS = [
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
  "safe_restart_evidence",
  "post_restart_verification",
];

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
  if (["ok", "pass", "passed", "completed", "success", "healthy", "enabled", "clean", "true", "created"].includes(s)) return "ok";
  if (["warn", "warning", "waiting", "pending", "needs_repair"].includes(s) || DISPLAY_WARNING_STATUSES.has(s) || isReviewOrRepairStatus(s)) return "warning";
  if (["fail", "failed", "error", "crashed", "stalled", "overdue", "dirty", "blocked", "false", "push_failed", "pr_failed", "conflict", "check_failed"].includes(s)) return "error";
  return fallback;
}

function isFailedStatus(status) {
  return normalizeTaskStatus(status) === TASK_STATUSES.FAILED;
}

function isGoalQueueRiskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized === TASK_STATUSES.BLOCKED
    || normalized === TASK_STATUSES.FAILED
    || normalized === TASK_STATUSES.CANCELLED;
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
    card_type: "generic",
    title: meta.title || tool || "GPTWork Result",
    subtitle: "",
    status: "info",
    severity: "info",
    summary: "",
    identity: {
      tool,
      payload_hash: meta.payload_hash,
      card_instance_id: meta.card_instance_id,
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

const RUNTIME_QUEUE_ROW_KEYS = [
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.QUEUED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  "current_blockers",
  "actionable_review",
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.CANCELLED,
];

function runtimeQueueActionableReview(queue = {}) {
  const policy = queue.policy_counts || queue;
  return queue.actionable_review ?? policy.waiting_for_review ?? queue.waiting_for_review ?? 0;
}

function runtimeQueueCurrentBlockers(queue = {}) {
  const policy = queue.policy_counts || queue;
  return (policy.waiting_for_lock ?? 0)
    + (policy.waiting_for_integration ?? 0)
    + (policy.waiting_for_repair ?? 0)
    + runtimeQueueActionableReview(queue)
    + (policy.failed ?? 0);
}

function runtimeQueueDisplay(queue = {}) {
  const policy = queue.policy_counts || queue;
  return {
    ...queue,
    ...policy,
    current_blockers: queue.current_blockers ?? runtimeQueueCurrentBlockers(queue),
    actionable_review: runtimeQueueActionableReview(queue),
  };
}

function queueSection(queue = {}) {
  const displayQueue = runtimeQueueDisplay(queue);
  return {
    title: "Queue",
    type: "table",
    rows: tableRowsFromObject(displayQueue, RUNTIME_QUEUE_ROW_KEYS),
  };
}

function buildRuntimeStatusCard(tool, data, meta) {
  const card = baseCard(tool, data, { ...meta, title: tool === "worker_status" ? "Worker Status" : "Runtime Status" });
  const queue = runtimeQueueDisplay(data.queue || data.queues || data.worker?.queue || {});
  const worker = tool === "worker_status" ? data : (data.worker || {});
  const healthPhase = worker.health?.phase || (worker.running ? "running" : (worker.enabled ? "enabled" : "disabled"));
  const dirty = Boolean(data.worktree_dirty);

  card.card_type = "runtime_health";
  card.status = dirty ? "warning" : healthPhase;
  card.severity = dirty ? "warning" : severityFromStatus(healthPhase, "info");
  card.summary = `worker ${worker.enabled ? "enabled" : "disabled"}; queue assigned=${queue.assigned ?? 0}, running=${queue.running ?? 0}, current blockers=${queue.current_blockers ?? 0}`;

  addKeyValues(card.key_values, [
    { key: "pid", value: data.pid },
    { key: "running_commit", value: data.running_commit ? short(data.running_commit) : undefined },
    { key: "worktree", value: dirty ? "dirty" : (data.worktree_dirty === false ? "clean" : undefined) },
    { key: "worker", value: worker.enabled ? "enabled" : "disabled" },
    { key: "worker.running", value: worker.running === undefined ? undefined : Boolean(worker.running) },
    { key: "worker.health", value: healthPhase },
    { key: "queue.assigned", value: queue.assigned ?? 0 },
    { key: "queue.running", value: queue.running ?? 0 },
    { key: "queue.current_blockers", value: queue.current_blockers ?? 0 },
    { key: "queue.actionable_review", value: queue.actionable_review ?? 0 },
  ]);

  if (Object.keys(queue).length > 0) card.sections.push(queueSection(queue));
  if (worker.health) card.sections.push({ title: "Worker Health", type: "table", rows: tableRowsFromObject(worker.health) });
  if (dirty) card.diagnostics.push({ severity: "warning", message: `Dirty worktree (${(data.dirty_paths || []).length} file(s))`, code: "worktree_dirty" });
  if (worker.health?.phase && ["stalled", "overdue"].includes(worker.health.phase)) {
    card.diagnostics.push({ severity: "warning", message: `Worker health: ${worker.health.phase}${worker.health.reason ? ` - ${worker.health.reason}` : ""}`, code: "worker_health" });
  }
  if (data.last_error || worker.last_error) card.diagnostics.push({ severity: "error", message: truncate(data.last_error || worker.last_error), code: "last_error" });

  // Safe-to-advance analysis — list blockages
  const blockages = [];
  if (worker.running) blockages.push("worker_running");
  if (dirty) blockages.push("dirty_worktree");
  if ((queue.waiting_for_lock ?? 0) > 0) blockages.push(TASK_STATUSES.WAITING_FOR_LOCK);
  if ((queue.waiting_for_integration ?? 0) > 0) blockages.push(TASK_STATUSES.WAITING_FOR_INTEGRATION);
  if ((queue.waiting_for_repair ?? 0) > 0) blockages.push(TASK_STATUSES.WAITING_FOR_REPAIR);
  if ((queue.actionable_review ?? 0) > 0) blockages.push("actionable_review");
  if ((queue.failed ?? 0) > 0 || queue.legacy_failed_policy?.blocks_current_work) blockages.push(TASK_STATUSES.FAILED);
  if (data.running_commit && data.repo_head && data.running_commit !== data.repo_head) blockages.push("runtime_restart_required");
  if (blockages.length > 0) {
    card.sections.push({
      title: "Current blockers",
      type: "list",
      items: blockages,
    });
  }

  return finalize(card);
}

function buildListTasksCard(tool, data, meta) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const card = baseCard(tool, data, { ...meta, title: "Task Queue" });
  const statusCounts = countBy(tasks, (task) => task.status || "unknown");
  const assigneeCounts = countBy(tasks, (task) => task.assignee || "unassigned");
  const actionableReviewTasks = tasks.filter((task) => isHumanReviewStatus(task.status) && !isResolvedLegacyReviewTask(task));
  const resolvedReviewTasks = tasks.filter((task) => isResolvedLegacyReviewTask(task));
  const hasRisk = tasks.some((task) => isFailedStatus(task.status) || isRepairStatus(task.status)) || actionableReviewTasks.length > 0;

  card.card_type = "queue";
  card.status = hasRisk ? "warning" : "ok";
  card.severity = hasRisk ? "warning" : "ok";
  card.summary = `${tasks.length} task(s); ${countsText(statusCounts) || "no status counts"}`;
  addKeyValues(card.key_values, [
    { key: "tasks", value: tasks.length },
    { key: "statuses", value: countsText(statusCounts) || "-" },
    { key: "assignees", value: countsText(assigneeCounts) || "-" },
    { key: "actionable_review", value: actionableReviewTasks.length },
    { key: "resolved_legacy_review", value: resolvedReviewTasks.length },
  ]);
  card.sections.push({
    title: "Recent tasks",
    type: "table",
    rows: tasks.slice(0, 10).map((task) => ({
      id: task.id,
      title: truncate(task.title || "", 60),
      status: task.status || "-",
      assignee: task.assignee || "-",
      mode: task.mode || "-",
    })),
  });

  // Waiting for review breakdown
  const wfrTasks = tasks.filter((t) => isHumanReviewStatus(t.status));
  if (wfrTasks.length > 0) {
    card.sections.push({
      title: "Waiting for review",
      type: "table",
      rows: wfrTasks.slice(0, 10).map((task) => ({
        id: task.id,
        title: truncate(task.title || "", 50),
        status: task.status,
        reason: task.waiting_for_review_reason || task.result?.waiting_for_review_reason || "manual_review",
      })),
    });
    card.key_values.push({ key: "waiting_for_review", value: wfrTasks.length });
    const actionableReasons = actionableReviewTasks.filter((t) => t.waiting_for_review_reason === "manual_review" || !t.waiting_for_review_reason);
    if (actionableReasons.length > 0) {
      card.diagnostics.push({ severity: "info", message: `${actionableReasons.length} review task(s) actionable — check reason column`, code: "wfr_actionable" });
    }
    if (resolvedReviewTasks.length > 0) {
      card.sections.push({
        title: "Resolved legacy history",
        type: "table",
        rows: resolvedReviewTasks.slice(0, 10).map((task) => {
          const resolution = legacyResolutionSummary(task);
          return {
            id: task.id,
            title: truncate(task.title || "", 50),
            resolved_by: resolution.resolved_by_task_id || "-",
            superseded_by: resolution.superseded_by_task_id || "-",
            reason: resolution.reason || "resolved_history",
          };
        }),
      });
    }
  }

  return finalize(card);
}

function taskProgress(status) {
  const current = status || "created";
  const currentIndex = TASK_STAGES.findIndex(([key]) => key === current);
  return {
    current_stage: current,
    stages: TASK_STAGES.map(([key, label], index) => ({
      key,
      label,
      status: key === current ? "current" : (currentIndex >= 0 && index < currentIndex ? "done" : "pending"),
    })),
  };
}

function normalizeAcceptance(result = {}) {
  const acceptance = result.acceptance || result.acceptance_result || null;
  const checks = isObject(acceptance?.checks) ? acceptance.checks : {};
  const findings = [
    ...(Array.isArray(acceptance?.findings) ? acceptance.findings : []),
    ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
  ];
  const verification = result.verification || null;
  if (verification) {
    if (checks.verification_passed === undefined) checks.verification_passed = verification.passed === true;
    if (checks.verification_present_for_non_noop === undefined) checks.verification_present_for_non_noop = true;
    if (Array.isArray(verification.findings)) findings.push(...verification.findings);
  }
  if (result.summary !== undefined && checks.summary_present === undefined) checks.summary_present = Boolean(result.summary);
  if (result.status !== undefined && checks.result_json_valid === undefined) checks.result_json_valid = true;
  const overall = acceptance?.overall_status || acceptance?.status || result.acceptance_decision || (verification ? (verification.passed ? "passed" : "failed") : null);
  const repairProposals = Array.isArray(acceptance?.repair_proposals) ? acceptance.repair_proposals : (Array.isArray(result.repair_proposals) ? result.repair_proposals : []);
  return { overall, checks, findings, repairProposals };
}

function addAcceptanceSection(card, result = {}) {
  const acceptance = normalizeAcceptance(result);
  if (!acceptance.overall && Object.keys(acceptance.checks).length === 0 && acceptance.findings.length === 0) return;
  const checklist = ACCEPTANCE_CHECKS
    .filter((key) => acceptance.checks[key] !== undefined)
    .map((key) => ({ key, label: key, status: acceptance.checks[key] === true ? "passed" : acceptance.checks[key] === false ? "failed" : "unknown" }));
  card.sections.push({ title: "Acceptance", type: "checklist", items: checklist });
  if (acceptance.overall) card.key_values.push({ key: "acceptance", value: acceptance.overall });
  for (const finding of acceptance.findings) card.diagnostics.push(normalizeDiagnostic(finding, severityFromStatus(finding?.severity, "warning")));
  if (acceptance.repairProposals.length > 0) {
    card.sections.push({
      title: "Repair proposals",
      type: "list",
      items: acceptance.repairProposals.slice(0, 5).map((proposal) => typeof proposal === "string" ? proposal : (proposal.title || proposal.proposed_action || proposal.message || JSON.stringify(proposal))),
    });
  }
}

function normalizeRepair(task = {}, result = {}) {
  const repair = result.repair || result.repair_goal || {};
  const out = {
    root_task_id: repair.root_task_id || result.root_task_id || task.root_task_id,
    parent_task_id: repair.parent_task_id || result.parent_task_id || task.parent_task_id,
    repair_attempt: repair.repair_attempt ?? result.repair_attempt ?? task.repair_attempt,
    max_attempts: repair.max_attempts ?? result.max_attempts ?? task.max_attempts,
    repair_of_goal_id: repair.repair_of_goal_id || result.repair_of_goal_id || task.repair_of_goal_id || task.goal_id,
    retained_worktree: repair.retained_worktree || repair.repair_of_worktree || result.retained_worktree || result.repair_of_worktree || task.worktree_path || task.worktree?.path,
    retained_branch: repair.retained_branch || repair.repair_of_branch || result.retained_branch || result.repair_of_branch || task.worktree?.branch,
    can_continue: repair.can_continue ?? result.can_continue_repair,
    repair_goal_id: result.repair_goal_id,
    repair_task_id: result.repair_task_id,
    denied_reason: result.repair_denied_reason,
  };
  if (out.can_continue === undefined && out.repair_attempt != null && out.max_attempts != null) out.can_continue = Number(out.repair_attempt) < Number(out.max_attempts);
  return out;
}

function addRepairSection(card, task = {}, result = {}) {
  const repair = normalizeRepair(task, result);
  if (!Object.values(repair).some((value) => value !== undefined && value !== null && value !== "")) return;
  const rows = tableRowsFromObject(repair, ["root_task_id", "parent_task_id", "repair_attempt", "max_attempts", "repair_of_goal_id", "repair_goal_id", "repair_task_id", "retained_worktree", "retained_branch", "can_continue", "denied_reason"]);
  card.sections.push({ title: "Repair", type: "table", rows });
  if (repair.root_task_id) card.key_values.push({ key: "root_task_id", value: repair.root_task_id });
  if (repair.repair_attempt != null) card.key_values.push({ key: "repair_attempt", value: `${repair.repair_attempt}/${repair.max_attempts ?? "?"}` });
  if (repair.can_continue === false) card.diagnostics.push({ severity: "warning", message: "Repair reached maximum repair attempts; waiting_for_review is required.", code: "repair_attempt_limit" });
}

function normalizeIntegration(task = {}, result = {}) {
  const integration = result.integration || result.delivery || {};
  const lifecycle = result.worktree_lifecycle || result.repo_resolution?.worktree_lifecycle || {};
  const status = integration.status || null;
  const push_status = integration.push_status || (status === "push_failed" ? "failed" : integration.pushed === true ? "passed" : integration.pushed === false ? "skipped" : undefined);
  const pr_status = integration.pr_status || (status === "pr_failed" ? "failed" : integration.pr_opened === true ? "created" : integration.pr_opened === false ? "skipped" : undefined);
  let merge_status = integration.merge_status;
  if (merge_status === undefined) {
    if (integration.merged === true) merge_status = "completed";
    else if (status === "conflict") merge_status = "failed";
    else if (push_status === "failed" || pr_status === "failed") merge_status = "failed";
    else merge_status = status === "completed" ? "completed" : status || undefined;
  }
  return {
    mode: integration.mode || integration.integrationMode || result.integration_mode || "-",
    branch: integration.branch || integration.taskBranch || integration.task_branch || task.worktree?.branch || lifecycle.branch_name || result.branch,
    worktree_path: integration.worktree_path || integration.worktreePath || result.worktree_path || result.execution_cwd || task.worktree_path || task.worktree?.path || lifecycle.worktree_path,
    cleanup_status: integration.cleanup_status || lifecycle.cleanup?.status || (lifecycle.cleanup ? (lifecycle.cleanup.ok ? "removed" : "retained") : undefined),
    push_status,
    pr_status,
    merge_status,
    commit: integration.commit || integration.commit_sha || result.commit || result.remote_head,
    status,
    error: integration.error,
    retained_failed_worktree: integration.retained_failed_worktree ?? lifecycle.cleanup?.ok === false,
  };
}

function addIntegrationSection(card, task = {}, result = {}) {
  const integration = normalizeIntegration(task, result);
  if (!Object.values(integration).some((value) => value !== undefined && value !== null && value !== "" && value !== "-")) return;
  card.sections.push({ title: "Integration", type: "table", rows: tableRowsFromObject(integration, ["mode", "branch", "worktree_path", "cleanup_status", "push_status", "pr_status", "merge_status", "commit", "status", "error"]) });
  for (const key of ["branch", "push_status", "pr_status", "merge_status", "commit"]) {
    if (integration[key]) card.key_values.push({ key: `integration.${key}`, value: key === "commit" ? short(integration[key]) : integration[key] });
  }
  if (integration.error) card.diagnostics.push({ severity: "error", message: integration.error, code: "integration_error" });
  if (integration.retained_failed_worktree) card.diagnostics.push({ severity: "warning", message: `Retained failed worktree${integration.worktree_path ? `: ${integration.worktree_path}` : ""}`, code: "retained_failed_worktree" });
}

function buildTaskCard(tool, data, meta) {
  const task = data.task || {};
  const result = task.result || {};
  const card = baseCard(tool, data, { ...meta, title: task.title ? `Task: ${truncate(task.title, 64)}` : "Task" });
  card.card_type = "task_execution";
  card.subtitle = task.id || "";
  card.status = task.status || "unknown";
  card.severity = severityFromStatus(task.status, "info");
  card.summary = result.summary || `${task.status || "unknown"} task${task.assignee ? ` assigned to ${task.assignee}` : ""}`;
  card.identity.task_id = task.id;
  card.identity.goal_id = task.goal_id;
  card.progress = taskProgress(task.status);
  addKeyValues(card.key_values, [
    { key: "task_id", value: task.id },
    { key: "goal_id", value: task.goal_id },
    { key: "lifecycle_stage", value: task.status },
    { key: "mode", value: task.mode },
    { key: "assignee", value: task.assignee },
    { key: "changed_files", value: Array.isArray(result.changed_files) ? result.changed_files.length : undefined },
    { key: "tests", value: result.tests || (result.tests === null || result.tests === undefined ? "tests_missing" : undefined) },
    { key: "commit", value: result.commit ? short(result.commit) : undefined },
  ]);

  // Verification status explicit display
  const verification = result.verification;
  if (verification) {
    const verStatus = verification.passed === true ? "passed" : (verification.passed === false ? "failed" : "present");
    card.key_values.push({ key: "verification", value: verStatus });
    if (verification.passed === false) {
      card.diagnostics.push({ severity: "error", message: "Verification failed — review details in result", code: "verification_failed" });
    }
  } else if (result.tests === null || result.tests === undefined) {
    card.key_values.push({ key: "verification", value: "missing" });
    card.diagnostics.push({ severity: "warning", message: "Tests missing — task result has no verification evidence", code: "tests_missing" });
  }

  // Acceptance summary
  const acceptance = result.acceptance || result.acceptance_result || {};
  if (acceptance.overall_status) {
    card.key_values.push({ key: "acceptance", value: acceptance.overall_status });
  }
  if (typeof acceptance.blocking_count === "number") {
    card.key_values.push({ key: "blocking_count", value: acceptance.blocking_count });
  }
  if (typeof acceptance.residual_count === "number") {
    card.key_values.push({ key: "residual_count", value: acceptance.residual_count });
  }

  if (Array.isArray(task.logs) && task.logs.length > 0) {
    card.sections.push({
      title: "Timeline",
      type: "timeline",
      items: task.logs.slice(-5).map((log) => ({ time: log.time, text: truncate(log.message || "", 160) })),
    });
  }
  if (Array.isArray(result.changed_files) && result.changed_files.length > 0) {
    card.sections.push({ title: "Changed files", type: "list", items: result.changed_files.slice(0, 20) });
  }
  if (result.tests) {
    card.sections.push({ title: "Verification", type: "text", text: result.tests });
  } else if (result.tests === null || result.tests === undefined) {
    card.sections.push({ title: "Verification", type: "text", text: "tests_missing — no verification evidence in result" });
  }
  addAcceptanceSection(card, result);
  addRepairSection(card, task, result);
  addIntegrationSection(card, task, result);
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) card.diagnostics.push(normalizeDiagnostic(warning, "warning"));
  if (isHumanReviewStatus(task.status)) card.diagnostics.push({ severity: "warning", message: "Task needs review before completing", code: TASK_STATUSES.WAITING_FOR_REVIEW });
  card.actions.push({ label: "View task", tool: "get_task", args: { task_id: task.id }, kind: "secondary" });
  if (task.goal_id) card.actions.push({ label: "View goal context", tool: "get_goal_context", args: { goal_id: task.goal_id }, kind: "secondary" });
  return finalize(card);
}

function buildGoalCreatedCard(tool, data, meta) {
  const goal = data.goal || {};
  const card = baseCard(tool, data, { ...meta, title: "Goal Created" });
  card.card_type = "task_execution";
  card.subtitle = goal.id || "";
  card.status = goal.status || data.execution?.status || "created";
  card.severity = severityFromStatus(card.status, "info");
  card.summary = goal.title ? `${truncate(goal.title, 90)} (${goal.status || "created"})` : `Goal ${goal.id || "created"}`;
  card.identity.goal_id = goal.id;
  if (goal.task_id || data.task?.id) card.identity.task_id = goal.task_id || data.task.id;
  addKeyValues(card.key_values, [
    { key: "goal_id", value: goal.id },
    { key: "task_id", value: goal.task_id || data.task?.id },
    { key: "status", value: goal.status },
    { key: "mode", value: goal.mode },
    { key: "assignee", value: goal.assignee },
    { key: "execution_status", value: data.execution?.status },
  ]);
  if (data.workspace_files) card.sections.push({ title: "Workspace files", type: "table", rows: tableRowsFromObject(data.workspace_files) });
  if (data.execution?.task) card.sections.push({ title: "Execution task", type: "table", rows: tableRowsFromObject(data.execution.task, ["id", "status", "mode", "assignee"]) });
  return finalize(card);
}

function buildContextCard(tool, data, meta) {
  const isPreview = tool === "preview_codex_context";
  const ctx = data.context || data;
  const card = baseCard(tool, data, { ...meta, title: isPreview ? "Codex Context" : tool === "get_goal_context" ? "Goal Context" : "Context Status" });
  card.card_type = "context";
  card.status = (data.warnings || ctx.warnings || []).length ? "warning" : "ok";
  card.severity = severityFromStatus(card.status, "info");
  const goal = data.goal || ctx.goal || {};
  const task = data.task || ctx.task || {};
  card.identity.goal_id = goal.id || data.goal_id;
  card.identity.task_id = task.id || data.task_id;
  card.summary = isPreview
    ? `prompt ${data.actual_prompt_bytes ?? "?"} bytes; task ${task.status || "not linked"}`
    : goal.id ? `${goal.id} ${goal.status || ""}`.trim() : `workspace ${data.workspace_root || ctx.workspace?.root || "context"}`;
  addKeyValues(card.key_values, [
    { key: "goal_id", value: goal.id },
    { key: "task_id", value: task.id },
    { key: "goal_status", value: goal.status },
    { key: "task_status", value: task.status },
    { key: "workspace", value: data.workspace_root || ctx.workspace?.root },
    { key: "canonical_repo", value: data.canonical_repo_path || data.default_repo_path || ctx.canonical_repo?.path },
    { key: "prompt_bytes", value: data.actual_prompt_bytes },
  ]);
  if (data.workspace_files) card.sections.push({ title: "Workspace files", type: "table", rows: tableRowsFromObject(data.workspace_files) });
  if (data.preview_text || data.preview) card.sections.push({ title: "Preview", type: "text", text: truncate(data.preview_text || data.preview, 1200) });
  for (const warning of [...(Array.isArray(data.warnings) ? data.warnings : []), ...(Array.isArray(ctx.warnings) ? ctx.warnings : [])]) card.diagnostics.push(normalizeDiagnostic(warning, "warning"));
  if (data.actual_prompt_warning) card.diagnostics.push({ severity: "warning", message: data.actual_prompt_warning, code: "prompt_size" });
  return finalize(card);
}

function buildGoalQueueCard(tool, data, meta) {
  const items = Array.isArray(data.items) ? data.items : (data.item ? [data.item] : []);
  const card = baseCard(tool, data, { ...meta, title: "Goal Queue" });
  const statusCounts = countBy(items, (item) => item.status || "unknown");
  const hasRisk = items.some((item) => isGoalQueueRiskStatus(item.status));
  card.card_type = "queue";
  card.status = hasRisk ? "warning" : "ok";
  card.severity = hasRisk ? "warning" : "ok";
  card.summary = `${items.length} queue item(s); ${countsText(statusCounts) || "no status counts"}`;
  addKeyValues(card.key_values, [
    { key: "items", value: items.length },
    { key: "statuses", value: countsText(statusCounts) || "-" },
  ]);
  card.sections.push({
    title: "Queue items",
    type: "table",
    rows: items.slice(0, 20).map((item) => ({
      queue_id: item.queue_id || item.id,
      goal_id: item.goal_id,
      task_id: item.task_id,
      status: item.status,
      position: item.position,
      title: truncate(item.goal_title || item.title || "", 60),
    })),
  });
  return finalize(card);
}

function buildRunAssignedCard(tool, data, meta) {
  const card = baseCard(tool, data, { ...meta, title: "Codex Task Run" });
  const results = Array.isArray(data.results) ? data.results : [];
  card.card_type = "queue";
  card.status = data.status || (results.some((item) => isFailedStatus(item.status)) ? "warning" : "ok");
  card.severity = severityFromStatus(card.status, "info");
  card.summary = data.summary || `${results.length} assigned task result(s)`;
  addKeyValues(card.key_values, [
    { key: "processed", value: data.processed ?? results.length },
    { key: "completed", value: data.completed },
    { key: "failed", value: data.failed },
    { key: "inspected", value: data.inspected },
  ]);
  if (results.length > 0) card.sections.push({ title: "Results", type: "table", rows: results.slice(0, 20) });
  return finalize(card);
}

function buildGenericCard(tool, data, meta) {
  const card = baseCard(tool, data, meta);
  card.status = data?.status || (data?.ok === true ? "ok" : data?.ok === false ? "error" : "info");
  card.severity = severityFromStatus(card.status, "info");
  card.summary = data?.summary || `${tool || "tool"} result`;
  if (isObject(data)) addKeyValues(card.key_values, Object.keys(data).slice(0, 8).map((key) => ({ key, value: typeof data[key] === "object" ? JSON.stringify(data[key]).slice(0, 80) : data[key] })));
  return finalize(card);
}

export function isCardViewModelEnabledTool(tool) {
  return CARD_ENABLED_TOOLS.has(tool);
}

export function buildCardViewModel(tool, data, meta = {}) {
  const payload = isObject(data) ? data : { value: data };
  switch (tool) {
    case "runtime_status":
    case "worker_status":
      return buildRuntimeStatusCard(tool, payload, meta);
    case "list_tasks":
      return buildListTasksCard(tool, payload, meta);
    case "get_task":
      return buildTaskCard(tool, payload, meta);
    case "create_encoded_goal":
      return buildGoalCreatedCard(tool, payload, meta);
    case "preview_codex_context":
    case "context_status":
    case "project_context_status":
    case "get_goal_context":
      return buildContextCard(tool, payload, meta);
    case "list_goal_queue":
    case "get_goal_queue":
      return buildGoalQueueCard(tool, payload, meta);
    case "run_assigned_codex_tasks":
      return buildRunAssignedCard(tool, payload, meta);
    default:
      return buildGenericCard(tool, payload, meta);
  }
}

export function legacyFieldsFromCard(card) {
  if (!isObject(card)) return {};
  const keyValues = (Array.isArray(card.key_values) ? card.key_values : []).map((row) => ({ key: row.key, value: row.value }));
  const items = [];
  if (card.progress?.stages?.length) {
    items.push(...card.progress.stages.map((stage) => `${stage.label}: ${stage.status}${stage.detail ? ` - ${stage.detail}` : ""}`));
  }
  for (const section of card.sections || []) {
    if (section.type === "text" && section.text) items.push(`${section.title}: ${truncate(section.text, 160)}`);
    else if (Array.isArray(section.items) && section.items.length) items.push(`${section.title}: ${section.items.length} item(s)`);
    else if (Array.isArray(section.rows) && section.rows.length) items.push(`${section.title}: ${section.rows.length} row(s)`);
  }
  for (const diagnostic of card.diagnostics || []) items.push(`${diagnostic.severity || "info"}: ${diagnostic.message}`);
  return {
    summary: card.summary,
    status: card.status,
    keyValues,
    items,
  };
}

export { CARD_VERSION };
