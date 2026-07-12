/**
 * context-bundle-builder.mjs — Build bounded context.bundle.md from retrieved chunks.
 *
 * Given retrieved chunks and goal metadata, generates a compact markdown
 * bundle suitable for Codex prompt inclusion while keeping the full
 * transcript available for explicit deep lookup.
 */

export { buildContextManifest, CONTEXT_MANIFEST_SCHEMA_VERSION } from "./context-curator.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 2048;   // hard target for total bundle size (estimated)
const DEFAULT_MAX_CHUNKS = 8;       // keep selected context dense for Codex handoff
const DEFAULT_SUMMARY_CHARS = 600;
const DEFAULT_CONVERSATION_CHARS = 420;
const DEFAULT_RESULT_CHARS = 360;
const SECTION_HEADER = "<!-- context-bundle -->";
const DEFAULT_SOURCE_QUOTAS = Object.freeze({
  currentGoalMin: 1,
  resultMax: 2,
  conversationMax: 3,
});

const EVIDENCE_BOOSTS = Object.freeze({
  current_goal: 0.35,
  accepted_result: 0.25,
  repair_result: 0.22,
  integration_result: 0.2,
  result: 0.12,
  stale_or_noop_penalty: -0.3,
  parent_repair_chain: 0.18,
});

function clampPositiveInt(value, fallback, min = 1, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function truncateText(text = "", maxChars = 500) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function chunkCostTokens(chunk) {
  const explicit = Number(chunk?.tokens);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return estimateTokens(chunk?.text || "");
}

function sameScopeValue(goal, metadata, key) {
  const goalValue = goal?.[key];
  const chunkValue = metadata?.[key];
  if (goalValue === undefined || goalValue === null || goalValue === "") return true;
  if (chunkValue === undefined || chunkValue === null || chunkValue === "") return true;
  return String(goalValue) === String(chunkValue);
}

function isScopedToGoal(goal, chunk) {
  const metadata = chunk?.metadata || {};
  return ["workspace_id", "project_id", "repo_id"].every((key) => sameScopeValue(goal, metadata, key));
}

function isCurrentGoalChunk(goal, chunk) {
  const metadata = chunk?.metadata || {};
  if (goal?.id && metadata.goal_id === goal.id) return true;
  return !metadata.goal_id && metadata.source_type === "goal";
}

function quotaBucketFor(goal, chunk) {
  if (isCurrentGoalChunk(goal, chunk)) return "current_goal";
  const sourceType = chunk?.metadata?.source_type || "unknown";
  if (sourceType === "result") return "result";
  if (sourceType === "conversation") return "conversation";
  return sourceType;
}

function isRepairLikeGoal(goal, task) {
  const text = [goal?.mode, goal?.title, goal?.user_request, goal?.goal_prompt, task?.mode, task?.title, task?.description]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return /\b(repair|finalizer|finalize|retry|self-heal)\b|修复|返工|补救/.test(text);
}

function evidenceBoostFor(goal, task, chunk) {
  const metadata = chunk?.metadata || {};
  const sourceType = metadata.source_type || "unknown";
  const status = String(metadata.status || metadata.result_status || "").toLowerCase();
  const resultKind = String(metadata.result_kind || metadata.kind || metadata.task_kind || "").toLowerCase();
  const text = `${status} ${resultKind} ${chunk?.text || ""}`.toLowerCase();
  const reasons = [];
  let boost = 0;

  if (isCurrentGoalChunk(goal, chunk)) {
    boost += EVIDENCE_BOOSTS.current_goal;
    reasons.push("current_goal");
  }

  if (sourceType === "result") {
    boost += EVIDENCE_BOOSTS.result;
    reasons.push("result_evidence");
    if (/accepted|completed|success|passed|merged/.test(text)) {
      boost += EVIDENCE_BOOSTS.accepted_result;
      reasons.push("accepted_result");
    }
    if (/repair|fixed|fix|retry|self-heal|修复|返工/.test(text)) {
      boost += EVIDENCE_BOOSTS.repair_result;
      reasons.push("repair_result");
    }
    if (/integration|integrated|finalizer|finalized|handoff|merged/.test(text)) {
      boost += EVIDENCE_BOOSTS.integration_result;
      reasons.push("integration_result");
    }
  }

  if (/failed|failure|error|timeout|timed_out|no[-_ ]?op|noop|stale|cancelled/.test(text)) {
    boost += EVIDENCE_BOOSTS.stale_or_noop_penalty;
    reasons.push("stale_failed_noop_penalty");
  }

  if (isRepairLikeGoal(goal, task) && sourceType === "result" && /failed|failure|repair|parent|finalizer|timeout|error/.test(text)) {
    boost += EVIDENCE_BOOSTS.parent_repair_chain;
    reasons.push("parent_repair_chain");
  }

  if (reasons.length === 0) reasons.push(sourceType === "conversation" ? "conversation_baseline" : "baseline");
  return { boost, reason: reasons.join(",") };
}

function quotaLimitFor(bucket, quotas) {
  if (bucket === "result") return quotas.resultMax;
  if (bucket === "conversation") return quotas.conversationMax;
  return Number.POSITIVE_INFINITY;
}

function canFitChunk({ selectedLength, used, cost, sourceBudget }) {
  return selectedLength === 0 || used + cost <= sourceBudget;
}

function trimUtf8ToBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}


