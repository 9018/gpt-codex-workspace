/**
 * execution-provider-contract.mjs — Provider contract definition and normalizers.
 *
 * @deprecated Wave 10R — 保留为旧调度器和新 pipeline 共享的 provider contract。
 * 新代码应通过 execution-pipeline-adapter.mjs 间接使用。
 *
 * Defines the required interface for execution providers, plus normalizer
 * functions that every provider output must pass through.  Provider Registry
 * wraps each provider call with these normalizers so callers never see raw
 * provider output that violates the contract.
 *
 * @module execution-provider-contract
 */

/** Required methods every execution provider must implement. */
export const EXECUTION_PROVIDER_METHODS = Object.freeze([
  "availability",
  "start",
  "resume",
  "observe",
  "interrupt",
  "collect",
  "dispose",
]);

/** Allowed provider observation states. */
export const OBSERVATION_STATES = Object.freeze([
  "starting",
  "running",
  "evidence_ready",
  "supervisor_required",
  "failed",
]);

const OBSERVATION_STATE_SET = new Set(OBSERVATION_STATES);

/**
 * Mapping from legacy/raw provider states to canonical observation states.
 * Any state not in this mapping or in OBSERVATION_STATES directly is
 * considered unknown and will cause normalizeObservationState to fail closed.
 */
const LEGACY_STATE_MAP = Object.freeze({
  completed: "evidence_ready",
  timed_out: "failed",
  provider_unavailable: "failed",
  cancelled: "failed",
  waiting_for_supervisor: "supervisor_required",
});

const PROVIDERS = new Set(["codex_exec", "codex_tui"]);

/**
 * Assert that a provider object satisfies the contract.
 */
export function assertExecutionProviderContract(provider) {
  if (!provider || typeof provider !== "object") throw new Error("execution provider must be an object");
  if (!PROVIDERS.has(provider.name)) throw new Error(`unsupported execution provider: ${provider.name}`);
  for (const method of EXECUTION_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(`execution provider ${provider.name} missing required method ${method}`);
    }
  }
  return true;
}

/**
 * Normalize a raw observation state to one of the allowed states.
 * Fail closed: unknown states throw an error rather than silently
 * defaulting to "running".
 *
 * @param {string|null|undefined} rawState - Raw state string from provider
 * @returns {string} One of OBSERVATION_STATES
 * @throws {Error} If the state is unknown and cannot be mapped
 */
export function normalizeObservationState(rawState) {
  // null/undefined defaults to running (initial start, no observation yet)
  if (rawState == null) return "running";

  // Direct match to allowed observation states
  if (OBSERVATION_STATE_SET.has(rawState)) return rawState;

  // Legacy/known mappings
  if (rawState in LEGACY_STATE_MAP) return LEGACY_STATE_MAP[rawState];

  // Unknown state — fail closed
  throw new Error(
    `Unknown provider observation state "${rawState}". ` +
    `Allowed states: ${[...OBSERVATION_STATES].join(", ")}. ` +
    `Legacy mapped states: ${Object.keys(LEGACY_STATE_MAP).join(", ")}.`
  );
}

/**
 * Normalize a raw observation result (from provider.observe()).
 * Ensures the returned state is valid and strips unknown fields.
 *
 * @param {object} input - Raw observation output from a provider
 * @param {string|undefined} input.state - Raw state string
 * @param {object} [input.failure] - Failure details (if state is "failed")
 * @param {object} [input.checkpoint] - Checkpoint data (if supervisor_required)
 * @param {string} [input.native_session_id] - Native session identifier
 * @returns {object} Normalized observation
 * @throws {Error} If state is unknown (fail closed)
 */
export function normalizeProviderObservation(input = {}) {
  const state = normalizeObservationState(input.state);
  return {
    state,
    failure: input.failure && typeof input.failure === "object"
      ? structuredClone(input.failure)
      : null,
    checkpoint: input.checkpoint && typeof input.checkpoint === "object"
      ? structuredClone(input.checkpoint)
      : null,
    native_session_id: input.native_session_id || null,
  };
}

/**
 * Normalize start/resume session output.
 *
 * @param {object} [input={}] - Raw start/resume result from provider
 * @returns {object} Normalized session descriptor
 */
export function normalizeProviderSession(input = {}) {
  const providerRunId = input.provider_run_id || input.session_id || input.id || null;
  // Preserve known fields plus any non-standard fields (result, failure, etc.)
  // that providers attach to the session handoff.
  const result = {
    session_id: input.session_id || providerRunId,
    provider_run_id: providerRunId,
    control_session_id: input.control_session_id || null,
    native_session_id: input.native_session_id || null,
    resume_token: input.resume_token || null,
    started_at: input.started_at || new Date().toISOString(),
  };
  // Pass through non-standard fields that providers may attach
  for (const key of Object.keys(input)) {
    if (!(key in result)) {
      result[key] = input[key];
    }
  }
  return result;
}

/**
 * Normalize collect() output to a canonical raw evidence shape.
 *
 * @param {object} [input={}] - Raw collect() result from provider
 * @returns {object} Normalized raw evidence
 */
export function normalizeRawEvidence(input = {}) {
  return {
    provider_claims: Array.isArray(input.provider_claims)
      ? structuredClone(input.provider_claims)
      : [],
    artifacts: Array.isArray(input.artifacts)
      ? structuredClone(input.artifacts)
      : [],
    commands: Array.isArray(input.commands)
      ? structuredClone(input.commands)
      : [],
    session: input.session && typeof input.session === "object"
      ? structuredClone(input.session)
      : {},
    repository_snapshot: input.repository_snapshot && typeof input.repository_snapshot === "object"
      ? structuredClone(input.repository_snapshot)
      : {},
    raw_result: input.raw_result && typeof input.raw_result === "object"
      ? structuredClone(input.raw_result)
      : {},
  };
}
