// @ts-check
/**
 * Task Context Packet schema validation.
 * Schema: gptwork.task_context.v1
 */

export const TASK_CONTEXT_SCHEMA_VERSION = "gptwork.task_context.v1";
export const FACT_STATUSES = Object.freeze(
  new Set(["verified", "reported", "hypothesis", "decision"])
);

/** Top-level keys that become immutable after Task start. */
export const IMMUTABLE_AFTER_START = Object.freeze(
  new Set(["objective", "scope", "acceptance_criteria"])
);

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

const isString = (v) => typeof v === "string";
const isNonEmptyString = (v) => isString(v) && v.length > 0;
const isBoolean = (v) => typeof v === "boolean";
const isInteger = (v) => Number.isInteger(v);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArray = (v) => Array.isArray(v);

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

/**
 * Validate a task context packet. Throws on first error.
 * @param {any} packet
 * @returns {true}
 */
export function validateTaskContextPacket(packet) {
  if (!isObject(packet)) {
    throw new Error("task_context_packet: must be an object");
  }

  // schema_version
  if (packet.schema_version !== TASK_CONTEXT_SCHEMA_VERSION) {
    throw new Error(
      `task_context_packet: schema_version must be "${TASK_CONTEXT_SCHEMA_VERSION}"`
    );
  }

  // identity
  const ident = packet.identity;
  if (!isObject(ident)) {
    throw new Error("task_context_packet: identity must be an object");
  }
  if (!isString(ident.workstream_id) && ident.workstream_id !== null) {
    throw new Error("task_context_packet: identity.workstream_id must be string or null");
  }
  if (!isInteger(ident.context_revision) || ident.context_revision < 1) {
    throw new Error("task_context_packet: identity.context_revision must be integer >= 1");
  }
  if (ident.goal_id !== undefined && !isString(ident.goal_id) && ident.goal_id !== null) {
    throw new Error("task_context_packet: identity.goal_id must be string or null");
  }
  if (ident.task_id !== undefined && !isString(ident.task_id) && ident.task_id !== null) {
    throw new Error("task_context_packet: identity.task_id must be string or null");
  }

  // objective
  if (!isNonEmptyString(packet.objective)) {
    throw new Error("task_context_packet: objective must be a non-empty string");
  }

  // background
  if (!isArray(packet.background)) {
    throw new Error("task_context_packet: background must be an array");
  }

  // confirmed_findings
  if (!isArray(packet.confirmed_findings)) {
    throw new Error("task_context_packet: confirmed_findings must be an array");
  }
  for (const f of packet.confirmed_findings) {
    if (!isObject(f)) throw new Error("task_context_packet: finding must be an object");
    if (!isString(f.id)) throw new Error("task_context_packet: finding.id must be a string");
    if (!isString(f.statement)) throw new Error("task_context_packet: finding.statement must be a string");
    if (!FACT_STATUSES.has(f.status)) {
      throw new Error(
        `task_context_packet: finding.status must be one of ${[...FACT_STATUSES].join(", ")}`
      );
    }
    if (!isArray(f.evidence_refs)) {
      throw new Error("task_context_packet: finding.evidence_refs must be an array");
    }
  }

  // scope
  if (!isObject(packet.scope)) {
    throw new Error("task_context_packet: scope must be an object");
  }
  if (!isArray(packet.scope.include)) {
    throw new Error("task_context_packet: scope.include must be an array");
  }
  if (!isArray(packet.scope.exclude)) {
    throw new Error("task_context_packet: scope.exclude must be an array");
  }

  // required_changes
  if (!isArray(packet.required_changes)) {
    throw new Error("task_context_packet: required_changes must be an array");
  }

  // acceptance_criteria
  if (!isArray(packet.acceptance_criteria) || packet.acceptance_criteria.length < 1) {
    throw new Error("task_context_packet: acceptance_criteria must be a non-empty array");
  }
  const seenIds = new Set();
  for (const ac of packet.acceptance_criteria) {
    if (!isObject(ac)) throw new Error("task_context_packet: acceptance criterion must be an object");
    if (!isString(ac.id)) throw new Error("task_context_packet: acceptance criterion id must be a string");
    if (!isString(ac.description)) throw new Error("task_context_packet: acceptance criterion description must be a string");
    if (!isBoolean(ac.blocking)) throw new Error("task_context_packet: acceptance criterion blocking must be boolean");
    if (seenIds.has(ac.id)) {
      throw new Error(`task_context_packet: duplicate acceptance criterion id: ${ac.id}`);
    }
    seenIds.add(ac.id);
  }

  // constraints
  if (!isArray(packet.constraints)) {
    throw new Error("task_context_packet: constraints must be an array");
  }

  // open_questions
  if (!isArray(packet.open_questions)) {
    throw new Error("task_context_packet: open_questions must be an array");
  }

  // carry_forward
  if (!isArray(packet.carry_forward)) {
    throw new Error("task_context_packet: carry_forward must be an array");
  }

  // source_provenance
  if (!isArray(packet.source_provenance)) {
    throw new Error("task_context_packet: source_provenance must be an array");
  }

  // raw_conversation_policy
  const rcp = packet.raw_conversation_policy;
  if (!isObject(rcp)) {
    throw new Error("task_context_packet: raw_conversation_policy must be an object");
  }
  if (!isBoolean(rcp.stored)) {
    throw new Error("task_context_packet: raw_conversation_policy.stored must be boolean");
  }
  if (!isBoolean(rcp.indexed)) {
    throw new Error("task_context_packet: raw_conversation_policy.indexed must be boolean");
  }
  if (!isBoolean(rcp.injected)) {
    throw new Error("task_context_packet: raw_conversation_policy.injected must be boolean");
  }
  if (!isBoolean(rcp.targeted_lookup_allowed)) {
    throw new Error("task_context_packet: raw_conversation_policy.targeted_lookup_allowed must be boolean");
  }

  // Default: raw conversation is stored but not indexed or injected
  if (rcp.stored !== true) {
    throw new Error("task_context_packet: raw_conversation_policy.stored must default to true");
  }
  if (rcp.injected !== false) {
    throw new Error("task_context_packet: raw_conversation_policy.injected must default to false");
  }

  return true;
}

/**
 * Validate a delta packet against an existing packet.
 * Deltas must not modify immutable fields.
 * @param {any} delta
 * @param {any} packet
 * @returns {true}
 */
export function validateTaskContextDelta(delta, packet) {
  if (!isObject(delta)) {
    throw new Error("task_context_delta: must be an object");
  }
  if (!isString(delta.kind)) {
    throw new Error("task_context_delta: kind must be a string");
  }
  const allowedKinds = new Set([
    "new_evidence", "verification_failure", "review_findings",
    "repair_instruction", "rerun_verification", "operator_note", "context_refresh"
  ]);
  if (!allowedKinds.has(delta.kind)) {
    throw new Error(`task_context_delta: unsupported kind "${delta.kind}"`);
  }
  if (delta.task_id !== packet.identity?.task_id) {
    throw new Error("task_context_delta: task_id must match packet");
  }
  if (delta.goal_id !== packet.identity?.goal_id) {
    throw new Error("task_context_delta: goal_id must match packet");
  }
  for (const field of IMMUTABLE_AFTER_START) {
    if (delta[field] !== undefined) {
      throw new Error(`task_context_delta: cannot modify immutable field "${field}"`);
    }
  }
  return true;
}
