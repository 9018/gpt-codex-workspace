
export const AGENT_BACKEND_IDS = Object.freeze({
  CODEX_EXEC: "codex_exec",
  LOCAL_COMMAND: "local_command",
  NULL: "null",
});
// -- Execution semantic tags ---------------------------------------------------
// Distinguish real agent execution from deterministic auto-artifact completion
// and test-only stubs. This enables review packets and runtime doctor to clearly
// label each role's execution provenance.
//
// real:          Actual agent execution via codex_exec or local_command
// auto_artifact: Null backend used for deterministic artifact completion
//                (e.g. integrator/finalizer auto-completed from task result)
// test_noop:     Null backend used in tests or debugging
// configured:    Explicit operator choice (null or local_command)
export const AGENT_BACKEND_SEMANTIC = Object.freeze({
  REAL: "real",
  AUTO_ARTIFACT: "auto_artifact",
  TEST_NOOP: "test_noop",
  CONFIGURED: "configured",
});

// -- Null backend reason classification ----------------------------------------
// Product semantics for null backend usage:
// - auto_artifact: Deterministic artifact completion for roles whose work
//                  is fully derived from existing task result evidence.
//                  Used for integrator/finalizer by default.
// - test_only:     Explicit test usage (configured for unit/integration tests).
// - configured:    Operator explicitly chose null backend for a role.
export const NULL_REASON = Object.freeze({
  AUTO_ARTIFACT: "auto_artifact",
  TEST_ONLY: "test_only",
  CONFIGURED: "configured_null",
});

// Pipeline sub-role default: codex_exec. Top-level task execution defaults to autonomous codex_tui_goal.
// Per-role overrides (agentRoleBackends) always take precedence.
// Roles that default to auto-artifact when a null backend IS explicitly configured
// are tracked separately in ROLE_AUTO_ARTIFACT_DEFAULTS.
export const ROLE_BACKEND_DEFAULTS = Object.freeze({
  context_curator: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for context curation." },
  planner: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for planning." },
  builder: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for code changes." },
  verifier: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for verification." },
  reviewer: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for review." },
  integrator: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for integration." },
  finalizer: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for finalization." },
  repairer: { backend: AGENT_BACKEND_IDS.CODEX_EXEC, semantic: AGENT_BACKEND_SEMANTIC.REAL, reason: null, doc: "Codex execution for repair attempts." },
});

// Roles whose default execution semantic is auto_artifact when the null backend
// is explicitly configured (via agentRoleBackends or task metadata).
export const ROLE_AUTO_ARTIFACT_DEFAULTS = Object.freeze({
  context_curator: true,
  planner: true,
  integrator: true,
  finalizer: true,
});




const BACKEND_ID_SET = new Set(Object.values(AGENT_BACKEND_IDS));
const BACKEND_ALIASES = Object.freeze({
  codex: AGENT_BACKEND_IDS.CODEX_EXEC,
  codex_exec: AGENT_BACKEND_IDS.CODEX_EXEC,
  local: AGENT_BACKEND_IDS.LOCAL_COMMAND,
  local_command: AGENT_BACKEND_IDS.LOCAL_COMMAND,
  noop: AGENT_BACKEND_IDS.NULL,
  none: AGENT_BACKEND_IDS.NULL,
  null: AGENT_BACKEND_IDS.NULL,
});

/**
 * Determine if a role's resolved backend comes from a product default or an explicit override.
 * Returns "product_default" when the effective backend matches ROLE_BACKEND_DEFAULTS and
 * no explicit config or task metadata is present.
 * Returns "explicit_role_override" when agentRoleBackends or agentBackendByRole sets the backend.
 * Returns "explicit_global_override" when a global agentBackend/agentBackendDefault is set.
 * Returns "explicit_task_override" when task metadata or fields set the backend.
 *
 * @param {object} options
 * @param {object} [options.config={}]
 * @param {string} [options.role="builder"]
 * @param {object} [options.task={}]
 * @returns {{ source: string, label: string }}
 */
