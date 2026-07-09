export function normalizeAcceptanceResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    goal_id: raw.goal_id || '',
    stage: 'accept',
    provider: 'codex_tui_goal',
    verdict: ['passed', 'failed', 'partial', 'blocked'].includes(raw.verdict) ? raw.verdict : 'failed',
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    blocking_findings: Array.isArray(raw.blocking_findings) ? raw.blocking_findings : [],
    non_blocking_findings: Array.isArray(raw.non_blocking_findings) ? raw.non_blocking_findings : [],
    required_changes: Array.isArray(raw.required_changes) ? raw.required_changes : [],
    merge_recommendation: ['merge', 'do_not_merge', 'repair_first', 'ask_user'].includes(raw.merge_recommendation) ? raw.merge_recommendation : 'do_not_merge',
    reviewed_candidate_head: raw.reviewed_candidate_head || '',
    created_at: raw.created_at || new Date().toISOString()
  };
}
