import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoDir, collectRuntimeGitInfoCached, collectRestartMarkerStatus, withCache } from "../diagnostics-service.mjs";
import { getRepoLockSummary } from "../repo-lock.mjs";
import { workerStatusSnapshot, workerStatusExtendedSnapshot } from "../codex-worker-state.mjs";
import { scanPendingRestartMarkersSync } from "../safe-restart.mjs";

/**
 * Scoped MCP tool group: runtime/status diagnostic tools.
 * Read-only handlers that expose process, git, config, Bark, GitHub,
 * repo registry, and worker diagnostics without secrets.
 */
export function createRuntimeStatusToolsGroup({
  tool, schema, config, sources, envLoadResult, bark, github, registry, store,
  workerState, PROCESS_STARTED_AT, collectWorkerQueueCounts
}) {
  function hasProcessEnvRuntimeConfig() {
    return Object.values(sources || {}).some((source) => source === "process.env");
  }

  function isRuntimeEnvConfigured() {
    return envLoadResult.keys.length > 0 || hasProcessEnvRuntimeConfig();
  }

  async function getCachedRepoLockSummary() {
    return withCache(
      "repoLockSummary:" + (config.defaultWorkspaceRoot || "none"),
      2000,
      () => getRepoLockSummary(config.defaultWorkspaceRoot)
    );
  }

  return {
    github_status: tool({
      name: "github_status",
      description: "Return GitHub sync configuration, known issue count, and last-sync diagnostics.",
      inputSchema: schema({}),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["system", "github"],
      handler: async () => {
        const syncDiag = typeof github.getSyncDiagnostics === "function" ? github.getSyncDiagnostics() : {};
        return {
          enabled: github.enabled,
          repo: github.status().api_repo || '',
          known_issues: github.getKnownIssues().length,
          config_source: sources.githubEnabled,
          repo_configured: !!config.githubRepo,
          token_configured: !!config.githubToken,
          last_sync_at: syncDiag.last_sync_at || null,
          last_sync_ok: syncDiag.last_sync_ok,
          last_sync_error: syncDiag.last_sync_error || null,
          last_imported_tasks: syncDiag.last_imported_tasks ?? 0,
          last_imported_responses: syncDiag.last_imported_responses ?? 0,
          last_scanned_issue_count: syncDiag.last_scanned_issue_count ?? 0,
          last_raw_api_issue_count: syncDiag.last_raw_api_issue_count ?? 0,
          skipped_reasons: syncDiag.skipped_reasons || [],
        };
      },
    }),

    runtime_status: tool({
      name: "runtime_status",
      description: "Return safe runtime diagnostics: process info, git state, config, env file and state file status.",
      inputSchema: schema({}),
      modes: ["minimal", "standard", "operator", "codex", "full"],
      audience: ["chatgpt", "codex", "operator"],
      tags: ["system", "runtime"],
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async () => {
        const startTime = Date.now();
        const repoDir = resolveRepoDir();
        const gitInfo = await collectRuntimeGitInfoCached(repoDir);
        const statePath = config.statePath;
        const statePathAbs = statePath.startsWith("/") ? statePath : join(process.cwd(), statePath);
        const statePathInsideRepo = repoDir ? statePathAbs.startsWith(repoDir) : false;

        const envPath = envLoadResult.loadedPath;
        let envFileExists = false;
        if (envPath) {
          try {
            envFileExists = existsSync(envPath);
          } catch (e) {}
        }

        const restartMarkerData = await collectRestartMarkerStatus(config.defaultWorkspaceRoot);

        const queueCounts = await collectWorkerQueueCounts(store);
        return {
          elapsed_ms: Date.now() - startTime,
          queue: queueCounts,
          pid: process.pid,
          started_at: PROCESS_STARTED_AT.toISOString(),
          repo_head: gitInfo.repo_head,
          remote_head: gitInfo.remote_head,
          running_commit: gitInfo.running_commit,
          defaultWorkspaceRoot: config.defaultWorkspaceRoot,
          codex_exec_timeout: config.codexExecTimeout,
          codex_first_output_timeout: config.codexFirstOutputTimeout,
          codex_exec_args: config.codexExecArgs,
          shell_timeout: config.shellTimeout,
          max_read_bytes: config.maxReadBytes,
          max_shell_output_bytes: config.maxShellOutputBytes,
          default_repo: config.defaultRepo,
          default_branch: config.defaultBranch,
          default_repo_path: config.defaultRepoPath,
          default_remote: config.defaultRemote,
          runtime_env_file_path: envPath,
          runtime_env_file_exists: envFileExists,
          runtime_env_loaded: envLoadResult.keys.length > 0,
          runtime_env_configured: isRuntimeEnvConfigured(),
          runtime_env_keys_loaded: envLoadResult.keys,
          state_path: statePath,
          state_path_inside_repo: statePathInsideRepo,
          worktree_dirty: gitInfo.worktree_dirty,
          dirty_paths: gitInfo.dirty_paths,
          restart_markers: restartMarkerData,
          config_sources: {
            codex_exec_timeout: sources.codexExecTimeout,
            codex_first_output_timeout: sources.codexFirstOutputTimeout,
            shell_timeout: sources.shellTimeout,
            state_path: sources.statePath,
            default_repo: sources.defaultRepo,
            default_branch: sources.defaultBranch,
            default_repo_path: sources.defaultRepoPath,
            default_remote: sources.defaultRemote,
            bark_enabled: sources.barkEnabled,
            bark_url: sources.barkUrl,
            bark_key: sources.barkKey,
            github_enabled: sources.githubEnabled,
            github_repo: sources.githubRepo,
            github_token: sources.githubToken,
            workspace_root: sources.workspaceRoot,
            max_read_bytes: sources.maxReadBytes,
            max_shell_output_bytes: sources.maxShellOutputBytes,
          },
          bark: bark ? {
            enabled: bark.isEnabled ? bark.isEnabled() : false,
            configured: bark.getStatus ? bark.getStatus().configured : false,
            source: bark.getStatus ? bark.getStatus().source : "unknown",
            url_set: bark.getStatus ? bark.getStatus().url_set : false,
            key_set: bark.getStatus ? bark.getStatus().key_set : false,
            group: bark.getStatus ? bark.getStatus().group : "gptwork",
          } : { enabled: false, configured: false, source: "none" },
          github: {
            api_sync_enabled: github.enabled,
            api_repo_set: !!config.githubRepo,
            api_token_set: !!config.githubToken,
            source: sources.githubEnabled,
            direct_git_available: true,
            direct_git_reader_available: true,
          },
          repo_locks: await getCachedRepoLockSummary(),
          worker: workerStatusExtendedSnapshot(workerState),
          queue: await collectWorkerQueueCounts(store),
        };
      },
    }),

    notification_status: tool({
      name: "notification_status",
      description: "Return safe Bark notification configuration and last-attempt diagnostics (no endpoint/key values).",
      inputSchema: schema({}),
      modes: ["operator", "full"],
      audience: ["operator"],
      tags: ["system", "notification"],
      handler: async () => bark ? bark.getStatus() : ({ enabled: false, configured: false, source: "unknown", url_set: false, key_set: false, group: "gptwork", sound_set: false, level_set: false, icon_set: false, url_action_set: false, last_attempt_at: null, last_success_at: null, last_failure_at: null, last_response_code: null, last_response_message: null, last_error_short: null, last_task_id: null, last_task_status: null, last_task_event: null }),
    }),

    gptwork_doctor: tool({
      name: "gptwork_doctor",
      description: "Return a comprehensive user-facing diagnostic summary: process info, runtime config, git state, repo registry, stale clones, worktree health, Bark/GitHub sync status, placeholder tool exposure, and suggested next actions. Does not expose secrets.",
      inputSchema: schema({ deep: "boolean" }, []),
      modes: ["standard", "operator", "codex", "full"],
      audience: ["chatgpt", "operator"],
      tags: ["system", "doctor"],
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async ({ deep = false }) => {
        const startTime = Date.now();
        const repoDir = resolveRepoDir();
        const registryData = { entries: [], count: 0, hasCanonical: false };
        try {
          const allRepos = registry.list();
          registryData.entries = allRepos;
          registryData.count = allRepos.length;
          registryData.hasCanonical = allRepos.some(r => r.canonical_path === config.defaultRepoPath);
        } catch (e) {}
        let staleCloneCount = 0;
        if (deep) {
          try {
            const wsRoot = config.defaultWorkspaceRoot || "";
            if (wsRoot && existsSync(wsRoot)) {
              const entries = readdirSync(wsRoot, { withFileTypes: true });
              staleCloneCount = entries.filter(e => e.isDirectory() && e.name.startsWith('.tmp-')).length;
            }
          } catch (e) {}
        }
        const gitInfo = await collectRuntimeGitInfoCached(repoDir);
        const worktreeDirty = gitInfo.worktree_dirty;
        const dirtyPaths = gitInfo.dirty_paths;
        const exposePlaceholder = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS === 'true';
        const _lockSummary = await getCachedRepoLockSummary();
        const queueCounts = await collectWorkerQueueCounts(store);
        return {
          pid: process.pid,
          started_at: PROCESS_STARTED_AT.toISOString(),
          running_commit: gitInfo.running_commit,
          runtime_env_loaded: envLoadResult.keys.length > 0,
          runtime_env_configured: isRuntimeEnvConfigured(),
          runtime_env_file_path: envLoadResult.loadedPath || null,
          workspace_root: config.defaultWorkspaceRoot,
          hosted_default_root_aligned: config.defaultWorkspaceRoot === '/home/a9017/mcp/workspace',
          default_repo: config.defaultRepo,
          default_branch: config.defaultBranch,
          default_repo_path: config.defaultRepoPath,
          repository_registry_count: registryData.count,
          repository_registry_has_canonical_repo: registryData.hasCanonical,
          stale_clone_count: staleCloneCount,
          worktree_dirty: worktreeDirty,
          dirty_paths: dirtyPaths,
          codex_exec_timeout: config.codexExecTimeout,
          github_api_sync_enabled: github.enabled,
          direct_git_reader_available: true,
          bark_configured: bark ? (bark.getStatus ? bark.getStatus().configured : false) : false,
          bark_enabled: bark ? (bark.isEnabled ? bark.isEnabled() : false) : false,
          placeholder_tools_exposed: exposePlaceholder || false,
          suggested_next_actions: (() => {
            const actions = [];
            if (!isRuntimeEnvConfigured()) actions.push('Set up runtime.env with GPTWORK_* variables or configure via process.env');
            if (!registryData.hasCanonical) actions.push('Register the canonical repo via register_repository');
            if (staleCloneCount > 0) actions.push('Clean up ' + staleCloneCount + ' stale clone(s) (rm -rf .tmp-* in workspace root)');
            if (worktreeDirty) actions.push('Commit or stash dirty worktree changes');
            if (config.defaultRepo !== '9018/gpt-codex-workspace') actions.push('Set GPTWORK_DEFAULT_REPO=9018/gpt-codex-workspace for canonical repo resolution');
            (() => {
              try {
                const markers = scanPendingRestartMarkersSync(config.defaultWorkspaceRoot);
                const active = markers.filter(m => ['pending','scheduled','restarted'].includes(m.status));
                if (active.length > 0) {
                  actions.push(active.length + ' active restart marker(s) (' + active.map(m => m.task_id.slice(0,12) + ':' + m.status).join(', ') + ') — complete or verify via schedule_service_restart');
                }
              } catch(e) {}
            })();
            (() => {
              try {
                const canonPath = config.defaultRepoPath;
                if (canonPath) {
                  const pmdPath = join(canonPath, ".gptwork", "project.md");
                  const penvPath = join(canonPath, ".gptwork", "project.env");
                  const mdExists = existsSync(pmdPath);
                  const envExists = existsSync(penvPath);
                  if (!mdExists || !envExists) {
                    actions.push('Run project_context_status / context_status for project context health — missing ' + (!mdExists ? 'project.md' : '') + (!mdExists && !envExists ? ' and ' : '') + (!envExists ? 'project.env' : ''));
                  }
                  if (envExists) {
                    try {
                      const envContent = readFileSync(penvPath, "utf8").trim();
                      if (!envContent) {
                        actions.push('Run project_context_status / context_status for project context health — project.env exists but is empty');
                      }
                    } catch (e) {}
                  }
                }
              } catch (e) {}
            })();

            (() => {
              try {
                if (_lockSummary.active_repo_locks > 0 || _lockSummary.stale_repo_locks > 0) {
                  const parts = [];
                  if (_lockSummary.active_repo_locks > 0) parts.push(_lockSummary.active_repo_locks + ' active');
                  if (_lockSummary.stale_repo_locks > 0) parts.push(_lockSummary.stale_repo_locks + ' stale');
                  actions.push('Run repo_lock_status / list_repo_locks to inspect ' + parts.join(' and ') + ' repo lock(s) — concurrent Codex execution may be blocked');
                }
              } catch (e) {}
            })();

            (() => {
              try {
                if (workerState.enabled && !workerState.last_tick_started_at && !workerState.last_error) {
                  actions.push('Codex worker enabled but has not completed its first tick yet — check GPTWORK_CODEX_WORKER env and service logs');
                }
                if (!workerState.enabled) {
                  const qcount = queueCounts.queued + queueCounts.assigned;
                  if (qcount > 0) {
                    actions.push(qcount + ' Codex task(s) queued/assigned but worker is disabled — set GPTWORK_CODEX_WORKER=true or process tasks manually');
                  }
                }
                const watchdogInterval = workerState.current_interval_ms ?? workerState.interval_ms;
                if (workerState.last_tick_finished_at && watchdogInterval != null) {
                  const elapsed = Date.now() - new Date(workerState.last_tick_finished_at).getTime();
                  if (elapsed > watchdogInterval * 3) {
                    actions.push('Codex worker last tick completed ' + Math.round(elapsed / 1000) + 's ago (>3x current interval) — check worker health');
                  }
                }
                if (workerState.last_error) {
                  actions.push('Codex worker last tick error: ' + workerState.last_error.slice(0, 120));
                }
                if (queueCounts.waiting_for_lock > 0) {
                  actions.push(queueCounts.waiting_for_lock + ' Codex task(s) waiting for repo lock — run list_repo_locks to see blocked tasks');
                }
                if (queueCounts.waiting_for_review > 0) {
                  actions.push(queueCounts.waiting_for_review + ' Codex task(s) waiting for review — check and approve or reassign');
                }
              } catch (e) {}
            })();
            return actions;
          })(),
          elapsed_ms: Date.now() - startTime,
          queue: queueCounts,
          worker: {
            ...workerStatusExtendedSnapshot(workerState),
          },
          repo_locks: _lockSummary,
        };
      },
    }),
  };
}
