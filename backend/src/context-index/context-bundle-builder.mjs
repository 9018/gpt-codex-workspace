/**
 * context-bundle-builder.mjs — Build bounded context.bundle.md from retrieved chunks.
 *
 * Given retrieved chunks and goal metadata, generates a compact markdown
 * bundle suitable for Codex prompt inclusion while keeping the full
 * transcript available for explicit deep lookup.
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;   // soft target for total bundle size (estimated)
const SECTION_HEADER = "<!-- context-bundle -->";

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
      lines.push(goalChunk.text.substring(0, 800));
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

  for (const chunk of convChunks.slice(0, 5)) {
    const score = chunk.score !== undefined ? ` *(similarity: ${chunk.score.toFixed(3)})*` : "";
    lines.push(`> ${chunk.text.replace(/\n/g, "\n> ")}${score}`);
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

  for (const chunk of resultChunks.slice(0, 3)) {
    const score = chunk.score !== undefined ? ` *(similarity: ${chunk.score.toFixed(3)})*` : "";
    lines.push(`- ${chunk.text.substring(0, 500)}${score}`);
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

  for (const chunk of chunks.slice(0, 10)) {
    const meta = chunk.metadata || {};
    const sourceType = meta.source_type || "unknown";
    const goalId = meta.goal_id || "unknown-goal";
    const sourcePath = meta.source_path || meta.result_path || meta.transcript_path || "inline context";
    const score = chunk.score !== undefined ? ` score=${Number(chunk.score).toFixed(3)}` : "";
    lines.push(`- ${sourceType}: ${goalId} — ${sourcePath}${score}`);
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
  const { chunks = [], goal, workspaceFiles } = options;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

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

  // Section 2: selected context summary
  sections.push(buildContextSummarySection(goal, chunks));

  // Section 3: relevant prior conversation
  const convSection = buildConversationSection(chunks);
  if (convSection) sections.push(convSection);

  // Section 4: relevant prior tasks/results
  const resSection = buildResultsSection(chunks);
  if (resSection) sections.push(resSection);

  // Section 5: constraints and acceptance hints
  sections.push(buildConstraintsSection(goal));

  // Section 6: omitted/full transcript note
  sections.push(buildTranscriptNoteSection(workspaceFiles));

  // Section 7: retrieval metadata
  sections.push(buildRetrievalSourcesSection(chunks));

  // Section 8: retrieval metadata
  const retrievedTypes = [...new Set(chunks.map((c) => c.metadata?.source_type).filter(Boolean))];
  sections.push("## Retrieval Metadata");
  sections.push("");
  sections.push(`- Retrieved chunk types: ${retrievedTypes.join(", ") || "none"}`);
  sections.push(`- Total retrieved chunks: ${chunks.length}`);
  if (chunks.some((c) => c.score !== undefined)) {
    const maxScore = Math.max(...chunks.map((c) => c.score ?? 0));
    const minScore = Math.min(...chunks.map((c) => c.score ?? 0));
    sections.push(`- Score range: ${minScore.toFixed(3)} — ${maxScore.toFixed(3)}`);
  }
  sections.push("");

  const bundle = sections.join("\n");
  const tokenEstimate = estimateTokens(bundle);

  // If over budget, we do a simple truncation — trim the conversation
  // and results sections iteratively.
  if (tokenEstimate > maxTokens) {
    return trimToBudget({ sections, maxTokens, bundle, tokenEstimate });
  }

  return { bundle, sections, tokenEstimate };
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
function trimToBudget({ sections, maxTokens }) {
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
    return {
      bundle: bundle.substring(0, maxTokens * 4),
      sections: trimmedSections,
      tokenEstimate: Math.min(tokenEstimate, maxTokens),
    };
  }

  return { bundle, sections: trimmedSections, tokenEstimate };
}
