import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { requireScope } from "../auth-context.mjs";
import { queryContextStatus } from "../diagnostics-service.mjs";
import { detectStaleTempClones } from "../repo-registry.mjs";

/**
 * Scoped MCP tool group: context health diagnostic and repair tools.
 * Handlers expose project context source health, precedence diagnostics,
 * safe auto-fix for context hygiene, and stale temp clone detection.
 */
export function createContextHealthToolsGroup({ tool, schema, config, registry, store }) {
  /** Wrapper for project_context_status and context_status alias handlers. */
  const contextStatusHandler = async ({ task_id }, context) =>
    queryContextStatus(task_id, context, { config, registry, store });

  /**
   * Context prepare handler: safe auto-fix for context hygiene.
   * Supports check (dry-run) and fix_safe modes.
   */
  const contextPrepareHandler = async ({ task_id, mode = "check" }, context) => {
    requireScope(context, "task:read");

    // Validate mode
    if (!["check", "fix_safe"].includes(mode)) {
      throw new Error(`Invalid mode "${mode}". Supported modes: check, fix_safe`);
    }

    // Resolve canonical repo path
    let canonicalRepoPath = config.defaultRepoPath || null;
    let repoRecord = null;
    if (registry) {
      const defaultRepo = registry.getDefaultRepo() || null;
      if (defaultRepo && typeof defaultRepo === "object") repoRecord = defaultRepo;
      if (!repoRecord && config.defaultRepoPath) {
        repoRecord = registry.findByPath(config.defaultRepoPath) || null;
      }
      if (repoRecord && repoRecord.canonical_path) {
        canonicalRepoPath = repoRecord.canonical_path;
      }
    }

    // Get context status BEFORE any changes
    const before = await queryContextStatus(task_id, context, { config, registry, store });

    // Check for dirty repo - refuse to run fix_safe if dirty
    const isFix = mode === "fix_safe";
    if (isFix && canonicalRepoPath) {
      try {
        if (existsSync(join(canonicalRepoPath, ".git"))) {
          const dirtyOut = execSync("git status --short 2>/dev/null", { cwd: canonicalRepoPath, timeout: 5000, encoding: "utf8" }).trim();
          if (dirtyOut.length > 0) {
            return {
              mode,
              changed: false,
              error: "refusing_to_fix_dirty_worktree",
              error_detail: "Canonical repo has uncommitted changes. Commit or stash before running fix_safe to avoid racing with another Codex run.",
              actions_planned: [],
              actions_applied: [],
              skipped_actions: [{ action: "all_fixes", reason: "dirty worktree - refusing to race" }],
              warnings: [...before.warnings, { severity: "error", code: "dirty_worktree_refused", message: "Cannot run fix_safe on dirty worktree." }],
              project_context_status_before: before,
              no_secrets_exposed: true,
            };
          }
        }
      } catch (e) {}
    }

    // Check if repo paths exist
    const gptworkDir = canonicalRepoPath ? join(canonicalRepoPath, ".gptwork") : null;
    const projectMdPath = gptworkDir ? join(gptworkDir, "project.md") : null;
    const projectEnvPath = gptworkDir ? join(gptworkDir, "project.env") : null;

    const gptworkDirExists = gptworkDir ? existsSync(gptworkDir) : false;
    const projectMdExists = projectMdPath ? existsSync(projectMdPath) : false;
    const projectEnvExists = projectEnvPath ? existsSync(projectEnvPath) : false;
    let projectEnvEmpty = false;
    if (projectEnvExists) {
      try {
        const content = readFileSync(projectEnvPath, "utf8").trim();
        projectEnvEmpty = content.length === 0;
      } catch (e) { projectEnvEmpty = true; }
    }

    const actionsPlanned = [];
    const actionsApplied = [];
    const skippedActions = [];
    const filesCreated = [];
    const filesModified = [];
    const prepareWarnings = [];
    let changed = false;

    // Fix 1: Create .gptwork/ directory if missing
    if (!gptworkDirExists && canonicalRepoPath) {
      actionsPlanned.push({
        action: "create_gptwork_dir",
        target: gptworkDir,
        description: "Create .gptwork/ directory under canonical repo.",
        safe: true,
      });
      if (isFix) {
        await mkdir(gptworkDir, { recursive: true });
        actionsApplied.push({ action: "create_gptwork_dir", target: gptworkDir, description: "Created .gptwork/ directory." });
        filesCreated.push(gptworkDir);
        changed = true;
      }
    } else if (!canonicalRepoPath) {
      skippedActions.push({ action: "create_gptwork_dir", reason: "No canonical repo path configured." });
      prepareWarnings.push({ severity: "warning", code: "no_canonical_repo", message: "Cannot prepare context files without a canonical repo path." });
    }

    // Fix 2: Create project.md template if missing
    const projectMdTemplate = [
      "# " + (canonicalRepoPath ? basename(canonicalRepoPath) : "Project Name"),
      "",
      "## Purpose",
      "<!-- TODO: Describe the project purpose, domain, and scope -->",
      "",
      "## Development",
      "<!-- TODO: Document test commands, build steps, linting -->",
      "Test commands:",
      "",
      "## Deployment",
      "<!-- TODO: Document deploy procedures, hosts, env requirements -->",
      "",
      "## Notes",
      "> **Do not store secrets here.**",
      "> Project-level context files are loaded by Codex but must not contain sensitive credentials.",
      "> Use .gptwork/project.env for non-secret environment variables only.",
      "",
    ].join("\n");

    if (!projectMdExists && projectMdPath) {
      actionsPlanned.push({
        action: "create_project_md",
        target: projectMdPath,
        description: "Create .gptwork/project.md from minimal template.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectMdPath, projectMdTemplate, "utf8");
        actionsApplied.push({ action: "create_project_md", target: projectMdPath, description: "Created .gptwork/project.md from minimal template." });
        filesCreated.push(projectMdPath);
        changed = true;
      }
    } else if (projectMdExists) {
      skippedActions.push({ action: "create_project_md", reason: "project.md already exists. fix_safe never overwrites existing content." });
    }

    // Fix 3: Create project.env template if missing
    const projectEnvTemplate = [
      "# Project environment variables (non-secret)",
      "# This file is loaded by Codex context builder on each execution.",
      "# Key=Value format. Lines starting with # are comments.",
      "",
      "# Database",
      "# DB_HOST=localhost",
      "# DB_PORT=5432",
      "",
      "# Application",
      "# APP_ENV=development",
      "# LOG_LEVEL=debug",
      "",
      "# Notes:",
      "# - Do NOT store real secrets here. Use runtime.env for secrets (requires restart).",
      "# - project.env is hot-loaded on every Codex context build, not runtime.env.",
      "# - project.env does NOT mutate process.env - it is only used for Codex context.",
      "",
    ].join("\n");

    if (!projectEnvExists && projectEnvPath) {
      actionsPlanned.push({
        action: "create_project_env",
        target: projectEnvPath,
        description: "Create .gptwork/project.env from minimal non-secret template.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectEnvPath, projectEnvTemplate, "utf8");
        actionsApplied.push({ action: "create_project_env", target: projectEnvPath, description: "Created .gptwork/project.env from minimal non-secret template." });
        filesCreated.push(projectEnvPath);
        changed = true;
      }
    } else if (projectEnvExists && !projectEnvEmpty) {
      skippedActions.push({ action: "create_project_env", reason: "project.env already exists with content. fix_safe never overwrites existing content." });
    }

    // Fix 4: Empty project.env gets template comments
    if (projectEnvExists && projectEnvEmpty && projectEnvPath) {
      actionsPlanned.push({
        action: "populate_empty_project_env",
        target: projectEnvPath,
        description: "project.env is empty. Add non-secret template comments.",
        safe: true,
      });
      if (isFix) {
        await writeFile(projectEnvPath, projectEnvTemplate, "utf8");
        actionsApplied.push({ action: "populate_empty_project_env", target: projectEnvPath, description: "Added non-secret template comments to empty project.env." });
        filesModified.push(projectEnvPath);
        changed = true;
      }
    }

    // Fix 5: Task without linked goal - warning only, no write
    if (task_id) {
      const taskHasGoal = before.task && before.task.linked_goal_id;
      if (!taskHasGoal) {
        actionsPlanned.push({
          action: "suggest_create_goal_for_task",
          target: task_id,
          description: "Task has no linked goal. Suggested flow: create_goal / create_task to link a goal.",
          safe: true,
        });
        prepareWarnings.push({
          severity: "info",
          code: "task_no_linked_goal",
          message: "Task has no linked goal. Use create_goal or assign a goal via create_task.",
          suggested_flow: ["create_goal(user_request, goal_prompt, assign_to_codex=true)", "create_task(..., description) with encoded goal"],
        });
      }
    }

    // Build output
    const output = {
      mode,
      changed,
      actions_planned: actionsPlanned,
      actions_applied: actionsApplied,
      skipped_actions: skippedActions,
      warnings: prepareWarnings,
      project_context_status_before: before,
      files_created: filesCreated,
      files_modified: filesModified,
      no_secrets_exposed: true,
    };

    // Add "after" snapshot when changes were made
    if (isFix) {
      const after = await queryContextStatus(task_id, context, { config, registry, store });
      output.project_context_status_after = after;
    }

    return output;
  };

  return {
    detect_stale_clones: tool({
      name: "detect_stale_clones",
      description: "Scan the workspace root for stale temporary clones (.tmp-* directories) that could confuse Codex status checks. Returns matching directory names and whether they contain git repos.",
      inputSchema: schema({}),
      modes: ["operator", "full"],
      audience: ["operator"],
      tags: ["context", "cleanup"],
      handler: async () => {
        const clones = await detectStaleTempClones(registry.workspaceRoot);
        return { count: clones.length, clones };
      },
    }),

    project_context_status: tool({
      name: "project_context_status",
      description: "Return a concise diagnostic showing context source health and precedence: canonical repo, workspace root, project context files (project.md, project.env), context source precedence summary, and optionally task-linked diagnostics (task status, linked goal, preview availability, warnings). Does not expose secret values from project.env.",
      inputSchema: schema({ task_id: "string" }, []),
      modes: ["standard", "operator", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["context", "status"],
      handler: contextStatusHandler,
    }),

    context_status: tool({
      name: "context_status",
      description: "Provide context source health and precedence diagnostics: canonical repo, workspace root, project context files (project.md, project.env), context source precedence summary, and optionally task-linked diagnostics (task status, linked goal, preview availability, warnings). Natural alias for project_context_status, responds to queries like 上下文状态. Does not expose secret values from project.env.",
      inputSchema: schema({ task_id: "string" }, []),
      modes: ["standard", "operator", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["context", "status"],
      handler: contextStatusHandler,
    }),

    context_prepare: tool({
      name: "context_prepare",
      description: "Prepare safe context hygiene fixes after project_context_status detects issues. Defaults to check-only (dry-run). In fix_safe mode, creates missing .gptwork/ directory, project.md, and project.env templates. Never overwrites existing content or exposes secrets. If the repo is dirty or another Codex run is active, stops and reports rather than racing.",
      inputSchema: schema({ task_id: "string", mode: "string" }, []),
      modes: ["standard", "operator", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["context", "repair"],
      handler: contextPrepareHandler,
    }),
  };
}
