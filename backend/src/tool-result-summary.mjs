import { runtimeStatusCard, workerStatusCard, gptworkDoctorCard, getTaskCard, createEncodedGoalCard, contextStatusCard, githubStatusCard, previewCodexContextCard, shellExecCard, gitRemoteDiffCard, readTextFileCard, listDirCard, goalContextCard, formatToolCard, formatKeyValue } from "./card-utils.mjs";

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
        case "worker_status":
          return workerStatusCard(structuredContent);
        case "get_goal_context":
          return goalContextCard(structuredContent);
        case "open_project_context": {
          const ctx = structuredContent;
          const lines = [
            formatKeyValue('repo', ctx.repo?.root || '-'),
            formatKeyValue('branch', ctx.repo?.branch || '-'),
            formatKeyValue('head', ctx.repo?.head || '-'),
            formatKeyValue('worktree', ctx.repo?.dirty ? 'dirty' : 'clean'),
            formatKeyValue('tasks', ctx.state_summary?.tasks ?? 0),
            formatKeyValue('goals', ctx.state_summary?.goals ?? 0),
            formatKeyValue('tool mode', ctx.config?.tool_mode || 'standard'),
          ];
          if (Array.isArray(ctx.recommended_next_tools) && ctx.recommended_next_tools.length) {
            lines.push('', 'Next tools: ' + ctx.recommended_next_tools.join(', '));
          }
          return formatToolCard('Project Context', { lines });
        }

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
            const statusCounts = {};
            const assigneeCounts = {};
            for (const t of tasks) {
              const st = t.status || "unknown";
              statusCounts[st] = (statusCounts[st] || 0) + 1;
              const a = t.assignee || "unassigned";
              assigneeCounts[a] = (assigneeCounts[a] || 0) + 1;
            }
            const sb = Object.entries(statusCounts).map(function(e) { return e[0] + "=" + e[1]; }).join(", ");
            const ab = Object.entries(assigneeCounts).map(function(e) { return e[0] + "=" + e[1]; }).join(", ");
            const recent = tasks.slice(-5).reverse().map(function(t) { return t.id.slice(-8) + " " + (t.mode || "-") + " " + (t.assignee || "-") + " " + (t.title || "").slice(0, 30); }).join("\n    ");
            let card = tasks.length + " task(s)\n  Status: [" + sb + "]";
            if (ab) card += "\n  Assignees: [" + ab + "]";
            if (recent) card += "\n  Recent:\n    " + recent;
            return card;
          }
          case "list_goals": {
            const goals = structuredContent.goals || [];
            const statusCounts = {};
            const assigneeCounts = {};
            for (const g of goals) {
              const st = g.status || "unknown";
              statusCounts[st] = (statusCounts[st] || 0) + 1;
              const a = g.assignee || "unassigned";
              assigneeCounts[a] = (assigneeCounts[a] || 0) + 1;
            }
            const sb = Object.entries(statusCounts).map(function(e) { return e[0] + "=" + e[1]; }).join(", ");
            const ab = Object.entries(assigneeCounts).map(function(e) { return e[0] + "=" + e[1]; }).join(", ");
            const recent = goals.slice(-3).reverse().map(function(g) { return g.id.slice(-8) + " " + (g.mode || "-") + " " + (g.assignee || "-") + " " + (g.title || "").slice(0, 40); }).join("\n    ");
            let card = goals.length + " goal(s)\n  Status: [" + sb + "]";
            if (ab) card += "\n  Assignees: [" + ab + "]";
            if (recent) card += "\n  Recent:\n    " + recent;
            return card;
          }
          case "worker_status":
            return workerStatusCard(structuredContent);
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
        case "show_changes": {
          const d = structuredContent;
          const lines = [
            formatKeyValue('repo', d.repo || '-'),
            formatKeyValue('summary', d.summary || '-'),
            formatKeyValue('staged', d.staged_count ?? 0),
            formatKeyValue('unstaged', d.unstaged_count ?? 0),
          ];
          if (d.changed_files && Array.isArray(d.changed_files)) {
            const cf = d.changed_files.slice(0, 5).map(function(f) { return '    ' + (f.path || f); }).join('\n');
            lines.push('');
            lines.push('  changed files: ' + d.changed_files.length);
            lines.push(cf);
          }
          return formatToolCard('Changes', { lines });
        }
        case "read_handoff": {
          const s = structuredContent.status || {};
          const lines = [
            formatKeyValue('agent', s.agent || '-'),
            formatKeyValue('status', s.status || '-'),
            formatKeyValue('goal_id', s.goal_id || '-'),
            formatKeyValue('plan', structuredContent.plan ? (structuredContent.plan.split('\n').length + ' lines') : 'none'),
          ];
          return formatToolCard('Handoff', { lines });
        }
        case "list_goal_queue":
        case "get_goal_queue": {
          const items = structuredContent.items || structuredContent.item || [];
          const arr = Array.isArray(items) ? items : (items ? [items] : []);
          const sc = {};
          for (const i of arr) { const st = i.status || '?'; sc[st] = (sc[st] || 0) + 1; }
          const sb = Object.entries(sc).map(function(e) { return e[0] + '=' + e[1]; }).join(', ');
          const lines = [ formatKeyValue('items', arr.length), formatKeyValue('statuses', sb || '-') ];
          if (arr.length > 0 && arr.length <= 5) {
            for (const i of arr) { lines.push('  [' + (i.status || '?') + '] ' + (i.goal_id || i.queue_id || '').slice(0, 40)); }
          }
          return formatToolCard('Goal Queue', { lines });
        }
        case "start_next_queued_goal": {
          const d = structuredContent;
          const lines = [ formatKeyValue('started', d.started ? 'yes' : 'no') ];
          if (d.queue_item) lines.push(formatKeyValue('queue_id', d.queue_item.queue_id || '-'));
          if (d.task) lines.push(formatKeyValue('task_id', d.task.id || '-'));
          if (d.dry_run) lines.push(formatKeyValue('dry_run', 'true'));
          return formatToolCard('Start Next', { lines });
        }
        case "gptwork_self_test": {
          const d = structuredContent;
          const lines = [ formatKeyValue('summary', d.summary || '-') ];
          if (Array.isArray(d.results)) {
            const passed = d.results.filter(function(r) { return r.status === 'PASS'; }).length;
            const failed = d.results.filter(function(r) { return r.status === 'FAIL'; }).length;
            lines.push(formatKeyValue('passed', passed));
            lines.push(formatKeyValue('failed', failed));
          }
          return formatToolCard('Self Test', { lines });
        }
          default:
            return JSON.stringify(structuredContent);
        }
      } catch {
        return JSON.stringify(structuredContent);
      }

}