export function resolveBackendSource({ config = {}, role = "builder", task = {} } = {}) {
  const hasTaskBackend = taskBackend(task);
  if (hasTaskBackend) {
    return { source: "explicit_task_override", label: "Explicit task-level override" };
  }
  const hasRoleBackend = roleValue(config.agentRoleBackends, role) || roleValue(config.agentBackendByRole, role);
  if (hasRoleBackend) {
    return { source: "explicit_role_override", label: "Explicit role-level override (agentRoleBackends)" };
  }
  const hasGlobalBackend = config.agentBackend || config.agentBackendDefault || config.defaultAgentBackend;
  if (hasGlobalBackend) {
    return { source: "explicit_global_override", label: "Explicit global override (agentBackend)" };
  }
  return { source: "product_default", label: "Product default (ROLE_BACKEND_DEFAULTS)" };
}

/**
 * Resolve the execution semantic for a resolved backend id and role context.
 *
 * - Non-null backends (codex_exec, local_command) always resolve to REAL.
 * - Null backend resolves based on nullReason or role default:
 *   auto_artifact for roles completing from evidence (integrator, finalizer, etc.),
 *   test_noop for test stubs, configured for explicit operator choice.
 *
 * @param {string} backendId - Resolved backend identifier
 * @param {object} [options={}]
 * @param {string} [options.role] - Agent role to check against defaults
 * @param {string} [options.nullReason] - Explicit null_reason if provided
 * @returns {string} One of AGENT_BACKEND_SEMANTIC values
 */
export function resolveBackendSemantic(backendId, { role = "builder", nullReason } = {}) {
  if (backendId !== AGENT_BACKEND_IDS.NULL) {
    return AGENT_BACKEND_SEMANTIC.REAL;
  }
  if (nullReason === NULL_REASON.TEST_ONLY) return AGENT_BACKEND_SEMANTIC.TEST_NOOP;
  if (nullReason === NULL_REASON.CONFIGURED) return AGENT_BACKEND_SEMANTIC.CONFIGURED;
  if (nullReason === NULL_REASON.AUTO_ARTIFACT) return AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT;
  // Infer from auto-artifact role defaults when null backend is used without explicit nullReason
  if (ROLE_AUTO_ARTIFACT_DEFAULTS[role]) return AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT;
  return AGENT_BACKEND_SEMANTIC.CONFIGURED;
}



function normalizeBackendId(value, fallback = AGENT_BACKEND_IDS.CODEX_EXEC) {
  const id = String(value || "").trim().toLowerCase();
  if (BACKEND_ALIASES[id]) return BACKEND_ALIASES[id];
  return BACKEND_ID_SET.has(id) ? id : fallback;
}

function normalizeRole(value) {
  return String(value || "builder").trim() || "builder";
}

function roleValue(map, role) {
  if (!map || typeof map !== "object") return "";
  const key = normalizeRole(role).toLowerCase();
  return map[key] || map[normalizeRole(role)] || "";
}

function taskBackend(task = {}) {
  return task.agent_backend
    || task.backend
    || task.execution_backend
    || task.metadata?.agent_backend
    || task.metadata?.backend
    || task.metadata?.execution_backend
    || "";
}

function commandForRole(config = {}, role) {
  return roleValue(config.agentRoleCommands, role)
    || config.agentLocalCommand
    || config.agentCommand
    || config.localCommandBackendCommand
    || "";
}

