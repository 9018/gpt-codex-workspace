// @ts-check
/**
 * Task Context Compiler — compiles raw conversation inputs into
 * a structured Task Context Packet.
 */
import { validateTaskContextPacket } from "./task-context-schema.mjs";

// ---------------------------------------------------------------------------
// Patterns for process chatter — default exclude
// ---------------------------------------------------------------------------
const PROCESS_PATTERNS = [
  /安全策略.*拦截/u,
  /已撤销.*临时/u,
  /准备.*下发/u,
  /我先.*尝试/u,
  /转为.*Goal/u,
  /转为.*任务/u,
  /继续.*直到.*闭环/u,
  /直接生产代码.*修改.*被.*拦截/u,
];

// ---------------------------------------------------------------------------
// Pattern to extract real constraints from process noise
// ---------------------------------------------------------------------------
const CONSTRAINT_PATTERNS = [
  { pattern: /所有代码修改必须在.*worktree/u, normalized: "所有代码修改必须在 Task 隔离 worktree 中完成。" },
  { pattern: /不得直接修改.*state/u, normalized: "不得直接修改 state.json 等运行时状态文件。" },
  { pattern: /执行.*验证.*review.*integration/u, normalized: "完成条件包括执行、验证、review、integration 和最终状态写回。" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compact whitespace.
 * @param {any} value
 * @returns {string}
 */
function compact(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/**
 * Find the longest normalized constraint in text.
 * @param {string} text
 * @returns {string|null}
 */
function extractConstraint(text) {
  for (const { pattern, normalized } of CONSTRAINT_PATTERNS) {
    if (pattern.test(text)) return normalized;
  }
  return null;
}

/**
 * Check if text contains closure acceptance language.
 * @param {string} text
 * @returns {boolean}
 */
function hasClosureAcceptance(text) {
  return /闭环|完成条件|必须通过.*验证|执行.*验证.*review/u.test(text);
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/**
 * Classify a single conversation message.
 * @param {{role?: string, content?: string}} message
 * @returns {{kind: string, include: boolean, normalized?: string}}
 */
export function classifyConversationMessage(message) {
  const text = compact(message?.content);
  if (!text) return { kind: "empty", include: false };

  // Check for constraint patterns first (they may overlap with chatter)
  const constraint = extractConstraint(text);
  if (constraint) {
    return { kind: "constraint", include: true, normalized: constraint };
  }

  // Check for acceptance patterns
  if (hasClosureAcceptance(text)) {
    return { kind: "acceptance", include: true };
  }

  // Check for process chatter
  if (PROCESS_PATTERNS.some((re) => re.test(text))) {
    return { kind: "process_chatter", include: false };
  }

  // Default: candidate fact — not automatically included
  return { kind: "candidate_fact", include: false };
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a Task Context Packet from raw conversation inputs.
 * @param {object} input
 * @param {string} [input.objective]
 * @param {string} [input.goalPrompt]
 * @param {string} [input.userRequest]
 * @param {Array<{role?: string, content?: string}>} [input.messages]
 * @param {Array} [input.background]
 * @param {Array} [input.confirmedFindings]
 * @param {object} [input.scope]
 * @param {Array} [input.requiredChanges]
 * @param {Array} [input.constraints]
 * @param {Array} [input.openQuestions]
 * @param {Array} [input.carryForward]
 * @param {object} [input.acceptanceContract]
 * @param {Array} [input.sourceProvenance]
 * @param {object} [input.rawConversationPolicy]
 * @param {string} [input.workstreamId]
 * @returns {{packet: object, diagnostics: object}}
 */
export function compileTaskContext(input = {}) {
  /** @type {string[]} */
  const constraints = [];
  /** @type {string[]} */
  const acceptanceTexts = [];
  /** @type {Array<{role: string, reason: string, text?: string}>} */
  const excluded = [];

  for (const message of input.messages || []) {
    const classified = classifyConversationMessage(message);
    if (!classified.include) {
      excluded.push({
        role: message.role || "unknown",
        reason: classified.kind,
        text: classified.kind === "process_chatter"
          ? compact(message.content).substring(0, 80)
          : undefined,
      });
      continue;
    }
    if (classified.kind === "constraint" && classified.normalized) {
      constraints.push(classified.normalized);
    }
    if (classified.kind === "acceptance") {
      acceptanceTexts.push("完成条件包括执行、验证、review、integration 和最终状态写回。");
    }
  }

  const packet = {
    schema_version: "gptwork.task_context.v1",
    identity: {
      workstream_id: input.workstreamId || null,
      goal_id: null,
      task_id: null,
      context_revision: 1,
    },
    objective: compact(
      input.objective || input.goalPrompt || input.userRequest || ""
    ),
    background: input.background || [],
    confirmed_findings: input.confirmedFindings || [],
    scope: input.scope || { include: [], exclude: [] },
    required_changes: input.requiredChanges || [],
    acceptance_criteria: normalizeAcceptance(
      input.acceptanceContract,
      acceptanceTexts
    ),
    constraints: deduplicate([
      ...constraints,
      ...(input.constraints || []),
    ]),
    open_questions: input.openQuestions || [],
    carry_forward: input.carryForward || [],
    source_provenance: input.sourceProvenance || [],
    raw_conversation_policy: {
      stored: true,
      indexed: false,
      injected: false,
      targeted_lookup_allowed: true,
      ...(input.rawConversationPolicy || {}),
    },
  };

  // Validate the compiled packet
  // Use try-catch since some fields may be empty for incomplete input
  try {
    validateTaskContextPacket(packet);
  } catch (err) {
    // If validation fails, it's a compilation error
    throw new Error(`task_context_compilation_failed: ${err.message}`);
  }

  return {
    packet,
    diagnostics: {
      excluded_messages: excluded,
      included_constraints: packet.constraints.length,
      included_acceptance: packet.acceptance_criteria.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render a goal prompt string from a compiled packet.
 * @param {object} packet
 * @returns {string}
 */
export function renderGoalPromptFromPacket(packet) {
  if (!packet || !packet.objective) return "";
  const lines = [
    `## Goal`,
    ``,
    packet.objective,
    ``,
  ];
  if (packet.scope?.include?.length > 0) {
    lines.push(`### Scope Include`);
    for (const item of packet.scope.include) lines.push(`- ${item}`);
    lines.push(``);
  }
  if (packet.scope?.exclude?.length > 0) {
    lines.push(`### Scope Exclude`);
    for (const item of packet.scope.exclude) lines.push(`- ${item}`);
    lines.push(``);
  }
  if (packet.constraints?.length > 0) {
    lines.push(`### Constraints`);
    for (const c of packet.constraints) lines.push(`- ${c}`);
    lines.push(``);
  }
  if (packet.acceptance_criteria?.length > 0) {
    lines.push(`### Acceptance Criteria`);
    for (const ac of packet.acceptance_criteria) {
      lines.push(`- [${ac.blocking ? "BLOCKING" : "ADVISORY"}] ${ac.description}`);
    }
    lines.push(``);
  }
  if (packet.open_questions?.length > 0) {
    lines.push(`### Open Questions`);
    for (const q of packet.open_questions) lines.push(`- ${q}`);
    lines.push(``);
  }
  return lines.join("\n");
}

/**
 * Render a context summary from a compiled packet.
 * @param {object} packet
 * @returns {string}
 */
export function renderContextSummaryFromPacket(packet) {
  if (!packet) return "";
  const parts = [];
  if (packet.objective) parts.push(`Objective: ${packet.objective.substring(0, 200)}`);
  if (packet.background?.length > 0) parts.push(`Background: ${packet.background.length} items`);
  if (packet.scope?.include?.length > 0) parts.push(`Scope: ${packet.scope.include.length} included paths`);
  if (packet.constraints?.length > 0) parts.push(`Constraints: ${packet.constraints.length}`);
  if (packet.acceptance_criteria?.length > 0) {
    const blocking = packet.acceptance_criteria.filter((ac) => ac.blocking).length;
    parts.push(`Acceptance: ${packet.acceptance_criteria.length} criteria (${blocking} blocking)`);
  }
  parts.push(`Raw conversation injected: ${packet.raw_conversation_policy?.injected === true}`);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Normalize acceptance — prefer explicit contract, fall back to compiled texts.
 * @param {object|null} contract
 * @param {string[]} fallbackTexts
 * @returns {Array<{id: string, description: string, blocking: boolean, verification_hint: string|null}>}
 */
function normalizeAcceptance(contract, fallbackTexts) {
  const explicit = contract?.blocking_requirements || contract?.acceptance_criteria || [];
  if (explicit.length > 0) {
    return explicit.map((item) => ({
      id: String(item.id),
      description: String(item.description || item.message || ""),
      blocking: item.blocking !== false,
      verification_hint: item.verification_hint || null,
    }));
  }
  if (fallbackTexts.length > 0) {
    const seen = new Set();
    return fallbackTexts
      .filter((text) => {
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
      })
      .map((text, index) => ({
        id: `compiled_${index + 1}`,
        description: text,
        blocking: true,
        verification_hint: null,
      }));
  }
  // Fallback: create a generic closure acceptance
  return [
    {
      id: "compiled_1",
      description: "完成条件包括执行、验证、review、integration 和最终状态写回。",
      blocking: true,
      verification_hint: null,
    },
  ];
}

/**
 * Deduplicate and compact an array of strings.
 * @param {string[]} values
 * @returns {string[]}
 */
function deduplicate(values) {
  return [...new Set(values.map((v) => compact(v)).filter(Boolean))];
}
