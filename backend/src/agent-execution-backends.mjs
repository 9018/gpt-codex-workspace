import { runLocalShell } from "./workspace-service.mjs";

export const AGENT_BACKEND_IDS = Object.freeze({
  CODEX_EXEC: "codex_exec",
  LOCAL_COMMAND: "local_command",
  NULL: "null",
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

function summaryFromOutput(output = {}) {
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
  return normalizeBackendId(config.agentBackend || config.agentBackendDefault || config.defaultAgentBackend || AGENT_BACKEND_IDS.CODEX_EXEC);
}

export function normalizeBackendResult({ backendId, task = {}, goal = null, role = "builder", output = {}, parsed = null } = {}) {
  const exitCode = output.returncode ?? output.exit_code ?? 0;
  const timedOut = Boolean(output.timed_out);
  const status = timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed";
  const parsedSummary = parsed?.summary || parsed?.SUMMARY || "";
  const summary = parsedSummary || summaryFromOutput(output);
  return {
    kind: "agent_backend_result",
    backend: normalizeBackendId(backendId),
    role: normalizeRole(role),
    task_id: task.id || null,
    goal_id: goal?.id || null,
    status,
    summary,
    structured: true,
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
    const { task = {}, goal = null, role = "builder" } = args;
    const cr = { stdout: "", stderr: "", returncode: 0, timed_out: false };
    const parsedResult = normalizeBackendResult({
      backendId: this.id,
      task,
      goal,
      role,
      output: cr,
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
        noop_reason: "Configured null backend.",
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
