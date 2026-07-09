/**
 * response-ingestor.mjs — Ingest GPTChat acceptance responses and create repair goals if needed.
 *
 * After GPTChat reviews an acceptance bundle and sends back a structured response,
 * this module:
 * 1. Parses the structured response (decision, findings, repair_instructions)
 * 2. If accepted: records the acceptance decision in the task/goal state
 * 3. If rejected or changes requested: creates a repair goal with full context
 * 4. Handles deduplication to avoid creating duplicate repair goals for the same issue
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { goalWorkspaceFiles } from '../goal-files.mjs';
import { scheduleRepairAttempt } from '../repair-loop.mjs';


function workspaceRootForGoal(goal, config = {}) {
  return goal?.workspace_root || config.defaultWorkspaceRoot || config.workspaceRoot || process.cwd();
}

function resolveWorkspacePath(root, filePath) {
  if (!filePath) return null;
  return isAbsolute(filePath) ? filePath : join(root || process.cwd(), filePath);
}

/**
 * Parse a GPTChat acceptance response string into structured data.
 *
 * Supports both JSON code block format and plain JSON.
 * Falls back to free-text analysis when JSON is not present.
 *
 * @param {string} responseText - GPTChat's response text
 * @returns {{ decision: string, summary: string, findings: Array, repair_instructions: string|null, followups: Array, parsed: boolean }}
 */
export function parseAcceptanceResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return {
      decision: 'unknown',
      summary: 'No response provided',
      findings: [],
      repair_instructions: null,
      followups: [],
      parsed: false,
    };
  }

  // Try to extract JSON from ```json ... ``` blocks first
  let jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  let parsed = {};

  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1]);
    } catch {
      // Try plain JSON parsing as fallback
      try {
        parsed = JSON.parse(responseText);
      } catch {
        // Not parseable as JSON — treat as free-text decision
      }
    }
  } else {
    // Try parsing the entire response as JSON
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // Fallback: extract decision from free text
      return parseFreeTextDecision(responseText);
    }
  }

  // Validate decision
  const validDecisions = ['accepted', 'rejected', 'changes_requested'];
  const decision = parsed.decision && validDecisions.includes(parsed.decision)
    ? parsed.decision
    : 'unknown';

  return {
    decision,
    summary: parsed.summary || '',
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding) : [],
    repair_instructions: parsed.repair_instructions || null,
    followups: Array.isArray(parsed.followups) ? parsed.followups : [],
    parsed: true,
  };
}

/**
 * Fallback: extract decision from free-form text.
 */
function parseFreeTextDecision(text) {
  const lower = text.toLowerCase();
  let decision = 'unknown';
  let summary = text.slice(0, 500);

  if (/\baccept(ed|ance)?\b/.test(lower) && !/\bnot\s+accept|\breject|\bdecline/.test(lower)) {
    decision = 'accepted';
  } else if (/\breject(ed)?\b|\bdenied\b|\bfailed\b/.test(lower)) {
    decision = 'rejected';
  } else if (/\bchange(s|d)?\s*request|\bfollow.?up\b|\bimprove|\brefine\b/.test(lower)) {
    decision = 'changes_requested';
  }

  return {
    decision,
    summary,
    findings: [],
    repair_instructions: summary,
    followups: [],
    parsed: false,
  };
}

/**
 * Normalize a finding object to a standard shape.
 */
function normalizeFinding(finding) {
  if (typeof finding === 'string') {
    return { severity: 'major', code: 'gptchat_finding', message: finding, source: 'gptchat_acceptance' };
  }
  return {
    severity: finding.severity || 'major',
    code: finding.code || 'gptchat_acceptance_finding',
    message: finding.message || finding.title || '',
    source: finding.source || 'gptchat_acceptance',
    evidence: finding.evidence || null,
  };
}

/**
 * Check for deduplication — whether a repair goal already exists for this
 * combination of task + decision + findings.
 *
 * Prevents creating duplicate repair goals for the same issue on repeated
 * GPTChat response ingestions.
 *
 * @param {object} options
 * @param {object} options.store - State store
 * @param {string} options.taskId - The task ID
 * @param {string} options.decision - Acceptance decision
 * @param {Array} options.findings - Acceptance findings
 * @returns {{ isDuplicate: boolean, reason: string, existingGoalIds: string[] }}
 */
export async function checkAcceptanceDeduplication({ store, taskId, decision, findings } = {}) {
  if (!taskId || !store) {
    return { isDuplicate: false, reason: 'No store or taskId for dedup check', existingGoalIds: [] };
  }

  const state = await store.load();
  state.goals ||= [];
  state.tasks ||= [];

  // Build a fingerprint from this acceptance result
  const findingCodes = (findings || []).map((f) => f.code).filter(Boolean).sort().join(',');
  const dedupKey = `gptchat_accept:${taskId}:${decision}:${findingCodes}`;

  // Check existing goals for matching dedup_key or gptchat_acceptance markers
  const matchingGoals = state.goals.filter((g) => {
    const key = g.dedup_key || g.gptchat_acceptance_dedup_key || '';
    const title = (g.title || '').toLowerCase();
    return (
      key === dedupKey ||
      (title.includes('acceptance') && title.includes(taskId.slice(0, 12)))
    );
  });

  if (matchingGoals.length > 0) {
    return {
      isDuplicate: true,
      reason: `Duplicate acceptance repair goal exists: ${matchingGoals.map((g) => g.id).join(', ')}`,
      existingGoalIds: matchingGoals.map((g) => g.id),
    };
  }

  return { isDuplicate: false, reason: 'No duplicate found', existingGoalIds: [] };
}