function parseJsonLine(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const candidates = [text, ...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

export function summaryFromOutput(output = {}) {
  const stdout = String(output.stdout || "").trim();
  if (stdout) return stdout.slice(0, 10000);
  const stderr = String(output.stderr || "").trim();
  if (stderr) return stderr.slice(0, 10000);
  return output.returncode === 0 ? "Backend completed without output." : "Backend failed without output.";
}

export function resolveAgentBackendId({ config = {}, role = "builder", task = {} } = {}) {
  const taskSelected = taskBackend(task);
  if (taskSelected) return normalizeBackendId(taskSelected);
  const roleSelected = roleValue(config.agentRoleBackends, role) || roleValue(config.agentBackendByRole, role);
  if (roleSelected) return normalizeBackendId(roleSelected);
  const globalBackend = config.agentBackend || config.agentBackendDefault || config.defaultAgentBackend;
  if (globalBackend) return normalizeBackendId(globalBackend);
  // Fallback to role defaults
  // Note: ROLE_BACKEND_DEFAULTS now has all roles as codex_exec.
  // Previous per-role distinction (null for integrator/finalizer, local_command for verifier/reviewer)
  // has been consolidated for pipeline sub-roles; top-level task execution remains TUI-first.
  const roleDefault = ROLE_BACKEND_DEFAULTS[role];
  if (roleDefault) return roleDefault.backend;
  return AGENT_BACKEND_IDS.CODEX_EXEC;
}

export function normalizeBackendResult({ backendId, task = {}, goal = null, role = "builder", output = {}, parsed = null, defaultInfo = null, nullReason: explicitNullReason = null } = {}) {
  const exitCode = output.returncode ?? output.exit_code ?? 0;
  const timedOut = Boolean(output.timed_out);
  const status = timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed";
  const parsedSummary = parsed?.summary || parsed?.SUMMARY || "";
  const summary = parsedSummary || summaryFromOutput(output);

  // Determine execution semantic and null reason
  const backend = normalizeBackendId(backendId);
  // defaultInfo overrides role defaults; ROLE_BACKEND_DEFAULTS always codex_exec
  const info = defaultInfo || ROLE_BACKEND_DEFAULTS[role] || null;
  const nullReason = explicitNullReason
    || (backend === AGENT_BACKEND_IDS.NULL
        ? (info?.reason || NULL_REASON.AUTO_ARTIFACT)
        : null);
  const executionSemantic = resolveBackendSemantic(backend, { role, nullReason });
  const evidenceSource = backend === AGENT_BACKEND_IDS.CODEX_EXEC
    ? "codex_exec (real agent execution)"
    : backend === AGENT_BACKEND_IDS.LOCAL_COMMAND
      ? "local_command (deterministic shell command)"
      : `null (${nullReason || "noop"} -- no external commands executed)`;

  return {
    kind: "agent_backend_result",
    backend,
    role: normalizeRole(role),
    task_id: task.id || null,
    goal_id: goal?.id || null,
    status,
    summary,
    structured: true,
    execution_semantic: executionSemantic,
    evidence_source: evidenceSource,
    null_reason: nullReason,
    null_backend: backend === AGENT_BACKEND_IDS.NULL,
    completed_at: new Date().toISOString(),
    stdout: output.stdout || "",
    stderr: output.stderr || "",
    command: {
      cmd: output.command || output.cmd || "",
      cwd: output.cwd || "",
      exit_code: exitCode,
      timed_out: timedOut,
    },
    stdout_bytes: output.stdout_bytes,
    stderr_bytes: output.stderr_bytes,
    first_stdout_at: output.first_stdout_at,
    first_stderr_at: output.first_stderr_at,
    first_output_delay_ms: output.first_output_delay_ms,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
  };
}

/**
 * Check if a backend result indicates a null/noop execution.
 *
 * @param {object} parsedResult - Result from normalizeBackendResult
 * @returns {boolean} True if the backend was null
 */
export function isNullBackendResult(parsedResult) {
  return parsedResult?.backend === AGENT_BACKEND_IDS.NULL || parsedResult?.null_backend === true;
}

/**
 * Check if a backend result indicates a real (non-null) execution.
 *
 * @param {object} parsedResult - Result from normalizeBackendResult
 * @returns {boolean} True if the backend was real execution
 */
export function isRealBackendResult(parsedResult) {
  return parsedResult?.execution_semantic === AGENT_BACKEND_SEMANTIC.REAL;
}

/**
 * Build a compact pipeline role-backend chain for diagnostics.
 * Pipeline sub-roles default to codex_exec; the top-level task provider defaults to autonomous codex_tui_goal.
 * When a user explicitly configures a role to null (via agentRoleBackends),
 * the semantic switches to auto_artifact / test_noop / configured accordingly.
 *
 * Pipeline semantics:
 * - codex_exec:     Real agent execution (all roles by product default)
 * - local_command:  Deterministic shell command execution (when explicitly configured)
 * - null:           Auto-artifact completion when explicitly configured for
 *                   context_curator, planner, integrator, finalizer
 *   - auto_artifact:   Deterministic completion from task result evidence (default for integrator, finalizer)
 *   - test_noop:       Test mode stub (null backend with explicit test_only reason)
 *   - configured_null: Explicit operator choice to use null backend
 *
 * @param {object} [config={}] - Runtime config with potential role backend overrides
 * @param {string[]} [roles] - Role names to include; defaults to pipeline roles
 * @returns {{ chain: Array<{ role: string, backend: string, semantic: string, label: string }>, summary: string }}
 */
export function buildPipelineRoleBackendChain(config = {}, roles) {
  const roleList = Array.isArray(roles) && roles.length > 0
    ? roles
    : Object.keys(ROLE_BACKEND_DEFAULTS);

  const chain = roleList.map((role) => {
    const backend = resolveAgentBackendId({ config, role, task: {} });
    const semantic = resolveBackendSemantic(backend, { role });
    const label = _backendLabel(backend, semantic, role);
    return { role, backend, semantic, label };
  });

  const summary = chain.map((c) => c.label).join("\n");
  return { chain, summary };
}

/**
 * Build a human-readable summary line for the pipeline role-backend chain,
 * suitable for doctor/runtime_status output.  This is the single canonical
 * formatter for backend chain diagnostics.
 *
 * Each role is shown as:
 *   <role> → <backend> (product default|explicit override)
 *
 * When all roles use product defaults the summary collapses to a single line.
 *
 * @param {object} [config={}] - Runtime config
 * @param {string[]} [roles] - Role names; defaults to ROLE_BACKEND_DEFAULTS keys
 * @returns {{ text: string, entries: Array<{ role: string, backend: string, source: string, label: string }> }}
 */
export function formatBackendChainSummary(config = {}, roles) {
  const { chain } = buildPipelineRoleBackendChain(config, roles);
  const entries = chain.map((entry) => {
    const source = resolveBackendSource({ config, role: entry.role });
    return {
      role: entry.role,
      backend: entry.backend,
      semantic: entry.semantic,
      source: source.source,
      label: `${entry.role} → ${entry.backend} (${source.label})`,
    };
  });

  const allDefault = entries.every((e) => e.source === "product_default");
  let text;
  if (allDefault) {
    text = `Task execution → codex_tui_goal (autonomous default); pipeline sub-roles → codex_exec`;
  } else {
    text = entries.map((e) => e.label).join("\n");
  }

  return { text, entries };
}

/**
 * Build a compact one-line summary of agent backend configuration
 * for use in product_status and runtime_status.
 *
 * @param {object} [config={}] - Runtime config
 * @returns {string}
 */
export function getBackendConfigSummary(config = {}) {
  const { text } = formatBackendChainSummary(config);
  return text;
}

/**

/**
 * Produce a human-readable label for a role's backend in the pipeline chain.
 * Used by buildPipelineRoleBackendChain to produce clear diagnostics.
 *
 * Pipeline sub-role defaults show as:
 *   <role> / codex_exec (real agent execution)
 *
 * When null backend is configured, the label shows the null reason:
 *   integrator / null/auto_artifact (auto-completed from evidence, no external commands)
 */
function _backendLabel(backend, semantic, role) {
  if (backend === AGENT_BACKEND_IDS.CODEX_EXEC) {
    return `${role} → codex_exec (real agent execution)`;
  }
  if (backend === AGENT_BACKEND_IDS.LOCAL_COMMAND) {
    return `${role} → local_command (deterministic shell command)`;
  }
  /* null backend */
  if (semantic === AGENT_BACKEND_SEMANTIC.AUTO_ARTIFACT) {
    return `${role} → null/auto_artifact (auto-completed from evidence, no external commands)`;
  }
  if (semantic === AGENT_BACKEND_SEMANTIC.TEST_NOOP) {
    return `${role} → null/test_noop (test mode stub, no external commands)`;
  }
  return `${role} → null/configured (explicit operator choice)`;
}

export class CodexExecBackend {
  constructor({ runCodexTaskFn } = {}) {
    this.id = AGENT_BACKEND_IDS.CODEX_EXEC;
    this.runCodexTaskFn = runCodexTaskFn;
  }

  async run(args = {}) {
    if (typeof this.runCodexTaskFn !== "function") {
      throw new Error("codex_exec backend requires runCodexTaskFn");
    }
    return this.runCodexTaskFn(args);
  }
}

export class LocalCommandBackend {
  constructor({ runLocalShellFn = runLocalShell } = {}) {
    this.id = AGENT_BACKEND_IDS.LOCAL_COMMAND;
    this.runLocalShellFn = runLocalShellFn;
  }

  async run(args = {}) {
    const { config = {}, task = {}, goal = null, role = "builder", executionCwd, workspaceRoot } = args;
    const command = commandForRole(config, role);
    if (!command) {
      throw new Error(`local_command backend has no command configured for role ${normalizeRole(role)}`);
    }
    const cwd = executionCwd || workspaceRoot || config.defaultRepoPath || config.defaultWorkspaceRoot || process.cwd();
    const timeout = config.agentCommandTimeout || config.localCommandBackendTimeout || config.shellTimeout || 60;
    const maxBuffer = config.maxShellOutputBytes || config.maxOutputBytes || 200000;
    const cr = await this.runLocalShellFn(command, cwd, timeout, maxBuffer, args.onPid, {
      firstOutputTimeoutSeconds: config.agentCommandFirstOutputTimeout || 0,
      noProgressTimeoutSeconds: config.agentCommandNoProgressTimeout || 0,
      onOutput: args.onOutput,
    });
    const output = { ...cr, command, cwd };
    const parsed = parseJsonLine(cr?.stdout);
    const parsedResult = normalizeBackendResult({ backendId: this.id, task, goal, role, output, parsed });
    return { backend: this.id, cr, parsedResult, summary: parsedResult.summary };
  }
}

export class NullBackend {
  constructor() {
    this.id = AGENT_BACKEND_IDS.NULL;
  }

  async run(args = {}) {
    const { config = {}, task = {}, goal = null, role = "builder", nullReason: explicitNullReason } = args;
    const cr = { stdout: "", stderr: "", returncode: 0, timed_out: false };

    // Determine null reason: explicit > config > auto-artifact role defaults
    // ROLE_AUTO_ARTIFACT_DEFAULTS marks roles that auto-complete from evidence
    // when explicitly configured with a null backend.
    const nullReason = explicitNullReason
      || config.agentNullReason
      || (ROLE_AUTO_ARTIFACT_DEFAULTS[role] ? NULL_REASON.AUTO_ARTIFACT : null)
      || null;
    const semantic = resolveBackendSemantic(AGENT_BACKEND_IDS.NULL, { role, nullReason });

    const parsedResult = normalizeBackendResult({
      backendId: this.id,
      task,
      goal,
      role,
      output: cr,
      nullReason,
      parsed: {
        status: "completed",
        summary: "Null backend completed without executing external commands.",
        changed_files: [],
        tests: "null backend: no external commands executed",
        commit: "none",
        remote_head: "none",
        verification: { passed: true, commands: [] },
        no_mutation: true,
        noop: true,
        noop_reason: nullReason
          ? `Null backend: ${nullReason.replace(/_/g, " ")}`
          : "Null backend: automatic artifact completion -- no external commands executed.",
      },
    });
    return { backend: this.id, cr, parsedResult, summary: parsedResult.summary };
  }
}

export function createExecutionBackend(backendId, deps = {}) {
  const id = normalizeBackendId(backendId);
  if (id === AGENT_BACKEND_IDS.LOCAL_COMMAND) return new LocalCommandBackend(deps);
  if (id === AGENT_BACKEND_IDS.NULL) return new NullBackend(deps);
  return new CodexExecBackend(deps);
}

export async function executeAgentBackendRun(args = {}, deps = {}) {
  const backendId = resolveAgentBackendId({ config: args.config, role: args.role, task: args.task });
  const backend = createExecutionBackend(backendId, deps);
  const result = await backend.run(args);
  return { backend: backend.id, ...result };
}
