/**
 * Pure and near-pure goal lifecycle/context helper functions.
 *
 * This module contains only functions that normalize goal messages, memories,
 * and derive titles from goal arguments.  No goal‑files helpers, task lifecycle
 * helpers, Codex worker logic, safe restart logic, prompt builder, workspace
 * IO, public tool names, or public schemas belong here.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// titleFromGoal
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable title from a goal's arguments.
 *
 * @param {{ user_request?: string, goal_prompt?: string }} args
 * @returns {string}
 */
export function titleFromGoal(args) {
  const source = String(args.user_request || args.goal_prompt || "Codex goal").replace(/\s+/g, " ").trim();
  return source.length > 80 ? `${source.slice(0, 77)}...` : source || "Codex goal";
}

// ---------------------------------------------------------------------------
// normalizeGoalMessages
// ---------------------------------------------------------------------------

/**
 * Normalize an array of goal messages.
 *
 * @param {Array|null|undefined} messages
 * @param {string} now ISO‑8601 timestamp
 * @param {string} userId
 * @returns {Array<object>}
 */
export function normalizeGoalMessages(messages, now, userId) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => message && message.content).map((message) => normalizeGoalMessage(message, now, userId));
}

// ---------------------------------------------------------------------------
// normalizeGoalMessage
// ---------------------------------------------------------------------------

/**
 * Normalize a single goal message, assigning a unique id and default fields.
 *
 * @param {{ role?: string, content?: string, author_id?: string, created_at?: string }} message
 * @param {string} now ISO‑8601 timestamp
 * @param {string} userId
 * @returns {{ id: string, role: string, content: string, author_id: string, created_at: string }}
 */
export function normalizeGoalMessage(message, now, userId) {
  const role = String(message.role || "user").trim().toLowerCase();
  const allowedRoles = new Set(["user", "assistant", "chatgpt", "codex", "system", "tool"]);
  return {
    id: `msg_${randomUUID()}`,
    role: allowedRoles.has(role) ? role : "user",
    content: String(message.content || ""),
    author_id: message.author_id || userId,
    created_at: message.created_at || now
  };
}

// ---------------------------------------------------------------------------
// normalizeGoalMemories
// ---------------------------------------------------------------------------

/**
 * Normalize an array of goal memories.
 *
 * @param {Array|null|undefined} memories
 * @param {string} goalId
 * @param {string} conversationId
 * @param {string} now ISO‑8601 timestamp
 * @param {string} userId
 * @returns {Array<object>}
 */
export function normalizeGoalMemories(memories, goalId, conversationId, now, userId) {
  if (!Array.isArray(memories)) return [];
  return memories.filter((memory) => memory && (memory.key || memory.value)).map((memory) => normalizeGoalMemory(memory, goalId, conversationId, now, userId));
}

// ---------------------------------------------------------------------------
// normalizeGoalMemory
// ---------------------------------------------------------------------------

/**
 * Normalize a single goal memory, assigning a unique id and default fields.
 *
 * @param {{ key?: string, value?: string, created_by?: string, created_at?: string }} memory
 * @param {string} goalId
 * @param {string} conversationId
 * @param {string} now ISO‑8601 timestamp
 * @param {string} userId
 * @returns {{ id: string, goal_id: string, conversation_id: string, key: string, value: string, created_by: string, created_at: string }}
 */
export function normalizeGoalMemory(memory, goalId, conversationId, now, userId) {
  return {
    id: `mem_${randomUUID()}`,
    goal_id: goalId,
    conversation_id: conversationId,
    key: String(memory.key || "note"),
    value: String(memory.value || ""),
    created_by: memory.created_by || userId,
    created_at: memory.created_at || now
  };
}
