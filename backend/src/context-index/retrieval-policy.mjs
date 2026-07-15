const TASK_ID_RE = /\btask_[a-z0-9-]+\b/gi;
const GOAL_ID_RE = /\bgoal_[a-z0-9-]+\b/gi;
const WORKSTREAM_ID_RE = /\b(?:ws|workstream)_[a-z0-9-]+\b/gi;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/gi;
const PATH_RE = /(?:^|\s|[`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|\s|[`'"),:])/g;

const INTENT_SOURCE_WEIGHTS = {
  runtime_diagnosis: { task: 0.24, runtime: 0.3, result: 0.12, goal: 0.05, conversation: -0.08 },
  acceptance: { result: 0.24, evidence: 0.3, test: 0.22, goal: 0.08, conversation: -0.06 },
  implementation: { code: 0.3, file: 0.28, goal: 0.08, result: 0.05, conversation: -0.05 },
  history: { result: 0.2, conversation: 0.14, goal: 0.08 },
  documentation: { docs: 0.28, file: 0.16, goal: 0.1 },
  mixed: { goal: 0.06, result: 0.06, code: 0.06, docs: 0.06 },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractRetrievalEntities(queryText = "") {
  const text = String(queryText);
  const paths = [];
  for (const match of text.matchAll(PATH_RE)) paths.push(match[1]);
  return {
    task_ids: unique(text.match(TASK_ID_RE) || []),
    goal_ids: unique(text.match(GOAL_ID_RE) || []),
    workstream_ids: unique(text.match(WORKSTREAM_ID_RE) || []),
    commits: unique(text.match(COMMIT_RE) || []),
    paths: unique(paths),
  };
}

export function analyzeRetrievalIntent(queryText = "", context = {}) {
  const text = String(queryText).toLowerCase();
  let intent = "mixed";
  if (/waiting_for_|worker|runtime|运行态|队列|锁|lock|heartbeat|process|status/.test(text)) intent = "runtime_diagnosis";
  else if (/accept|验收|verification|verify|review|evidence|test|通过|失败/.test(text)) intent = "acceptance";
  else if (/历史|曾经|以前|previous|history|prior|old task/.test(text)) intent = "history";
  else if (/文档|说明|architecture|design|docs?|spec/.test(text)) intent = "documentation";
  else if (/修复|实现|代码|function|class|module|file|commit|bug|refactor/.test(text)) intent = "implementation";

  const entities = extractRetrievalEntities(queryText);
  return {
    intent,
    entities,
    requires_fresh_state: intent === "runtime_diagnosis",
    current_task_id: context.taskId || context.task_id || null,
    current_goal_id: context.goalId || context.goal_id || null,
    root_goal_id: context.rootGoalId || context.root_goal_id || null,
    workstream_id: context.workstreamId || context.workstream_id || null,
    allow_cross_lineage: intent === "history" || entities.task_ids.length > 0 || entities.goal_ids.length > 0,
  };
}

function exactEntityMatches(candidate, plan) {
  const metadata = candidate.metadata || {};
  const haystack = [candidate.text, metadata.task_id, metadata.goal_id, metadata.root_goal_id, metadata.workstream_id, metadata.source_path]
    .filter(Boolean).join("\n").toLowerCase();
  const entities = [
    ...plan.entities.task_ids,
    ...plan.entities.goal_ids,
    ...plan.entities.workstream_ids,
    ...plan.entities.commits,
    ...plan.entities.paths,
  ];
  return entities.filter((entity) => haystack.includes(String(entity).toLowerCase()));
}

function followupDepth(candidate) {
  const text = String(candidate.text || "");
  const prefixes = text.match(/(?:Followup|Repair|Converge remaining issues)\s*:/gi) || [];
  return prefixes.length;
}

export function scoreRetrievalCandidate(candidate, plan) {
  const metadata = candidate.metadata || {};
  const base = Number(candidate.score || 0);
  const sourceType = String(metadata.source_type || "unknown").toLowerCase();
  const matches = exactEntityMatches(candidate, plan);
  const breakdown = {
    base_retrieval: base,
    exact_entity: matches.length > 0 ? 0.55 + Math.min(0.15, (matches.length - 1) * 0.05) : 0,
    intent_source: INTENT_SOURCE_WEIGHTS[plan.intent]?.[sourceType] || 0,
    current_task: plan.current_task_id && metadata.task_id === plan.current_task_id ? 0.22 : 0,
    same_root_goal: plan.root_goal_id && metadata.root_goal_id === plan.root_goal_id ? 0.16 : 0,
    same_workstream: plan.workstream_id && metadata.workstream_id === plan.workstream_id ? 0.12 : 0,
    cross_lineage_penalty: 0,
    followup_penalty: 0,
    stale_runtime_penalty: 0,
  };

  const crossTask = plan.current_task_id && metadata.task_id && metadata.task_id !== plan.current_task_id;
  const crossRoot = plan.root_goal_id && metadata.root_goal_id && metadata.root_goal_id !== plan.root_goal_id;
  if (!plan.allow_cross_lineage && matches.length === 0 && (crossTask || crossRoot) && ["result", "conversation"].includes(sourceType)) {
    breakdown.cross_lineage_penalty = -0.45;
  }

  const depth = Number(metadata.lineage_depth || followupDepth(candidate));
  if (!plan.allow_cross_lineage && matches.length === 0 && depth >= 2) {
    breakdown.followup_penalty = -Math.min(0.4, depth * 0.1);
  }

  if (plan.requires_fresh_state && metadata.freshness && metadata.freshness !== "live") {
    breakdown.stale_runtime_penalty = -0.35;
  }

  const score = Object.values(breakdown).reduce((sum, value) => sum + Number(value || 0), 0);
  const selectionReasons = [];
  if (matches.length) selectionReasons.push("exact_entity_match");
  if (breakdown.current_task > 0) selectionReasons.push("same_task");
  if (breakdown.same_root_goal > 0) selectionReasons.push("same_root_goal");
  if (breakdown.same_workstream > 0) selectionReasons.push("same_workstream");
  if (breakdown.intent_source > 0) selectionReasons.push(`preferred_source_for_${plan.intent}`);
  if (breakdown.cross_lineage_penalty < 0) selectionReasons.push("cross_lineage_penalty");
  if (breakdown.followup_penalty < 0) selectionReasons.push("deep_followup_penalty");

  return {
    ...candidate,
    score,
    base_score: base,
    score_breakdown: breakdown,
    selection_reasons: selectionReasons,
    exact_entity_matches: matches,
  };
}

export function rerankRetrievalCandidates(candidates = [], plan, topK = 5) {
  const ranked = candidates.map((candidate) => scoreRetrievalCandidate(candidate, plan))
    .sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, topK);
  Object.defineProperty(selected, "policyDiagnostics", {
    enumerable: false,
    value: {
      intent: plan.intent,
      requires_fresh_state: plan.requires_fresh_state,
      exact_entities: plan.entities,
      candidate_count: ranked.length,
      selected_count: selected.length,
      cross_lineage_penalized_count: ranked.filter((item) => item.score_breakdown.cross_lineage_penalty < 0).length,
      deep_followup_penalized_count: ranked.filter((item) => item.score_breakdown.followup_penalty < 0).length,
    },
  });
  return selected;
}
