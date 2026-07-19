const STATUS_ZH = Object.freeze({
  ok: "正常",
  healthy: "健康",
  running: "运行中",
  enabled: "已启用",
  enabled_but_not_running: "已启用但未运行",
  disabled: "已停用",
  queued: "排队中",
  assigned: "已分配",
  pending: "待处理",
  waiting: "等待中",
  waiting_for_review: "待审核",
  waiting_for_lock: "等待仓库锁",
  waiting_for_integration: "等待集成",
  waiting_for_repair: "等待修复",
  completed: "已完成",
  failed: "失败",
  error: "错误",
  cancelled: "已取消",
  blocked: "受阻",
  clean: "干净",
  dirty: "有未提交修改",
  warning: "警告",
  info: "信息",
  stalled: "停滞",
  unknown: "未知",
});

function zhStatus(value, fallback = "未知") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return STATUS_ZH[raw.toLowerCase()] || raw;
}

function value(value, fallback = 0) {
  return value === undefined || value === null ? fallback : value;
}

function zhReason(reason) {
  const raw = String(reason || "").trim();
  if (!raw) return "";
  if (raw === "worker enabled but not running") return "工作进程已启用但未运行";
  if (raw === "worker not enabled") return "工作进程未启用";
  const tickRunning = raw.match(/^tick running for (\d+)s$/i);
  if (tickRunning) return `当前轮询已运行 ${tickRunning[1]} 秒`;
  const lastTick = raw.match(/^last tick (.+) ago \((.+)\)$/i);
  if (lastTick) return `距上次轮询 ${lastTick[1]}（阈值 ${lastTick[2]}）`;
  return raw;
}


