/**
 * supervisor-review-packet-schema.mjs — SupervisorReviewPacket schema.
 *
 * A SupervisorReviewPacket is the immutable input to ChatGPT's review.
 * It bundles the ReviewRevision, objective, architecture baseline,
 * execution context, repository state, verification artifacts, and
 * TUI session snapshot into a single structured document.
 *
 * No secrets, tokens, or environment variables are included.
 *
 * @module supervisor-review/supervisor-review-packet-schema
 */

const DEFAULT_ALLOWED_ACTIONS = Object.freeze([
  "continue_codex",
  "send_correction",
  "pause_codex",
  "chatgpt_takeover",
  "wait",
]);

const DEFAULT_REVIEW_QUESTIONS = Object.freeze([
  "实现是否仍沿着既定产品与架构方向推进？",
  "是否新增了重复状态、重复 Store、旁路执行链或兼容性主权？",
  "是否通过测试但绕过 Canonical Acceptance/Progression？",
  "是否只修复症状而未解决根因？",
  "继续当前方向的长期产品化代价是什么？",
]);

/**
 * Create a SupervisorReviewPacket.
 *
 * @param {object} input
 * @param {object} input.run - ExecutionRun (must have .id)
 * @param {object} input.revision - ReviewRevision (must have .id)
 * @param {string} [input.goalText] - Goal description
 * @param {string} [input.taskText] - Task description
 * @param {string} [input.desiredOutcome] - Desired outcome
 * @param {string[]} [input.nonGoals] - Non-goals
 * @param {string[]} [input.principles] - Architecture principles
 * @param {string[]} [input.prohibitedPatterns] - Prohibited patterns
 * @param {string[]} [input.requiredFlow] - Required flow
 * @param {string[]} [input.designDocs] - Design docs
 * @param {object} input.repository - Repository evidence
 * @param {string[]} [input.commands] - Verification commands
 * @param {string[]} [input.tests] - Test results
 * @param {string[]} [input.blockers] - Blockers
 * @param {string[]} [input.evidenceGaps] - Evidence gaps
 * @param {object} [input.session] - TUI session info
 * @param {string} [input.progress] - TUI progress
 * @param {string} [input.recentLogExcerpt] - Recent log excerpt
 * @param {object[]} [input.priorDecisions] - Prior decisions
 * @param {string} [input.currentPlanNode] - Current plan node
 * @param {string[]} [input.allowedActions] - Allowed actions
 * @param {number} [input.maxCorrectionScopeFiles] - Max files for correction
 * @returns {object} SupervisorReviewPacket
 * @throws {Error} If run.id or revision.id is missing
 */
export function createSupervisorReviewPacket(input = {}) {
  if (!input.run?.id) throw new Error("run.id is required");
  if (!input.revision?.id) throw new Error("revision.id is required");

  return {
    schema_version: 1,
    id: `review_packet_${input.revision.id.slice(0, 20)}`,
    revision: input.revision,

    objective: {
      goal_text: input.goalText || null,
      task_text: input.taskText || null,
      desired_outcome: input.desiredOutcome || null,
      non_goals: input.nonGoals || [],
    },

    architecture_baseline: {
      principles: input.principles || [],
      prohibited_patterns: input.prohibitedPatterns || [],
      required_flow: input.requiredFlow || [],
      design_docs: input.designDocs || [],
    },

    execution: {
      run_id: input.run.id,
      run_state: input.run.state || null,
      controller_owner: input.run.supervision?.controller_owner || null,
      current_plan_node: input.currentPlanNode || null,
      correction_cycles: input.run.supervision?.correction_cycles || 0,
      prior_decisions: input.priorDecisions || [],
    },

    repository: {
      worktree_path: input.repository?.worktree_path || null,
      base_sha: input.repository?.base_sha || null,
      head_sha: input.repository?.head_sha || null,
      changed_files: input.repository?.changed_files || [],
      diff_summary: input.repository?.diff_summary || "",
      focused_diff: input.repository?.focused_diff || "",
      new_symbols: input.repository?.new_symbols || [],
      deleted_symbols: input.repository?.deleted_symbols || [],
    },

    verification: {
      commands: input.commands || [],
      tests: input.tests || [],
      blockers: input.blockers || [],
      evidence_gaps: input.evidenceGaps || [],
    },

    tui: {
      session_id: input.session?.session_id || null,
      native_session_id: input.session?.native_session_id || null,
      status: input.session?.status || null,
      progress: input.progress || null,
      recent_log_excerpt: input.recentLogExcerpt || "",
    },

    review_questions: [...DEFAULT_REVIEW_QUESTIONS],

    limits: {
      max_correction_scope_files: input.maxCorrectionScopeFiles ?? 20,
      allowed_actions: input.allowedActions
        ? [...input.allowedActions]
        : [...DEFAULT_ALLOWED_ACTIONS],
    },

    created_at: new Date().toISOString(),
  };
}