// ---------------------------------------------------------------------------
// Phase 2: Intent detection for retrieval filtering
// ---------------------------------------------------------------------------

/**
 * Determine if a goal has readonly or diagnostic intent.
 * @param {object} goal
 * @returns {boolean}
 */
function isReadonlyOrDiagnosticGoal(goal) {
  if (!goal) return false;
  const mode = (goal.mode || "").toLowerCase();
  const title = (goal.title || "").toLowerCase();
  const userRequest = (goal.user_request || "").toLowerCase();
  const goalPrompt = (goal.goal_prompt || "").toLowerCase();
  const combined = `${title} ${userRequest} ${goalPrompt}`;

  // Direct mode check
  if (["readonly", "diagnostic"].includes(mode)) return true;
  // Text-based intent detection
  const readonlySignals = [
    "read-only", "readonly", "read only",
    "diagnostic", "inspect", "report findings",
    "do not modify", "do not change", "no mutations",
    "do not write", "do not edit",
  ];
  const mutationSignals = [
    "edit", "modify", "write file", "update config",
    "restart", "deploy", "commit", "reboot",
    "systemctl", "sed -i", "rm ",
  ];
  const hasReadonlySignal = readonlySignals.some((s) => combined.includes(s));
  const hasMutationSignal = mutationSignals.some((s) => combined.includes(s));
  if (hasReadonlySignal && !hasMutationSignal) return true;
  if (hasReadonlySignal && hasMutationSignal) {
    const roCount = readonlySignals.filter((s) => combined.includes(s)).length;
    const mutCount = mutationSignals.filter((s) => combined.includes(s)).length;
    return roCount >= mutCount;
  }
  return false;
}

