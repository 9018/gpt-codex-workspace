import { formatToolCard, formatKeyValue, formatDiagnostics, formatWarnings, formatNextActions, formatStatusChip, truncateOutput, truncateVerboseOutput } from "./card-format-utils.mjs";

export function runtimeStatusCard(data) {
  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    '',
    formatKeyValue('worker', data.worker ? (data.worker.enabled ? 'enabled' : 'disabled') : '?'),
    formatKeyValue('queue assigned', data.worker?.queue?.assigned ?? '?'),
  ];

  // Bark (safe)
  if (data.bark) {
    lines.push(formatKeyValue('Bark', data.bark.enabled ? 'enabled' : 'not configured'));
  }

  // GitHub
  if (data.github) {
    const ghStatus = data.github.api_sync_enabled ? 'enabled' : 'disabled';
    const ghRepo = data.github.api_repo_set ? (data.github.api_sync_enabled ? 'yes' : 'configured, sync off') : 'not configured';
    lines.push(formatKeyValue('GitHub', `${ghStatus} (${ghRepo})`));
  }

  // Diagnostics - collect warnings
  const diagnostics = [];
  if (data.worktree_dirty) {
    diagnostics.push({ severity: 'warning', message: `Dirty worktree (${(data.dirty_paths || []).length} file(s))` });
  }
  if (data.runtime_env_loaded === false && !data.runtime_env_configured) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env loaded' });
  }

  return formatToolCard('Runtime Status', { lines, diagnostics });
}


/**
 * Format gptwork_doctor structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from gptwork_doctor
 * @returns {string}
 */
export function gptworkDoctorCard(data) {
  const lines = [
    formatKeyValue('pid', data.pid),
    formatKeyValue('started', data.started_at),
    formatKeyValue('running commit', data.running_commit ? data.running_commit.slice(0, 12) : '-'),
    formatKeyValue('worktree', data.worktree_dirty ? 'dirty' : 'clean'),
    formatKeyValue('env file', data.runtime_env_loaded ? 'loaded' : (data.runtime_env_configured ? 'process.env' : 'missing')),
    formatKeyValue('registry repos', data.repository_registry_count ?? 0),
    formatKeyValue('stale clones', data.stale_clone_count ?? 0),
    formatKeyValue('GitHub sync', data.github_api_sync_enabled ? 'enabled' : 'disabled'),
    formatKeyValue('Bark', data.bark_configured ? 'configured' : 'not configured'),
    formatKeyValue('worker', data.worker?.enabled ? 'enabled' : 'disabled'),
  ];

  // Build diagnostics from doctor data
  const diagnostics = [];
  if (data.worktree_dirty) {
    diagnostics.push({ severity: 'warning', message: `Worktree dirty (${(data.dirty_paths || []).length} file(s))` });
  }
  if (data.stale_clone_count > 0) {
    diagnostics.push({ severity: 'warning', message: `${data.stale_clone_count} stale clone(s) in workspace root` });
  }
  if (!data.runtime_env_loaded && !data.runtime_env_configured) {
    diagnostics.push({ severity: 'warning', message: 'No runtime.env -- set GPTWORK_* variables or create runtime.env' });
  }
  if (!data.repository_registry_has_canonical_repo) {
    diagnostics.push({ severity: 'warning', message: 'Canonical repo not registered -- use register_repository' });
  }

  const nextActions = (data.suggested_next_actions || []).slice(0, 8);

  return formatToolCard('GPTWork Doctor', { lines, diagnostics, nextActions });
}


/**
 * Format get_task structured data as a compact card.
 *
 * @param {object} data   - The structuredContent from get_task
 * @returns {string}
 */