function statusCounts(items = []) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item?.status || "unknown");
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${zhStatus(status)} ${count}`).join("，") || "无";
}

function compactRecent(items = [], limit = 5) {
  return (Array.isArray(items) ? items : []).slice(-limit).reverse().map((item) => {
    const id = String(item?.id || item?.task_id || item?.goal_id || item?.queue_id || "-");
    const shortId = id.length > 12 ? id.slice(-8) : id;
    const title = String(item?.title || item?.name || "未命名").replace(/\s+/g, " ").slice(0, 42);
    return `- ${shortId} · ${zhStatus(item?.status)} · ${title}`;
  });
}

function renderRuntimeStatus(data) {
  const worker = data.worker || {};
  const queue = data.queue || worker.queue || {};
  const health = worker.health || data.health || {};
  const commit = String(data.running_commit || data.commit || "-").slice(0, 12);
  return [
    `运行状态：${zhStatus(health.phase || data.status || (worker.running ? "running" : "ok"))}`,
    `进程：PID ${data.pid ?? "-"} · 提交 ${commit} · 工作区 ${data.worktree_dirty ? "有未提交修改" : "干净"}`,
    `工作进程：${worker.enabled === false ? "已停用" : worker.running ? "运行中" : "未运行"}`,
    `队列：已分配 ${value(queue.assigned)} · 排队 ${value(queue.queued)} · 运行 ${value(queue.running)} · 待审核 ${value(queue.actionable_review ?? queue.waiting_for_review)}`,
  ].join("\n");
}

function renderWorkerStatus(data) {
  const worker = data.worker || data;
  const queue = data.queue || data.counts || worker.queue || {};
  const health = data.health || worker.health || {};
  const enabled = data.enabled ?? worker.enabled ?? false;
  const running = data.running ?? worker.running ?? false;
  const blockers = value(queue.current_blockers);
  return [
    `工作进程：${enabled ? (running ? "运行中" : "已启用但未运行") : "已停用"}`,
    `健康状态：${zhStatus(health.phase || data.status || (running ? "running" : "disabled"))}${health.reason ? `（${zhReason(health.reason)}）` : ""}`,
    `队列：已分配 ${value(queue.assigned)} · 排队 ${value(queue.queued)} · 运行 ${value(queue.running)} · 待审核 ${value(queue.actionable_review ?? queue.waiting_for_review)}`,
    `阻塞：${blockers} · 已完成 ${value(queue.completed)} · 失败 ${value(queue.failed)}`,
  ].join("\n");
}

function renderTaskList(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const lines = [
    `任务：共 ${tasks.length} 个`,
    `状态：${statusCounts(tasks)}`,
  ];
  const recent = compactRecent(tasks, 5);
  if (recent.length) lines.push("最近任务：", ...recent);
  return lines.join("\n");
}

function renderGoalList(data) {
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const lines = [
    `目标：共 ${goals.length} 个`,
    `状态：${statusCounts(goals)}`,
  ];
  const recent = compactRecent(goals, 3);
  if (recent.length) lines.push("最近目标：", ...recent);
  return lines.join("\n");
}

function renderGoalQueue(data) {
  const raw = data.items ?? data.item ?? data.queue_items ?? [];
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const lines = [
    `目标队列：共 ${items.length} 项`,
    `状态：${statusCounts(items)}`,
  ];
  const recent = compactRecent(items, 5);
  if (recent.length) lines.push("队列项：", ...recent);
  return lines.join("\n");
}

function renderProjectContext(data) {
  const repo = data.repo || {};
  const summary = data.state_summary || {};
  const next = Array.isArray(data.recommended_next_tools) ? data.recommended_next_tools.slice(0, 6) : [];
  const lines = [
    `项目上下文：${repo.root || repo.path || "-"}`,
    `仓库：分支 ${repo.branch || "-"} · 提交 ${String(repo.head || "-").slice(0, 12)} · ${repo.dirty ? "有未提交修改" : "干净"}`,
    `状态：任务 ${value(summary.tasks)} · 目标 ${value(summary.goals)} · 工具模式 ${data.config?.tool_mode || "standard"} · 渲染 ${data.config?.render_mode || "text"}`,
  ];
  if (next.length) lines.push(`建议下一步：${next.join("、")}`);
  return lines.join("\n");
}

function renderDoctor(data) {
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const actions = data.suggested_next_actions || data.next_actions || [];
  const lines = [
    `GPTWork 诊断：${zhStatus(data.status || (warnings.length ? "warning" : "ok"))}`,
    `运行提交：${String(data.running_commit || "-").slice(0, 12)} · 运行配置 ${data.runtime_env_loaded ? "已加载" : "未加载"}`,
    `警告：${warnings.length} 项`,
  ];
  if (Array.isArray(actions) && actions.length) lines.push(`建议：${actions.slice(0, 3).join("；")}`);
  return lines.join("\n");
}

function renderChanges(data) {
  const files = Array.isArray(data.changed_files) ? data.changed_files : [];
  const lines = [
    `代码变更：${data.summary || `${files.length} 个文件`}`,
    `暂存 ${value(data.staged_count ?? data.staged)} · 未暂存 ${value(data.unstaged_count ?? data.unstaged)}`,
  ];
  if (files.length) {
    lines.push("文件：", ...files.slice(0, 8).map((file) => `- ${file?.path || file}`));
    if (files.length > 8) lines.push(`- 其余 ${files.length - 8} 个文件已省略`);
  }
  return lines.join("\n");
}

function renderHandoff(data) {
  const status = data.status && typeof data.status === "object" ? data.status : (data.handoff || {});
  const state = typeof data.status === "string" ? data.status : (status.status || data.state || "info");
  const plan = String(data.plan || "");
  return [
    `交接：${status.agent || data.agent || "-"} · ${zhStatus(state)}`,
    `目标：${status.goal_id || data.goal_id || "-"} · 任务：${status.task_id || data.task_id || "-"}`,
    `计划：${plan ? `${plan.split("\n").length} 行` : "无"}`,
  ].join("\n");
}

export function summarizeNativeTextZh(name, data) {
  if (!data || typeof data !== "object") return null;
  switch (name) {
    case "runtime_status": return renderRuntimeStatus(data);
    case "worker_status": return renderWorkerStatus(data);
    case "list_tasks": return renderTaskList(data);
    case "list_goals": return renderGoalList(data);
    case "list_goal_queue":
    case "get_goal_queue": return renderGoalQueue(data);
    case "open_project_context": return renderProjectContext(data);
    case "gptwork_doctor": return renderDoctor(data);
    case "show_changes": return renderChanges(data);
    case "read_handoff": return renderHandoff(data);
    case "health_check":
      return `服务状态：${data.ok === false ? "异常" : "正常"}\n服务：${data.service || "gptwork-mcp"}`;

    case "list_projects": return renderProjectList(data);
    case "list_workspaces": return renderWorkspaceList(data);
    case "list_repositories": return renderRepositoryList(data);
    case "open_project_context": {
      const ctx = data;
      const repo = ctx.repo || {};
      const summary = ctx.state_summary || {};
      const repos = Array.isArray(ctx.repositories) ? ctx.repositories : [];
      const tasks = Array.isArray(summary.recent_tasks) ? summary.recent_tasks : [];
      const goals = Array.isArray(summary.recent_goals) ? summary.recent_goals : [];
      const lines = [
        '项目上下文',
        `仓库：${repo.root || repo.path || "-"} · 分支 ${repo.branch || "-"} · ${repo.dirty ? "有未提交修改" : "干净"}`,
        `状态：任务 ${summary.tasks ?? 0} 个 · 目标 ${summary.goals ?? 0} 个`,
      ];
      if (tasks.length) {
        lines.push('最近任务：');
        for (const t of tasks) {
          lines.push(`  - ${t.display || t.title || t.id || "未命名"} · ${t.status || "-"}`);
        }
      }
      if (goals.length) {
        lines.push('最近目标：');
        for (const g of goals) {
          lines.push(`  - ${g.display || g.title || g.id || "未命名"} · ${g.status || "-"}`);
        }
      }
      if (repos.length) {
        lines.push(`注册仓库：${repos.length} 个`);
        for (const r of repos.slice(0, 5)) {
          lines.push(`  - ${r.display || r.repo_id || "未命名"}`);
        }
        if (repos.length > 5) lines.push(`  - 其余 ${repos.length - 5} 个已省略`);
      }
      const next = Array.isArray(ctx.recommended_next_tools) ? ctx.recommended_next_tools.slice(0, 6) : [];
      if (next.length) lines.push(`建议下一步：${next.join("、")}`);
      return lines.join("\n");
    }

    default:
      return null;
  }
}

function renderProjectList(data) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const lines = [`项目：共 ${projects.length} 个`];
  for (const p of projects) {
    const name = p.name || p.display || "未命名";
    const id = String(p.id || "-").slice(0, 12);
    lines.push(`- ${name}（${id}）`);
  }
  return lines.join("\n");
}

function renderWorkspaceList(data) {
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  const projectId = data.project_id || "-";
  const lines = [`工作区（项目 ${projectId}）：共 ${workspaces.length} 个`];
  for (const w of workspaces) {
    const name = w.name || "未命名";
    lines.push(`- ${name}（${w.type || "-"}）`);
  }
  return lines.join("\n");
}

function renderRepositoryList(data) {
  const repos = Array.isArray(data.repositories) ? data.repositories : [];
  const lines = [`注册仓库：共 ${repos.length} 个`];
  for (const r of repos.slice(0, 10)) {
    const display = r.display || r.repo_id || r.repo_name || "未命名";
    const branch = r.default_branch || "-";
    lines.push(`- ${display}（默认分支 ${branch}）`);
  }
  if (repos.length > 10) lines.push(`- 其余 ${repos.length - 10} 个已省略`);
  return lines.join("\n");
}
