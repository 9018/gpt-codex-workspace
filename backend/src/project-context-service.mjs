import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { collectWorkerQueueCounts } from "./worker-queue-counts.mjs";
import { isResolvedLegacyReviewTask, legacyResolutionSummary } from "./legacy-reconciliation.mjs";
import { TASK_STATUSES, isHumanReviewStatus } from "./task-status-taxonomy.mjs";
import { collectRetainedWorktreeDiagnostics } from "./task-worktree-manager.mjs";

const TEXT_LIMIT = 8000;

function safeGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function currentRepoRoot() {
  const root = safeGit(["rev-parse", "--show-toplevel"], process.cwd());
  return root ? resolve(root) : resolve(process.cwd());
}

function resolveContextRepoRoot({ config, registry } = {}) {
  const defaultRepo = typeof registry?.getDefaultRepo === "function" ? registry.getDefaultRepo() : null;
  if (defaultRepo?.canonical_path) return resolve(defaultRepo.canonical_path);
  if (config?.defaultRepoPath) return resolve(config.defaultRepoPath);
  return currentRepoRoot();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fileStatus(root, names) {
  return names.map((name) => ({ name, exists: existsSync(join(root, name)) }));
}

function boundedTree(root, maxEntries = 80) {
  const result = [];
  function walk(dir, prefix = "") {
    if (result.length >= maxEntries) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => ![".git", "node_modules", ".worktrees", "coverage"].includes(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= maxEntries) break;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      result.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory() && prefix.split("/").filter(Boolean).length < 1) walk(join(dir, entry.name), rel);
    }
  }
  walk(root);
  return result;
}

function scriptsFromPackage(root) {
  const pkg = readJson(join(root, "package.json"));
  return pkg?.scripts ? Object.keys(pkg.scripts).sort().map((name) => `npm run ${name}`) : [];
}

export async function collectProjectContext({ config, store, workerState, registry }) {
  const repoRoot = resolveContextRepoRoot({ config, registry });
  const state = await store.load();
  const head = safeGit(["rev-parse", "--short", "HEAD"], repoRoot) || null;
  const branch = safeGit(["branch", "--show-current"], repoRoot) || null;
  const dirty = safeGit(["status", "--short"], repoRoot).split("\n").filter(Boolean);
  const queue = await collectWorkerQueueCounts(store);
  const policyQueue = queue.policy_counts || queue;
  const tasks = state.tasks || [];
  const retainedWorktrees = await collectRetainedWorktreeDiagnostics({
    workspaceRoot: config.defaultWorkspaceRoot,
    canonicalRepoPath: repoRoot,
    tasks,
    limit: 20,
  }).catch((error) => ({ ok: false, error: error?.message || String(error || "retained worktree diagnostics failed") }));
  const resolvedLegacyReview = tasks.filter((task) => isResolvedLegacyReviewTask(task));
  const currentBlockers = {
    running: policyQueue[TASK_STATUSES.RUNNING] || 0,
    waiting_for_lock: policyQueue[TASK_STATUSES.WAITING_FOR_LOCK] || 0,
    waiting_for_review: policyQueue[TASK_STATUSES.WAITING_FOR_REVIEW] || 0,
    waiting_for_repair: policyQueue[TASK_STATUSES.WAITING_FOR_REPAIR] || 0,
    waiting_for_integration: policyQueue[TASK_STATUSES.WAITING_FOR_INTEGRATION] || 0,
    actionable_review: queue.actionable_review ?? policyQueue[TASK_STATUSES.WAITING_FOR_REVIEW] ?? 0,
    failed: policyQueue[TASK_STATUSES.FAILED] || 0,
    total: queue.current_blockers ?? 0,
  };
  const packageScripts = scriptsFromPackage(repoRoot);
  const backendScripts = scriptsFromPackage(join(repoRoot, "backend"));

  return {
    ok: true,
    repo: {
      root: repoRoot,
      branch,
      head,
      dirty: dirty.length > 0,
      dirty_paths: dirty.slice(0, 40),
    },
    config: {
      workspace_root: config.defaultWorkspaceRoot,
      state_path: config.statePath,
      tool_mode: config.toolMode || "standard",
      render_mode: config.renderMode || "text",
      default_repo: config.defaultRepo || "",
      default_branch: config.defaultBranch || "",
    },
    project_files: fileStatus(repoRoot, ["README.md", "AGENTS.md", "SKILL.md", "project.md", "project.env", "package.json", "backend/package.json"]),
    scripts: {
      root: packageScripts.slice(0, 20),
      backend: backendScripts.slice(0, 20),
      suggested_tests: backendScripts.includes("npm run test") ? ["npm --prefix backend test"] : ["npm --prefix backend test", "npm --prefix backend run check:syntax"],
    },
    state_summary: {
      tasks: state.tasks?.length || 0,
      goals: state.goals?.length || 0,
      workspaces: state.workspaces?.length || 0,
      recent_tasks: tasks.slice(-5).reverse().map((task) => ({
        id: task.id,
        title: task.title || "",
        status: task.status,
        assignee: task.assignee || "",
        legacy_resolution: legacyResolutionSummary(task),
      })),
      recent_goals: (state.goals || []).slice(-5).reverse().map((goal) => ({ id: goal.id, title: goal.title || "", status: goal.status, assignee: goal.assignee || "" })),
    },
    current_blockers: currentBlockers,
    raw_history: {
      waiting_for_review_total: tasks.filter((task) => isHumanReviewStatus(task.status)).length,
      resolved_legacy_review: resolvedLegacyReview.length,
      resolved_legacy_review_tasks: resolvedLegacyReview.slice(0, 20).map((task) => ({
        id: task.id,
        title: task.title || "",
        ...legacyResolutionSummary(task),
      })),
    },
    worker: {
      enabled: process.env.GPTWORK_CODEX_WORKER === "true",
      running: !!workerState?.running,
      queue,
    },
    worktree_retention: retainedWorktrees,
    repositories: typeof registry?.list === "function" ? registry.list().slice(0, 20) : [],
    file_tree: boundedTree(repoRoot, 80),
    readme_excerpt: (() => {
      try { return readFileSync(join(repoRoot, "README.md"), "utf8").slice(0, TEXT_LIMIT); } catch { return ""; }
    })(),
    recommended_next_tools: ["create_encoded_goal", "list_tasks", "get_task", "runtime_status", "worker_status"],
  };
}
