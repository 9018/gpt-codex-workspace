/**
 * chunker.mjs — Text chunking for context retrieval.
 *
 * Splits text and structured content into deterministic chunks
 * suitable for embedding and retrieval.
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 512;   // target tokens (approximated via char count)
const DEFAULT_CHUNK_OVERLAP = 64; // overlap between consecutive chunks

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

// ---------------------------------------------------------------------------
// Chunk text by approximate token count
// ---------------------------------------------------------------------------

/**
 * Split plain text into chunks at paragraph boundaries when possible,
 * falling back to sentence or word boundaries.
 *
 * @param {string} text
 * @param {{ chunkSize?: number, chunkOverlap?: number }} [options]
 * @returns {Array<{ index: number, text: string, tokens: number }>}
 */
export function chunkText(text, options = {}) {
  if (!text || typeof text !== "string") return [];
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap  = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  function flushCurrent() {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    // Keep overlap from the tail of the current segment
    const overlapText = drainOverlap(current, overlap);
    current = overlapText ? [overlapText] : [];
    currentTokens = overlapText ? estimateTokens(overlapText) : 0;
  }

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (paraTokens > chunkSize) {
      // Paragraph exceeds chunk size — split it by sentences
      flushCurrent();
      const sentences = para.match(/[^.!?\n]+[.!?\n]*\s*/g) || [para];
      let sentenceBuffer = [];
      let bufferTokens = 0;
      for (const sentence of sentences) {
        const st = estimateTokens(sentence);
        if (bufferTokens + st > chunkSize && sentenceBuffer.length > 0) {
          const merged = sentenceBuffer.join("");
          chunks.push(merged);
          sentenceBuffer = [sentence];
          bufferTokens = st;
        } else {
          sentenceBuffer.push(sentence);
          bufferTokens += st;
        }
      }
      if (sentenceBuffer.length > 0) {
        chunks.push(sentenceBuffer.join(""));
      }
      current = [];
      currentTokens = 0;
    } else if (currentTokens + paraTokens > chunkSize && current.length > 0) {
      flushCurrent();
      current = [para];
      currentTokens = paraTokens;
    } else {
      current.push(para);
      currentTokens += paraTokens;
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  return chunks.map((text, index) => ({
    index,
    text: text.trim(),
    tokens: estimateTokens(text.trim()),
  }));
}

/**
 * Drain the last N tokens worth of text from an array of paragraphs.
 * Used to create overlap between consecutive chunks.
 */
function drainOverlap(paragraphs, overlapTokens) {
  if (paragraphs.length === 0 || overlapTokens <= 0) return "";
  const reversed = [...paragraphs].reverse();
  const collected = [];
  let collectedTokens = 0;
  for (const para of reversed) {
    const pt = estimateTokens(para);
    if (collectedTokens + pt > overlapTokens && collected.length > 0) break;
    collected.unshift(para);
    collectedTokens += pt;
  }
  return collected.join("\n\n");
}

// ---------------------------------------------------------------------------
// Chunk conversation messages / transcript
// ---------------------------------------------------------------------------

/**
 * Chunk an array of conversation messages into retrievable chunks.
 *
 * @param {Array<{ role: string, content: string, created_at?: string }>} messages
 * @param {{ chunkSize?: number, chunkOverlap?: number }} [options]
 * @returns {Array<{ index: number, text: string, tokens: number, metadata: object }>}
 */
export function chunkMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return [];
  const meta = options.metadata || {};
  const rendered = messages.map((msg) => {
    const role = msg.role || "unknown";
    const stamp = msg.created_at ? ` (${msg.created_at})` : "";
    return `## ${role}${stamp}\n\n${msg.content || ""}`;
  });
  const raw = rendered.join("\n\n");
  return chunkText(raw, options).map((chunk) => ({
    ...chunk,
    metadata: { ...meta, source_type: "conversation" },
  }));
}

// ---------------------------------------------------------------------------
// Chunk goal metadata
// ---------------------------------------------------------------------------

/**
 * Extract searchable chunks from a goal object.
 *
 * @param {object} goal
 * @param {{ chunkSize?: number, chunkOverlap?: number }} [options]
 * @returns {Array<{ index: number, text: string, tokens: number, metadata: object }>}
 */
export function chunkGoalContent(goal, options = {}) {
  if (!goal) return [];
  const meta = options.metadata || {};
  const sections = [];

  if (goal.title) sections.push(`## Title\n\n${goal.title}`);
  if (goal.user_request) sections.push(`## User Request\n\n${goal.user_request}`);
  if (goal.goal_prompt) sections.push(`## Goal Prompt\n\n${goal.goal_prompt}`);
  if (goal.context_summary) sections.push(`## Context Summary\n\n${goal.context_summary}`);

  const raw = sections.join("\n\n");
  return chunkText(raw, options).map((chunk) => ({
    ...chunk,
    metadata: { ...meta, source_type: "goal" },
  }));
}

// ---------------------------------------------------------------------------
// Chunk result summaries
// ---------------------------------------------------------------------------

/**
 * Chunk task result content for retrieval indexing.
 *
 * @param {string} resultText
 * @param {{ chunkSize?: number, chunkOverlap?: number }} [options]
 * @returns {Array<{ index: number, text: string, tokens: number, metadata: object }>}
 */
export function chunkResult(resultText, options = {}) {
  const meta = options.metadata || {};
  return chunkText(resultText, options).map((chunk) => ({
    ...chunk,
    metadata: { ...meta, source_type: "result" },
  }));
}