/**
 * Ingest a GPTChat acceptance response and update task/goal state.
 *
 * If rejected, creates a repair goal with full context.
 * If accepted, records the acceptance in the task result.
 * If changes_requested, creates follow-up tasks.
 *
 * @param {object} options
 * @param {object} options.store - State store
 * @param {object} options.config - Server config
 * @param {string} options.taskId - The task that was reviewed
 * @param {string} options.responseText - GPTChat's response text
 * @param {object} [options.bundle] - The pre-loaded acceptance bundle (for repair context)
 * @param {object} [options.goal] - The original goal (for repair context)
 * @param {object} [options.task] - The original task (for repair context)
 * @returns {Promise<{ ingested: boolean, decision: string, repairGoalCreated: boolean, repairGoalId: string|null, repairTaskId: string|null, warnings: string[], dedup: object }>}
 */
export async function ingestAcceptanceResponse({
  store,
  config = {},
  taskId,
  responseText,
  bundle,
  goal,
  task,
} = {}) {
  const warnings = [];
  const parsed = parseAcceptanceResponse(responseText);

  if (!parsed.decision || parsed.decision === 'unknown') {
    warnings.push('Could not parse GPTChat acceptance decision from response. Task status unchanged.');
    return {
      ingested: false,
      decision: 'unknown',
      repairGoalCreated: false,
      repairGoalId: null,
      repairTaskId: null,
      warnings,
      dedup: { isDuplicate: false, reason: 'no_decision', existingGoalIds: [] },
    };
  }

  // Ensure task and goal are resolved
  let resolvedTask = task;
  let resolvedGoal = goal;
  if (!resolvedTask || !resolvedGoal) {
    const state = await store.load();
    if (!resolvedTask) resolvedTask = state.tasks?.find((t) => t.id === taskId);
    if (!resolvedGoal && resolvedTask?.goal_id) {
      resolvedGoal = state.goals?.find((g) => g.id === resolvedTask.goal_id);
    }
  }

  // Record acceptance decision in task result
  const now = new Date().toISOString();
  const acceptanceRecord = {
    gptchat_acceptance: {
      decision: parsed.decision,
      reviewed_at: now,
      summary: parsed.summary,
      findings: parsed.findings,
      followups: parsed.followups,
      repair_instructions: parsed.repair_instructions,
    },
  };

  // Store acceptance record. Prefer the task's explicit result path; otherwise
  // derive the durable goal workspace path instead of hard-coding a repository
  // location. This keeps hosted, SSH, and test stores portable.
  if (resolvedTask) {
    const goalFiles = resolvedGoal ? goalWorkspaceFiles(resolvedGoal) : {};
    const goalRoot = workspaceRootForGoal(resolvedGoal, config);
    const resultPath = resolvedTask.result_json_path
      ? resolveWorkspacePath(goalRoot, resolvedTask.result_json_path)
      : resolveWorkspacePath(goalRoot, goalFiles.result_json);

    if (resultPath) {
      try {
        const existing = JSON.parse(await readFile(resultPath, 'utf8'));
        existing.gptchat_acceptance = acceptanceRecord.gptchat_acceptance;
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify(existing, null, 2), 'utf8');
      } catch {
        warnings.push('Could not update result.json with GPTChat acceptance record');
      }
    }
  }

  // Handle decision
  switch (parsed.decision) {
    case 'accepted': {
      // Record acceptance on the store task object
      if (resolvedTask) {
        await store.mutate((state) => {
          const taskObj = state.tasks?.find((t) => t.id === taskId);
          if (taskObj) {
            taskObj.result = taskObj.result || {};
            taskObj.result.gptchat_acceptance = acceptanceRecord.gptchat_acceptance;
            taskObj.result.acceptance = taskObj.result.acceptance || {};
            taskObj.result.acceptance.status = 'accepted';
            taskObj.result.acceptance.reviewed_at = now;
            // If the task was waiting_for_review, advance it
            if (taskObj.status === 'waiting_for_review') {
              taskObj.status = 'completed';
            }
            taskObj.updated_at = now;
          }
        });
      }
      return {
        ingested: true,
        decision: 'accepted',
        repairGoalCreated: false,
        repairGoalId: null,
        repairTaskId: null,
        warnings,
        dedup: { isDuplicate: false, reason: 'accepted', existingGoalIds: [] },
      };
    }

    case 'rejected': {
      // Check deduplication
      const dedup = await checkAcceptanceDeduplication({
        store,
        taskId,
        decision: parsed.decision,
        findings: parsed.findings,
      });

      if (dedup.isDuplicate) {
        warnings.push(`Deduplication: ${dedup.reason}`);
        return {
          ingested: true,
          decision: 'rejected',
          repairGoalCreated: false,
          repairGoalId: null,
          repairTaskId: null,
          warnings,
          dedup,
        };
      }

      // Create repair goal
      try {
        const findings = parsed.findings.length > 0
          ? parsed.findings
          : [{ severity: 'blocker', code: 'gptchat_rejected', message: parsed.summary || parsed.repair_instructions || 'GPTChat rejected the result without specific findings', source: 'gptchat_acceptance' }];

        const repairResult = await scheduleRepairAttempt({
          store,
          task: resolvedTask || { id: taskId },
          goal: resolvedGoal || {},
          failure: {
            failure_class: 'acceptance_rejected',
            repair_strategy: 'acceptance_repair',
            reason: parsed.repair_instructions || parsed.summary || 'GPTChat rejection',
          },
          verification: {
            passed: false,
            findings,
            commands: [],
          },
          config,
          diff: '',
          logs: JSON.stringify({
            gptchat_acceptance: acceptanceRecord,
            bundle_summary: bundle?.result_summary?.summary || '',
          }),
        });

        // Mark the original task to reflect GPTChat rejection
        if (resolvedTask) {
          await store.mutate((state) => {
            const taskObj = state.tasks?.find((t) => t.id === taskId);
            if (taskObj) {
              taskObj.result = taskObj.result || {};
              taskObj.result.gptchat_acceptance = acceptanceRecord.gptchat_acceptance;
              taskObj.result.acceptance = taskObj.result.acceptance || {};
              taskObj.result.acceptance.status = 'rejected';
              taskObj.result.acceptance.reviewed_at = now;
              // Set dedup key on the repair task
              if (repairResult?.repair_task_id) {
                const dedupKey = `gptchat_accept:${taskId}:rejected:${findings.map(f => f.code).filter(Boolean).sort().join(',')}`;
                const repairTask = state.tasks?.find((t) => t.id === repairResult.repair_task_id);
                if (repairTask) repairTask.gptchat_acceptance_dedup_key = dedupKey;
                const repairGoalObj = state.goals?.find((g) => g.id === repairResult.repair_goal_id);
                if (repairGoalObj) repairGoalObj.gptchat_acceptance_dedup_key = dedupKey;
              }
              taskObj.updated_at = now;
            }
          });
        }

        return {
          ingested: true,
          decision: 'rejected',
          repairGoalCreated: true,
          repairGoalId: repairResult?.repair_goal_id || null,
          repairTaskId: repairResult?.repair_task_id || null,
          warnings,
          dedup,
        };
      } catch (err) {
        warnings.push(`Failed to create repair goal for rejected acceptance: ${err.message}`);
        return {
          ingested: true,
          decision: 'rejected',
          repairGoalCreated: false,
          repairGoalId: null,
          repairTaskId: null,
          warnings,
          dedup: { isDuplicate: false, reason: 'repair_creation_failed', existingGoalIds: [] },
        };
      }
    }

    case 'changes_requested': {
      // Similar to rejected but less severe — creates follow-ups
      if (resolvedTask) {
        await store.mutate((state) => {
          const taskObj = state.tasks?.find((t) => t.id === taskId);
          if (taskObj) {
            taskObj.result = taskObj.result || {};
            taskObj.result.gptchat_acceptance = acceptanceRecord.gptchat_acceptance;
            taskObj.result.acceptance = taskObj.result.acceptance || {};
            taskObj.result.acceptance.status = 'changes_requested';
            taskObj.result.acceptance.reviewed_at = now;
            taskObj.result.followups = [
              ...(Array.isArray(taskObj.result.followups) ? taskObj.result.followups : []),
              ...parsed.followups,
              ...(parsed.repair_instructions ? [{ message: parsed.repair_instructions, severity: 'followup' }] : []),
            ];
            // Keep task in waiting_for_review until changes are addressed
            if (taskObj.status === 'waiting_for_review') {
              taskObj.status = 'waiting_for_repair';
            }
            taskObj.updated_at = now;
          }
        });
      }
      return {
        ingested: true,
        decision: 'changes_requested',
        repairGoalCreated: false,
        repairGoalId: null,
        repairTaskId: null,
        warnings,
        dedup: { isDuplicate: false, reason: 'changes_requested', existingGoalIds: [] },
      };
    }

    default:
      warnings.push(`Unknown GPTChat acceptance decision: ${parsed.decision}. No action taken.`);
      return {
        ingested: true,
        decision: parsed.decision,
        repairGoalCreated: false,
        repairGoalId: null,
        repairTaskId: null,
        warnings,
        dedup: { isDuplicate: false, reason: 'unknown_decision', existingGoalIds: [] },
      };
  }
}
