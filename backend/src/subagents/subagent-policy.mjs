/**
 * subagent-policy.mjs (subagents/) — Parent TUI subagent pipeline definitions.
 *
 * Defines the fixed multi-agent execution pipeline for the parent TUI,
 * including phase ordering, parallel agent groups, repair rounds, and
 * structured progress tracking.
 *
 * Pipeline (fixed, non-configurable):
 *   context_curator
 *   → [explorer | architect | test_analyst] (parallel, phase 1)
 *   → planner
 *   → builder
 *   → verifier
 *   → reviewer
 *   → repairer (max 2 rounds, triggered on failure only)
 *   → finalizer
 */

// -- Pipeline phase definitions ----------------------------------------------

export const PARENT_TUI_PHASES = Object.freeze([
  { index: 0,  name: "context_curation", label: "Context Curation",  roles: ["context_curator"],                           parallel: false, max_rounds: 1 },
  { index: 1,  name: "analysis",          label: "Analysis",          roles: ["explorer", "architect", "test_analyst"],    parallel: true,  max_rounds: 1 },
  { index: 2,  name: "planning",          label: "Planning",          roles: ["planner"],                                  parallel: false, max_rounds: 1 },
  { index: 3,  name: "building",          label: "Building",          roles: ["builder"],                                  parallel: false, max_rounds: 1 },
  { index: 4,  name: "verification",      label: "Verification",      roles: ["verifier"],                                 parallel: false, max_rounds: 1 },
  { index: 5,  name: "review",            label: "Review",            roles: ["reviewer"],                                 parallel: false, max_rounds: 1 },
  { index: 6,  name: "repair",            label: "Repair",            roles: ["repairer"],                                 parallel: false, max_rounds: 2 },
  { index: 7,  name: "finalization",      label: "Finalization",      roles: ["finalizer"],                                parallel: false, max_rounds: 1 },
]);

export const PARENT_TUI_PHASE_COUNT = PARENT_TUI_PHASES.length;
export const PARENT_TUI_MAX_REPAIR_ROUNDS = 2;
export const PARENT_TUI_PIPELINE_ROLES = Object.freeze(
  PARENT_TUI_PHASES.flatMap((p) => p.roles)
);

// -- Phase role index --------------------------------------------------------
const ROLE_TO_PHASE = {};
for (const phase of PARENT_TUI_PHASES) {
  for (const role of phase.roles) {
    ROLE_TO_PHASE[role] = phase.index;
  }
}
export { ROLE_TO_PHASE as PARENT_TUI_ROLE_TO_PHASE };

/**
 * Get the phase index for a given role.
 */
export function getPhaseForRole(role) {
  const idx = ROLE_TO_PHASE[role];
  if (idx === undefined) {
    throw new Error(`Unknown parent TUI role: ${role}`);
  }
  return idx;
}

/**
 * Get the full phase object for a given role.
 */
export function getPhaseForRoleInfo(role) {
  const idx = getPhaseForRole(role);
  return PARENT_TUI_PHASES[idx];
}

/**
 * Check whether a phase index runs agents in parallel.
 */
export function isParallelPhase(phaseIndex) {
  const phase = PARENT_TUI_PHASES[phaseIndex];
  return phase ? phase.parallel : false;
}

/**
 * Check whether a phase index is terminal (last in pipeline).
 */
export function isTerminalPhase(phaseIndex) {
  return phaseIndex === PARENT_TUI_PHASE_COUNT - 1;
}

/**
 * Get the phase display label for a given role.
 */
export function getPhaseLabelForRole(role) {
  const phase = getPhaseForRoleInfo(role);
  return phase ? phase.label : role;
}

/**
 * Check if a role is a repairer role.
 */
export function isRepairRole(role) {
  return role === "repairer";
}

/**
 * Get the maximum number of repair rounds allowed.
 */
export function getMaxRepairRounds() {
  return PARENT_TUI_MAX_REPAIR_ROUNDS;
}

/**
 * Get the flat pipeline order (role names in execution order, with repairer repeated).
 */
export function getFlatPipelineOrder() {
  const order = [];
  for (const phase of PARENT_TUI_PHASES) {
    order.push(...phase.roles);
  }
  return order;
}

/**
 * Build the default subagent skeleton with pending status for all pipeline roles.
 *
 * @param {object} [options]
 * @param {number} [options.repairRounds] - Override repair rounds (default: 2)
 * @returns {object[]} Array of subagent descriptors
 */
export function buildDefaultSubagentSkeleton({ repairRounds = PARENT_TUI_MAX_REPAIR_ROUNDS } = {}) {
  const agents = [];
  for (const phase of PARENT_TUI_PHASES) {
    if (phase.name === "repair") {
      for (let round = 1; round <= Math.min(repairRounds, phase.max_rounds); round++) {
        agents.push({
          role: "repairer",
          round,
          phase: phase.name,
          status: "declared",
          summary: "",
          changed_files: [],
          artifacts: [],
          blockers: [],
          started_at: null,
          completed_at: null,
        });
      }
    } else {
      for (const role of phase.roles) {
        agents.push({
          role,
          round: 1,
          phase: phase.name,
          status: "declared",
          summary: "",
          changed_files: [],
          artifacts: [],
          blockers: [],
          started_at: null,
          completed_at: null,
        });
      }
    }
  }
  return agents;
}
