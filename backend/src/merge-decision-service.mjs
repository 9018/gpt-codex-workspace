import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function evaluateMergeDecision({ goalId, workspace, evidence, acceptance }) {
  if (!acceptance) {
    return { decision: 'reject', reason: 'no acceptance result found' };
  }

  const checks = {
    acceptance_passed: acceptance.verdict === 'passed' && acceptance.merge_recommendation === 'merge',
    worktree_clean: evidence?.worktree_clean === true,
    result_contract_valid: evidence?.result_md_present === true && evidence?.result_json_present === true,
    reviewed_head_current: acceptance.reviewed_candidate_head === evidence?.candidate_head,
    merge_conflict: false
  };

  const canMerge = checks.acceptance_passed && checks.worktree_clean && checks.result_contract_valid && checks.reviewed_head_current;
  const reason = canMerge
    ? 'all merge checks passed'
    : !checks.acceptance_passed ? 'acceptance not passed'
    : !checks.worktree_clean ? 'worktree is dirty'
    : !checks.result_contract_valid ? 'result files missing'
    : !checks.reviewed_head_current ? 'reviewed head is stale'
    : 'unknown reason';

  return { decision: canMerge ? 'merge' : 'reject', reason, checks };
}