function selectBundleChunks(chunks = [], { goal = null, task = null, maxTokens = DEFAULT_MAX_TOKENS, maxChunks = DEFAULT_MAX_CHUNKS } = {}) {
  const cap = clampPositiveInt(maxChunks, DEFAULT_MAX_CHUNKS, 1, 20);
  const sourceBudget = Math.max(220, Math.floor(clampPositiveInt(maxTokens, DEFAULT_MAX_TOKENS, 256, 16000) * 0.52));
  const selected = [];
  const seen = new Set();
  const bucketCounts = new Map();
  let used = 0;
  const quotas = DEFAULT_SOURCE_QUOTAS;

  // Phase 2: Intent compatibility filtering
  // Determine if current goal is readonly/diagnostic
  const isReadonlyGoal = isReadonlyOrDiagnosticGoal(goal);

  const candidates = [];
  const input = Array.isArray(chunks) ? chunks : [];

  for (let originalIndex = 0; originalIndex < input.length; originalIndex++) {
    const chunk = input[originalIndex];
    if (!chunk || !chunk.text || !isScopedToGoal(goal, chunk)) continue;
    const id = chunk.id || `${chunk.metadata?.goal_id || "unknown"}:${chunk.metadata?.source_type || "unknown"}:${chunk.metadata?.chunk_index ?? originalIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // Phase 2: Filter out mutation chunks when current goal is readonly/diagnostic
    if (isReadonlyGoal && chunk.metadata?.goal_id && chunk.metadata?.goal_id !== goal?.id) {
      const chunkText = (chunk.text || "").toLowerCase();
      const hasMutationContent = /\b(systemctl\s+(restart|stop|start|enable|disable)|sed\s+-i\b|rm\s+(-\w+\s+)?(\/|\.)|git\s+(commit|push|merge|rebase|checkout\s+-b)|deploy|restart\s+(service|app|nginx|docker|system)|reboot|kubectl\s+(apply|delete|create|patch|rollout)|docker\s+(rm|kill|stop|start|restart|compose\s+(up|down)))/.test(chunkText);
      if (hasMutationContent) {
        // Mark as excluded but continue iterating (don't add to candidates)
        continue;
      }
    }


    const baseScore = Number.isFinite(Number(chunk.score)) ? Number(chunk.score) : 0;
    const { boost, reason } = evidenceBoostFor(goal, task, chunk);
    const bucket = quotaBucketFor(goal, chunk);
    const cost = Math.min(chunkCostTokens(chunk), 260);
    candidates.push({
      chunk,
      id,
      originalIndex,
      bucket,
      cost,
      baseScore,
      boost,
      boostReason: reason,
      effectiveScore: baseScore + boost,
    });
  }

  const ranked = [...candidates].sort((a, b) => {
    if (b.effectiveScore !== a.effectiveScore) return b.effectiveScore - a.effectiveScore;
    return a.originalIndex - b.originalIndex;
  });

  const selectedIds = new Set();
  const push = (entry, whySelected) => {
    if (!entry || selected.length >= cap || selectedIds.has(entry.id)) return false;
    const bucketLimit = quotaLimitFor(entry.bucket, quotas);
    const currentCount = bucketCounts.get(entry.bucket) || 0;
    if (currentCount >= bucketLimit) return false;
    if (!canFitChunk({ selectedLength: selected.length, used, cost: entry.cost, sourceBudget })) return false;

    const selection = {
      why_selected: whySelected,
      quota_bucket: entry.bucket,
      boost_reason: entry.boostReason,
      original_score: Number(entry.baseScore.toFixed(6)),
      effective_score: Number(entry.effectiveScore.toFixed(6)),
      selection_rank: selected.length + 1,
      source_budget_tokens: sourceBudget,
      quota: {
        current_goal_min: quotas.currentGoalMin,
        result_max: quotas.resultMax,
        conversation_max: quotas.conversationMax,
      },
    };

    selected.push({
      ...entry.chunk,
      id: entry.id,
      metadata: {
        ...(entry.chunk.metadata || {}),
        selection,
      },
    });
    selectedIds.add(entry.id);
    bucketCounts.set(entry.bucket, currentCount + 1);
    used += entry.cost;
    return true;
  };

  const currentGoalCandidates = ranked.filter((entry) => entry.bucket === "current_goal");
  for (const entry of currentGoalCandidates.slice(0, quotas.currentGoalMin)) {
    push(entry, "current_goal_minimum");
    if (selected.length >= cap) break;
  }

  for (const entry of ranked) {
    if (selected.length >= cap) break;
    push(entry, entry.bucket === "current_goal" ? "current_goal_rerank" : "quota_rerank");
  }

  return {
    selected,
    metadata: {
      total_candidates: candidates.length,
      selected_count: selected.length,
      source_budget_tokens: sourceBudget,
      quotas: {
        current_goal_min: quotas.currentGoalMin,
        result_max: quotas.resultMax,
        conversation_max: quotas.conversationMax,
      },
      bucket_counts: Object.fromEntries([...bucketCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      boosts: EVIDENCE_BOOSTS,
    },
  };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the selected context summary section.
 */
function buildContextSummarySection(goal, chunks) {
  const lines = [
    "## Selected Context Summary",
    "",
  ];

  if (chunks.length > 0) {
    // Include the highest-scored goal chunk for context
    const goalChunk = chunks.find((c) => c.metadata?.source_type === "goal");
    if (goalChunk) {
      lines.push(truncateText(goalChunk.text, DEFAULT_SUMMARY_CHARS));
      lines.push("");
    }
  } else if (goal?.context_summary) {
    lines.push(goal.context_summary);
    lines.push("");
  }

  lines.push(`Goal: **${goal?.title || "untitled"}**`);
  lines.push(`Status: ${goal?.status || "unknown"}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Build the relevant prior conversation section.
 */
function buildConversationSection(chunks) {
  const convChunks = chunks.filter((c) => c.metadata?.source_type === "conversation");
  if (convChunks.length === 0) return "";

  const lines = [
    "## Relevant Prior Conversation",
    "",
    "*Top relevant excerpts from the conversation transcript.*",
    "",
  ];

  for (const chunk of convChunks.slice(0, 3)) {
    const score = chunk.score !== undefined ? ` *(similarity: ${chunk.score.toFixed(3)})*` : "";
    const text = truncateText(chunk.text, DEFAULT_CONVERSATION_CHARS);
    lines.push(`> ${text.replace(/\n/g, "\n> ")}${score}`);
    lines.push("");
  }

  lines.push("*(Full transcript available at transcript.md)*\n");
  return lines.join("\n");
}

/**
 * Build the relevant prior tasks/results section.
 */
function buildResultsSection(chunks) {
  const resultChunks = chunks.filter((c) => c.metadata?.source_type === "result");
  if (resultChunks.length === 0) return "";

  const lines = [
    "## Relevant Prior Tasks / Results",
    "",
    "*Summaries from prior task results relevant to this goal.*",
    "",
  ];

  for (const chunk of resultChunks.slice(0, 2)) {
    const score = chunk.score !== undefined ? ` *(similarity: ${chunk.score.toFixed(3)})*` : "";
    lines.push(`- ${truncateText(chunk.text, DEFAULT_RESULT_CHARS)}${score}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the constraints and acceptance hints section.
 */
function buildConstraintsSection(goal) {
  const lines = [
    "## Constraints and Acceptance Hints",
    "",
    `- Execution mode: **${goal?.mode || "builder"}**`,
    `- Autonomy policy: ${goal?.autonomy_policy?.mode || "subagent_first"}`,
    `- GPT question budget: ${goal?.autonomy_policy?.gpt_question_budget ?? 0}`,
    "",
  ];

  if (goal?.autonomy_policy?.default_decision_rule) {
    lines.push(`- Decision rule: ${goal.autonomy_policy.default_decision_rule}`);
    lines.push("");
  }

  if (goal?.subagent_policy?.require_test_or_verification) {
    lines.push("- Tests or verification are required before completion.");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the omitted / full transcript note.
 */
function buildTranscriptNoteSection(workspaceFiles) {
  const transPath = workspaceFiles?.transcript_md || "transcript.md";
  return [
    "## Omitted / Full Transcript Note",
    "",
    "The full transcript has been omitted from this bundle to keep context size bounded.",
    `For complete conversation history, task details, and goal metadata, see \`${transPath}\`.`,
    "Explicit deep lookup into the transcript is available when this bundle's selected context",
    "is insufficient to resolve the current goal.",
    "",
  ].join("\n");
}

function buildRetrievalSourcesSection(chunks) {
  const lines = ["## Retrieval Sources", ""];
  if (!Array.isArray(chunks) || chunks.length === 0) {
    lines.push("- none");
    lines.push("");
    return lines.join("\n");
  }

  for (const chunk of chunks.slice(0, 8)) {
    const meta = chunk.metadata || {};
    const selection = meta.selection || {};
    const sourceType = meta.source_type || "unknown";
    const goalId = meta.goal_id || "unknown-goal";
    const sourcePath = meta.source_path || meta.result_path || meta.transcript_path || "inline context";
    const score = chunk.score !== undefined ? ` score=${Number(chunk.score).toFixed(3)}` : "";
    const decision = selection.quota_bucket
      ? ` bucket=${selection.quota_bucket} boost=${selection.boost_reason || "baseline"} why=${selection.why_selected || "selected"}`
      : "";
    lines.push(`- ${sourceType}: ${goalId} — ${sourcePath}${score}${decision}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Bundle builder
// ---------------------------------------------------------------------------

/**
 * Build a context.bundle.md string from retrieved chunks and goal metadata.
 *
 * @param {object} options
 * @param {Array<{ id: string, text: string, tokens: number, metadata: object, score?: number }>} options.chunks
 *   - Retrieved and scored chunks from the context index.
 * @param {object}  options.goal              - Goal object.
 * @param {object}  [options.workspaceFiles]  - Workspace file paths object for path references.
 * @param {{ chunkSize?: number, chunkOverlap?: number }} [options.chunkOptions]
 * @returns {{ bundle: string, sections: string[], tokenEstimate: number }}
 */
export function buildContextBundle(options = {}) {
  const { chunks = [], goal, task = null, workspaceFiles } = options;
  const maxTokens = clampPositiveInt(options.maxTokens, DEFAULT_MAX_TOKENS, 256, 16000);
  const maxChunks = clampPositiveInt(options.maxChunks, DEFAULT_MAX_CHUNKS, 1, 20);
  const selectionResult = selectBundleChunks(chunks, {
    goal,
    task,
    maxTokens,
    maxChunks,
  });
  const bundleChunks = selectionResult.selected;
  const selectionMetadata = selectionResult.metadata;

  const sections = [];

  // Section 1: header marker
  sections.push(SECTION_HEADER);
  sections.push("# Context Bundle");
  sections.push("");
  sections.push(
    "*Auto-generated context bundle. Prefer this file over the full transcript* " +
    "*for initial context; use the transcript for explicit deep lookup.*"
  );
  sections.push("");

  // Section 2: retrieval metadata. Keep this near the top so it survives
  // hard trimming when a caller asks for an extremely small bundle.
  const retrievedTypes = [...new Set(bundleChunks.map((c) => c.metadata?.source_type).filter(Boolean))];
  sections.push("## Retrieval Metadata");
  sections.push("");
  sections.push(`- Retrieved chunk types: ${retrievedTypes.join(", ") || "none"}`);
  sections.push(`- Total retrieved chunks: ${chunks.length}`);
  sections.push(`- Selected bundle chunks: ${bundleChunks.length}`);
  sections.push(`- Bundle max chunks: ${maxChunks}`);
  sections.push(`- Bundle max tokens: ${maxTokens}`);
  sections.push(`- Current goal quota: min ${selectionMetadata.quotas.current_goal_min}`);
  sections.push(`- Result quota: max ${selectionMetadata.quotas.result_max}`);
  sections.push(`- Conversation quota: max ${selectionMetadata.quotas.conversation_max}`);
  if (bundleChunks.some((c) => c.score !== undefined)) {
    const maxScore = Math.max(...bundleChunks.map((c) => c.score ?? 0));
    const minScore = Math.min(...bundleChunks.map((c) => c.score ?? 0));
    sections.push(`- Score range: ${minScore.toFixed(3)} — ${maxScore.toFixed(3)}`);
  }
  sections.push("");

  // Section 3: selected context summary
  sections.push(buildContextSummarySection(goal, bundleChunks));

  // Section 4: relevant prior conversation
  const convSection = buildConversationSection(bundleChunks);
  if (convSection) sections.push(convSection);

  // Section 5: relevant prior tasks/results
  const resSection = buildResultsSection(bundleChunks);
  if (resSection) sections.push(resSection);

  // Section 6: constraints and acceptance hints
  sections.push(buildConstraintsSection(goal));

  // Section 7: omitted/full transcript note
  sections.push(buildTranscriptNoteSection(workspaceFiles));

  // Section 8: retrieval sources
  sections.push(buildRetrievalSourcesSection(bundleChunks));

  const bundle = sections.join("\n");
  const tokenEstimate = estimateTokens(bundle);

  // If over budget, we do a simple truncation — trim the conversation
  // and results sections iteratively.
  if (tokenEstimate > maxTokens) {
    return trimToBudget({ sections, maxTokens, bundle, tokenEstimate, selectedChunks: bundleChunks, selectionMetadata });
  }

  return { bundle, sections, tokenEstimate, selectedChunks: bundleChunks, selectionMetadata };
}

/**
 * Estimate token count (approximate: 4 chars per token).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Trim sections to fit within the token budget.
 * Removes lower-priority content from conversation and results sections first.
 */
function trimToBudget({ sections, maxTokens, selectedChunks = [], selectionMetadata = null }) {
  // Rebuild with progressive trimming of conversation and results sections
  const trimmedSections = [];
  for (const section of sections) {
    if (section.startsWith("## Relevant Prior Conversation") || section.startsWith("## Relevant Prior Tasks / Results")) {
      // Keep only the header and first line of content
      const headerLines = section.split("\n").slice(0, 3);
      trimmedSections.push(headerLines.join("\n") + "\n*(Trimmed to fit context budget.)*\n");
    } else {
      trimmedSections.push(section);
    }
  }

  const bundle = trimmedSections.join("\n");
  const tokenEstimate = estimateTokens(bundle);

  // If still over budget (unlikely), trim conversation section further
  if (tokenEstimate > maxTokens) {
    const hardTrimmedBundle = trimUtf8ToBytes(bundle, maxTokens * 4);
    return {
      bundle: hardTrimmedBundle,
      sections: trimmedSections,
      tokenEstimate: estimateTokens(hardTrimmedBundle),
      selectedChunks,
      selectionMetadata,
    };
  }

  return { bundle, sections: trimmedSections, tokenEstimate, selectedChunks, selectionMetadata };
}
