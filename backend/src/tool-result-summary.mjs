import { runtimeStatusCard, gptworkDoctorCard, getTaskCard, createEncodedGoalCard, contextStatusCard, githubStatusCard, previewCodexContextCard, shellExecCard, gitRemoteDiffCard, readTextFileCard, listDirCard, goalContextCard, formatToolCard, formatKeyValue } from "./card-utils.mjs";

export function summarizeToolResult(name, structuredContent) {
      if (!structuredContent || typeof structuredContent !== "object") return JSON.stringify(structuredContent);

      // Use compact card formatting for targeted tools
      switch (name) {
        case "runtime_status":
          return runtimeStatusCard(structuredContent);
        case "gptwork_doctor":
          return gptworkDoctorCard(structuredContent);
        case "get_task":
          return getTaskCard(structuredContent);
        case "create_encoded_goal":
          return createEncodedGoalCard(structuredContent);
        case "context_status":
        case "project_context_status":
          return contextStatusCard(structuredContent);
        case "github_status":
          return githubStatusCard(structuredContent);
        case "preview_codex_context":
          return previewCodexContextCard(structuredContent);
        case "shell_exec":
          return shellExecCard(structuredContent);
        case "git_remote_diff":
          return gitRemoteDiffCard(structuredContent);
        case "read_text_file":
          return readTextFileCard(structuredContent);
        case "list_dir":
          return listDirCard(structuredContent);
        case "get_goal_context":
          return goalContextCard(structuredContent);

      }

      // Fallback: built-in summary for tools without dedicated card formatters
      try {
        switch (name) {
          case "create_encoded_goal": {
            const g = structuredContent.goal;
            const lines = g ? [
              formatKeyValue('goal', g.id),
              formatKeyValue('title', (g.title || "").slice(0, 60)),
              formatKeyValue('status', g.status),
              formatKeyValue('assignee', g.assignee || '-'),
            ] : ['  Goal not found'];
            return formatToolCard('Goal', { lines });
          }
          case "runtime_status": {
            const s = structuredContent;
            const lines = [
              formatKeyValue('pid', s.pid),
              formatKeyValue('commit', s.running_commit ? s.running_commit.slice(0, 12) : '-'),
              formatKeyValue('worktree', s.worktree_dirty ? 'dirty' : 'clean'),
              '',
              formatKeyValue('worker', s.worker?.enabled ? 'enabled' : 'disabled'),
              formatKeyValue('queue', s.worker?.queue?.assigned ?? '?'),
            ];
            return formatToolCard('Runtime Status', { lines });
          }
          case "gptwork_doctor": {
            const d = structuredContent;
            const lines = [
              formatKeyValue('running commit', d.running_commit ? d.running_commit.slice(0, 12) : '-'),
              formatKeyValue('env', d.runtime_env_loaded ? 'loaded' : 'missing'),
              formatKeyValue('repo registry', d.repository_registry_count || 0),
              formatKeyValue('stale clones', d.stale_clone_count || 0),
              formatKeyValue('worktree', d.worktree_dirty ? 'dirty' : 'clean'),
            ];
            return formatToolCard('GPTWork Doctor', { lines });
          }
          case "search_files": {
            const sch = structuredContent;
            return "Search \"" + (sch.q || "") + "\" in \"" + (sch.path || ".") + "\": " + (sch.count || 0) + " result(s)" + (sch.backend ? " [" + sch.backend + "]" : "") + (sch.elapsed_ms != null ? " " + sch.elapsed_ms + "ms" : "");
          }
          case "list_tasks": {
            const tasks = structuredContent.tasks || [];
            return tasks.length + " task(s)";
          }
          case "list_goals": {
            const goals = structuredContent.goals || [];
            return goals.length + " goal(s)";
          }

          case "worker_status": {
            const w = structuredContent;
            const lines = [
              formatKeyValue('worker', w.enabled ? 'enabled' : 'disabled'),
              formatKeyValue('running', w.running ? 'yes' : 'no'),
              formatKeyValue('interval', w.interval_ms ? w.interval_ms + 'ms' : '?'),
              formatKeyValue('queue assigned', w.queue?.assigned ?? w.queues?.assigned ?? 0),
              formatKeyValue('queue running', w.queue?.running ?? w.queues?.running ?? 0),
            ];
            const warnings = [];
            if (w.last_error) warnings.push('Last error: ' + w.last_error.slice(0, 120));
            if (w.last_tick_finished_at) lines.push(formatKeyValue('last tick', w.last_tick_finished_at));
            return formatToolCard('Worker Status', { lines, warnings });
          }
          case "health_check": {
            const h = structuredContent;
            const lines = [
              formatKeyValue('service', h.service || 'gptwork-mcp'),
              formatKeyValue('time', h.time || new Date().toISOString()),
            ];
            return formatToolCard('Health', { lines });
          }
          case "sync_to_github": {
            const sy = structuredContent;
            return "GitHub sync: " + (sy.synced_tasks ?? "?") + " tasks, " + (sy.synced_requests ?? "?") + " requests";
          }
          default:
            return JSON.stringify(structuredContent);
        }
      } catch {
        return JSON.stringify(structuredContent);
      }

}
