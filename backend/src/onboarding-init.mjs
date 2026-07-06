/**
 * onboarding-init.mjs — productized initialization, diagnostics, and onboarding.
 *
 * Provides the core logic for:
 *   gptwork init   — one-step initialization with diagnostics
 *   gptwork doctor — enhanced diagnostics
 *   gptwork fix    — automated repair for common issues
 *
 * Does NOT handle security concerns.
 * Does NOT repair dirty repos.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRuntimeConfig } from "./runtime-config.mjs";

// ───────────────────────────────────────────────────────────────────
// Path Helpers
// ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..", "..");
export const BACKEND_ROOT = resolve(PROJECT_ROOT, "backend");
export const GPTWORK_DIR = resolve(PROJECT_ROOT, ".gptwork");

// ───────────────────────────────────────────────────────────────────
// Individual Checks
// ───────────────────────────────────────────────────────────────────

/**
 * Check that the repository root is detectable via .git.
 */
export function checkGitRepo() {
  try {
    const out = execSync("git rev-parse --show-toplevel 2>/dev/null", { encoding: "utf8", timeout: 5000 }).trim();
    if (out) return { name: "git_repo", status: "pass", detail: `Repository root: ${out}` };
    return { name: "git_repo", status: "fail", detail: "Not inside a Git repository", fixable: false };
  } catch {
    return { name: "git_repo", status: "fail", detail: "git not found or not a repo", fixable: false };
  }
}

/**
 * Check that the .gptwork directory exists and is valid.
 */
export function checkGptworkDir(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  if (!existsSync(dir)) {
    return { name: "gptwork_dir", status: "fail", detail: `.gptwork directory missing at ${dir}`, fixable: true, fixHint: "mkdir -p .gptwork" };
  }
  if (!existsSync(join(dir, "goals"))) {
    return { name: "gptwork_dir", status: "warn", detail: ".gptwork/goals missing", fixable: true, fixHint: "mkdir -p .gptwork/goals" };
  }
  return { name: "gptwork_dir", status: "pass", detail: `.gptwork directory present` };
}

/**
 * Check runtime.env existence and validate against runtime.env.example.
 */
export function checkRuntimeEnv(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  const examplePath = join(dir, "runtime.env.example");

  if (!existsSync(envPath)) {
    return { name: "runtime_env", status: "fail", detail: `.gptwork/runtime.env not found`, fixable: true, fixHint: "gptwork setup or gptwork init" };
  }

  if (!existsSync(examplePath)) {
    return { name: "runtime_env", status: "warn", detail: "runtime.env exists but runtime.env.example is missing (cannot validate)" };
  }

  const envVars = parseEnvFile(envPath);
  const exampleVars = parseEnvFile(examplePath);

  const missingKeys = [];
  for (const [key, val] of Object.entries(exampleVars)) {
    if (val !== "" && !(key in envVars)) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    return {
      name: "runtime_env",
      status: "warn",
      detail: `runtime.env exists but missing ${missingKeys.length} recommended variable(s): ${missingKeys.slice(0, 5).join(", ")}${missingKeys.length > 5 ? `... (+${missingKeys.length - 5} more)` : ""}`,
      fixable: true,
      fixHint: `Add to runtime.env: ${missingKeys[0]}`
    };
  }

  return { name: "runtime_env", status: "pass", detail: `runtime.env present and validated against example` };
}

/**
 * Check project context templates (.gptwork/project.md, .gptwork/project.env).
 */
export function checkProjectContext(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const findings = [];
  let allPass = true;

  const projectMd = join(dir, "project.md");
  const projectEnv = join(dir, "project.env");

  if (!existsSync(projectMd)) {
    findings.push("project.md");
    allPass = false;
  }
  if (!existsSync(projectEnv)) {
    findings.push("project.env");
    allPass = false;
  }

  if (allPass) {
    return { name: "project_context", status: "pass", detail: "project.md and project.env both present" };
  }
  return {
    name: "project_context",
    status: "fail",
    detail: `Missing: ${findings.join(", ")}`,
    fixable: true,
    fixHint: `gptwork fix or gptwork init`
  };
}

/**
 * Check repo registry (.gptwork/repos.json) validity.
 */
export function checkRepoRegistry(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const reposPath = join(dir, "repos.json");

  if (!existsSync(reposPath)) {
    return { name: "repo_registry", status: "fail", detail: ".gptwork/repos.json not found", fixable: true, fixHint: "Create repos.json with registry" };
  }

  try {
    const raw = readFileSync(reposPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.repositories || !Array.isArray(parsed.repositories)) {
      return { name: "repo_registry", status: "fail", detail: "repos.json missing 'repositories' array", fixable: true, fixHint: "Add 'repositories' array per schema" };
    }
    if (parsed.repositories.length === 0) {
      return { name: "repo_registry", status: "warn", detail: "repos.json has empty repositories array" };
    }
    const valid = parsed.repositories.every(r => r.repo_id && r.remote_url);
    if (!valid) {
      return { name: "repo_registry", status: "warn", detail: "Some repos missing repo_id or remote_url" };
    }
    return { name: "repo_registry", status: "pass", detail: `repos.json valid with ${parsed.repositories.length} repository/ies` };
  } catch (e) {
    return { name: "repo_registry", status: "fail", detail: `repos.json parse error: ${e.message}`, fixable: true, fixHint: "Fix JSON syntax" };
  }
}

/**
 * Check npm dependencies (node_modules exists).
 */
export function checkNpmDeps(backendRoot) {
  const root = backendRoot || BACKEND_ROOT;
  const nmPath = join(root, "node_modules");
  const pkgPath = join(root, "package.json");

  if (!existsSync(pkgPath)) {
    return { name: "npm_deps", status: "fail", detail: "backend/package.json not found" };
  }
  if (!existsSync(nmPath)) {
    return { name: "npm_deps", status: "fail", detail: "backend/node_modules not found — run npm install", fixable: true, fixHint: "cd backend && npm install" };
  }
  return { name: "npm_deps", status: "pass", detail: "node_modules present" };
}

/**
 * Check codex CLI availability.
 */
export function checkCodexAvailability() {
  try {
    const out = execSync("which codex 2>/dev/null || command -v codex 2>/dev/null || echo not-found", { encoding: "utf8", timeout: 5000 }).trim();
    if (out && out !== "not-found" && out !== "codex not found") {
      let version = "";
      try {
        version = execSync("codex --version 2>/dev/null || echo unknown", { encoding: "utf8", timeout: 3000 }).trim();
      } catch {}
      return { name: "codex", status: "pass", detail: `codex available at ${out}${version ? ` (${version})` : ""}` };
    }
    return { name: "codex", status: "warn", detail: "codex CLI not found in PATH", fixHint: "Install Codex CLI to use codex_exec backend" };
  } catch {
    return { name: "codex", status: "warn", detail: "codex CLI not found", fixHint: "Install Codex CLI" };
  }
}

/**
 * Check git CLI availability and version.
 */
export function checkGitAvailability() {
  try {
    const out = execSync("git --version 2>/dev/null", { encoding: "utf8", timeout: 5000 }).trim();
    if (out) return { name: "git", status: "pass", detail: out };
    return { name: "git", status: "fail", detail: "git not found", fixable: false };
  } catch {
    return { name: "git", status: "fail", detail: "git not found", fixable: false };
  }
}

/**
 * Check Node.js version meets minimum (>=18).
 */
export function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  if (major >= 22) return { name: "node_version", status: "pass", detail: `Node.js ${version}` };
  if (major >= 18) return { name: "node_version", status: "warn", detail: `Node.js ${version} (>=22 recommended)` };
  return { name: "node_version", status: "fail", detail: `Node.js ${version} (<18 not supported)` };
}

/**
 * Check if the repo has dirty/uncommitted changes.
 */
export function checkDirtyRepo(cwd) {
  try {
    const status = execSync("git status --short 2>/dev/null", { cwd: cwd || process.cwd(), encoding: "utf8", timeout: 5000 }).trim();
    if (status) {
      const lines = status.split("\n").filter(l => l.trim());
      return { name: "dirty_repo", status: "warn", detail: `Repo has ${lines.length} uncommitted change(s)` };
    }
    return { name: "dirty_repo", status: "pass", detail: "Working tree clean" };
  } catch {
    return { name: "dirty_repo", status: "skip", detail: "Cannot determine git status" };
  }
}

/**
 * Check worker status from runtime config.
 */
export function checkWorkerStatus(config) {
  const cfg = config || buildRuntimeConfig(resolve(PROJECT_ROOT, "data/workspaces/default")).config;
  const workerEnabled = process.env.GPTWORK_CODEX_WORKER === "true" || cfg.codexWorker === true;
  return {
    name: "worker",
    status: workerEnabled ? "pass" : "warn",
    detail: workerEnabled ? "Codex worker enabled" : "Codex worker not enabled (set GPTWORK_CODEX_WORKER=true)",
    fixable: true,
    fixHint: "Set GPTWORK_CODEX_WORKER=true in runtime.env"
  };
}

/**
 * Check GitHub connectivity if configured.
 */
export function checkGitHubConnectivity(config) {
  const cfg = config || buildRuntimeConfig(resolve(PROJECT_ROOT, "data/workspaces/default")).config;
  const enabled = cfg.githubEnabled || !!cfg.githubRepo;
  if (!enabled) {
    return { name: "github", status: "skip", detail: "GitHub sync not configured (optional)" };
  }
  if (!cfg.githubRepo) {
    return { name: "github", status: "warn", detail: "GitHub enabled but GPTWORK_GITHUB_REPO not set" };
  }
  if (!cfg.githubToken) {
    return { name: "github", status: "warn", detail: "GitHub enabled but GPTWORK_GITHUB_TOKEN not set" };
  }
  return { name: "github", status: "pass", detail: `GitHub configured for ${cfg.githubRepo}` };
}

/**
 * Check available required directories exist.
 */
export function checkRequiredDirs(projectRoot) {
  const root = projectRoot || PROJECT_ROOT;
  const required = [
    "data/workspaces/default",
    "data/workspaces/archive",
    "data/logs",
  ];
  const missing = [];
  for (const dir of required) {
    if (!existsSync(join(root, dir))) {
      missing.push(dir);
    }
  }
  if (missing.length > 0) {
    return { name: "required_dirs", status: "fail", detail: `Missing directories: ${missing.join(", ")}`, fixable: true, fixHint: "gptwork fix or gptwork init" };
  }
  return { name: "required_dirs", status: "pass", detail: "All required directories present" };
}

/**
 * Detailed runtime.env vs example key coverage.
 */
export function validateRuntimeEnvAgainstExample(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  const examplePath = join(dir, "runtime.env.example");

  if (!existsSync(envPath)) {
    return { name: "env_vs_example", status: "fail", detail: "runtime.env missing" };
  }
  if (!existsSync(examplePath)) {
    return { name: "env_vs_example", status: "skip", detail: "runtime.env.example missing, cannot validate" };
  }

  const envVars = parseEnvFile(envPath);
  const exampleVars = parseEnvFile(examplePath);

  const exampleKeys = Object.keys(exampleVars).filter(k => exampleVars[k] !== "");
  const missing = exampleKeys.filter(k => !(k in envVars) && !k.startsWith("#"));

  if (missing.length > 0) {
    return {
      name: "env_vs_example",
      status: "warn",
      detail: `Missing ${missing.length} recommended env var(s): ${missing.join(", ")}`,
      fixable: true,
      fixHint: `Add missing vars from .gptwork/runtime.env.example`
    };
  }

  return { name: "env_vs_example", status: "pass", detail: `All ${exampleKeys.length} recommended env vars present` };
}

// ───────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────
// Production Profile Checks
// ───────────────────────────────────────────────────────────────────

/**
 * Check that codexWorker is enabled (required for production).
 * Production expects GPTWORK_CODEX_WORKER=true.
 */
export function checkProductionWorkerEnabled(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  let workerEnabled = process.env.GPTWORK_CODEX_WORKER === "true";
  
  // Also check runtime.env directly
  if (!workerEnabled && existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    workerEnabled = envVars.GPTWORK_CODEX_WORKER === "true";
  }
  
  return {
    name: "production_worker",
    status: workerEnabled ? "pass" : "blocker",
    detail: workerEnabled
      ? "Codex worker enabled (GPTWORK_CODEX_WORKER=true)"
      : "Codex worker not enabled — production requires GPTWORK_CODEX_WORKER=true",
    fixable: true,
    fixHint: "Set GPTWORK_CODEX_WORKER=true in .gptwork/runtime.env"
  };
}

/**
 * Check verifier/reviewer role commands for local_command backend.
 * When a role is set to local_command, the corresponding command must exist.
 */
export function checkVerifierReviewerCommands(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  const findings = [];
  
  // Parse role backends
  let roleBackendsRaw = process.env.GPTWORK_AGENT_ROLE_BACKENDS || "";
  let roleCommandsRaw = process.env.GPTWORK_AGENT_ROLE_COMMANDS || "";
  let agentBackend = process.env.GPTWORK_AGENT_BACKEND || "";
  
  // Also check runtime.env
  if (existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    if (!roleBackendsRaw) roleBackendsRaw = envVars.GPTWORK_AGENT_ROLE_BACKENDS || "";
    if (!roleCommandsRaw) roleCommandsRaw = envVars.GPTWORK_AGENT_ROLE_COMMANDS || "";
    if (!agentBackend) agentBackend = envVars.GPTWORK_AGENT_BACKEND || "";
  }
  
  const roleBackends = parseSimpleMap(roleBackendsRaw, ",");
  const roleCommands = parseSimpleMap(roleCommandsRaw, "||");
  
  // Check verifier and reviewer roles specifically
  for (const role of ["verifier", "reviewer"]) {
    const backend = roleBackends[role] || agentBackend;
    if (backend === "local_command") {
      if (!roleCommands[role]) {
        findings.push({
          role,
          backend,
          commandMissing: true,
          detail: `${role} uses local_command backend but no command configured for this role`
        });
      }
    }
  }
  
  if (findings.length > 0) {
    const details = findings.map(f =>
      `${f.role} local_command missing command${f.commandMissing ? " (set GPTWORK_AGENT_ROLE_COMMANDS)" : ""}`
    ).join("; ");
    return {
      name: "role_commands",
      status: "blocker",
      detail: details,
      fixable: true,
      fixHint: "Set GPTWORK_AGENT_ROLE_COMMANDS=verifier=<command>||reviewer=<command> in runtime.env"
    };
  }
  
  return { name: "role_commands", status: "pass", detail: "All role commands properly configured" };
}

/**
 * Check that agent backends resolve to valid backends.
 */
export function checkAgentRoleBackends(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  
  let roleBackendsRaw = process.env.GPTWORK_AGENT_ROLE_BACKENDS || "";
  if (existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    if (!roleBackendsRaw) roleBackendsRaw = envVars.GPTWORK_AGENT_ROLE_BACKENDS || "";
  }
  
  const validBackends = ["codex_exec", "local_command", "null"];
  const roleBackends = parseSimpleMap(roleBackendsRaw, ",");
  const invalid = [];
  
  for (const [role, backend] of Object.entries(roleBackends)) {
    if (!validBackends.includes(backend)) {
      invalid.push(`${role}=${backend}`);
    }
  }
  
  if (invalid.length > 0) {
    return {
      name: "agent_backends",
      status: "warn",
      detail: `Invalid role backends: ${invalid.join(", ")} (valid: ${validBackends.join(", ")})`,
      fixable: true,
      fixHint: "Fix GPTWORK_AGENT_ROLE_BACKENDS values"
    };
  }
  
  return { name: "agent_backends", status: "pass", detail: "All role backends valid" };
}

/**
 * Check release gate commands are configured for production.
 */
export function checkReleaseGateCommands(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  
  let recoveryCommands = process.env.GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS || "";
  if (existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    if (!recoveryCommands) recoveryCommands = envVars.GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS || "";
  }
  
  if (!recoveryCommands) {
    return {
      name: "release_gate_commands",
      status: "warn",
      detail: "No delivery result recovery commands configured (GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS)",
      fixable: true,
      fixHint: "Set GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS=npm --prefix backend run check:syntax||git diff --check"
    };
  }
  
  const commands = recoveryCommands.split("||").map(s => s.trim()).filter(Boolean);
  return {
    name: "release_gate_commands",
    status: "pass",
    detail: `${commands.length} delivery recovery command(s) configured`
  };
}

/**
 * Check codex exec timeout should be sane for production (>= 3600).
 */
export function checkCodexExecSettings(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  
  let timeout = parseInt(process.env.GPTWORK_CODEX_EXEC_TIMEOUT || "0", 10);
  let concurrency = parseInt(process.env.GPTWORK_CODEX_CONCURRENCY || "0", 10);
  
  if (!timeout && existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    timeout = parseInt(envVars.GPTWORK_CODEX_EXEC_TIMEOUT || "0", 10);
    concurrency = parseInt(envVars.GPTWORK_CODEX_CONCURRENCY || "0", 10);
  }
  
  const warnings = [];
  if (!timeout) {
    warnings.push("codex exec timeout not configured (default: 3600s)");
  } else if (timeout < 3600) {
    warnings.push(`codex exec timeout ${timeout}s is low for production (recommended >= 3600)`);
  }
  
  if (concurrency && concurrency < 1) {
    warnings.push(`codex concurrency ${concurrency} too low (minimum 1)`);
  }
  
  if (warnings.length > 0) {
    return {
      name: "codex_exec_settings",
      status: "warn",
      detail: warnings.join("; "),
      fixable: true,
      fixHint: "Set GPTWORK_CODEX_EXEC_TIMEOUT=3600 and GPTWORK_CODEX_CONCURRENCY=4 in runtime.env"
    };
  }
  
  return {
    name: "codex_exec_settings",
    status: "pass",
    detail: `codex exec timeout=${timeout || 3600}s, concurrency=${concurrency || 4}`
  };
}

/**
 * Check commit baseline vs current HEAD.
 */
export function checkCurrentHeadDiagnostics(projectRoot) {
  const root = projectRoot || PROJECT_ROOT;
  let currentHead = null;
  
  try {
    currentHead = execSync("git rev-parse HEAD 2>/dev/null", { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  } catch {}
  
  // Check for baseline reference in docs or .gptwork
  let baselineRef = null;
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    try {
      const launchInitPath = join(docsDir, "launch-initialization.md");
      if (existsSync(launchInitPath)) {
        const initContent = readFileSync(launchInitPath, "utf8");
        const match = initContent.match(/Canonical baseline.*?`([a-f0-9]{7,40})`/);
        if (match) baselineRef = match[1];
      }
    } catch {}
  }
  
  if (!currentHead) {
    return { name: "current_head", status: "skip", detail: "Cannot determine current HEAD" };
  }
  
  if (baselineRef && currentHead.startsWith(baselineRef)) {
    return {
      name: "current_head",
      status: "pass",
      detail: `Current HEAD ${currentHead.slice(0, 12)} matches canonical baseline ${baselineRef.slice(0, 12)}`
    };
  }
  
  if (baselineRef) {
    return {
      name: "current_head",
      status: "warn",
      detail: `Current HEAD ${currentHead.slice(0, 12)} differs from docs baseline ${baselineRef.slice(0, 12)} (verify deployment)`,
      fixHint: "Run: git log --oneline -1 HEAD; grep 'Canonical baseline' docs/launch-initialization.md"
    };
  }
  
  return {
    name: "current_head",
    status: "pass",
    detail: `Current HEAD: ${currentHead.slice(0, 12)} (no canonical baseline reference found)`
  };
}

/**
 * Check workspace root, state path, and default repo settings.
 */
export function checkWorkspaceSettings(gptworkDir, projectRoot) {
  const dir = gptworkDir || GPTWORK_DIR;
  const root = projectRoot || PROJECT_ROOT;
  const envPath = join(dir, "runtime.env");
  
  let statePath = process.env.GPTWORK_STATE_PATH || "";
  let workspaceRoot = process.env.GPTWORK_WORKSPACE_ROOT || "";
  let defaultRepo = process.env.GPTWORK_DEFAULT_REPO || "";
  
  if (existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    if (!statePath) statePath = envVars.GPTWORK_STATE_PATH || "";
    if (!workspaceRoot) workspaceRoot = envVars.GPTWORK_WORKSPACE_ROOT || "";
    if (!defaultRepo) defaultRepo = envVars.GPTWORK_DEFAULT_REPO || "";
  }
  
  const findings = [];
  if (!statePath) findings.push("GPTWORK_STATE_PATH not configured (default: .gptwork/state.json)");
  if (!workspaceRoot) findings.push("GPTWORK_WORKSPACE_ROOT not configured (default: data/workspaces/default)");
  if (!defaultRepo) findings.push("GPTWORK_DEFAULT_REPO not configured");
  
  if (findings.length > 0) {
    return {
      name: "workspace_settings",
      status: "warn",
      detail: findings.join("; "),
      fixable: true,
      fixHint: "Set GPTWORK_STATE_PATH, GPTWORK_WORKSPACE_ROOT, GPTWORK_DEFAULT_REPO in runtime.env"
    };
  }
  
  return {
    name: "workspace_settings",
    status: "pass",
    detail: `repo=${defaultRepo}, state=${statePath || ".gptwork/state.json"}, workspace=${workspaceRoot || "data/workspaces/default"}`
  };
}

/**
 * Check context vector store configuration.
 */
export function checkContextVectorStore(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  
  let vectorStore = process.env.GPTWORK_CONTEXT_VECTOR_STORE || "";
  if (!vectorStore && existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    vectorStore = envVars.GPTWORK_CONTEXT_VECTOR_STORE || "";
  }
  
  if (!vectorStore || vectorStore === "auto") {
    return {
      name: "context_vector_store",
      status: "pass",
      detail: "Context vector store: auto (will detect zvec availability)"
    };
  }
  
  if (vectorStore === "none" || vectorStore === "off") {
    return {
      name: "context_vector_store",
      status: "warn",
      detail: "Context vector store disabled (GPTWORK_CONTEXT_VECTOR_STORE=none)",
      fixHint: "Set GPTWORK_CONTEXT_VECTOR_STORE=auto (recommended) or install zvec"
    };
  }
  
  return {
    name: "context_vector_store",
    status: "pass",
    detail: `Context vector store: ${vectorStore}`
  };
}

/**
 * Check integration mode settings.
 */
export function checkIntegrationMode(gptworkDir) {
  const dir = gptworkDir || GPTWORK_DIR;
  const envPath = join(dir, "runtime.env");
  
  let mode = process.env.GPTWORK_INTEGRATION_MODE || "";
  if (!mode && existsSync(envPath)) {
    const envVars = parseEnvFile(envPath);
    mode = envVars.GPTWORK_INTEGRATION_MODE || "";
  }
  
  if (!mode || mode === "auto") {
    return {
      name: "integration_mode",
      status: "pass",
      detail: "Integration mode: auto (ff-only merge when applicable)"
    };
  }
  
  return {
    name: "integration_mode",
    status: "pass",
    detail: `Integration mode: ${mode}`
  };
}

/**
 * Run only production-profile checks.
 */
export function runProductionProfile(opts = {}) {
  const gptworkDir = opts.gptworkDir || GPTWORK_DIR;
  const projectRoot = opts.projectRoot || PROJECT_ROOT;

  return [
    checkProductionWorkerEnabled(gptworkDir),
    checkVerifierReviewerCommands(gptworkDir),
    checkAgentRoleBackends(gptworkDir),
    checkReleaseGateCommands(gptworkDir),
    checkCodexExecSettings(gptworkDir),
    checkCurrentHeadDiagnostics(projectRoot),
    checkWorkspaceSettings(gptworkDir, projectRoot),
    checkContextVectorStore(gptworkDir),
    checkIntegrationMode(gptworkDir),
  ];
}

// ───────────────────────────────────────────────────────────────────
// Internal Helpers for Profile Checks
// ───────────────────────────────────────────────────────────────────

function parseSimpleMap(raw, separator) {
  const text = String(raw || "").trim();
  if (!text) return {};
  const out = {};
  for (const entry of text.split(separator)) {
    const part = entry.trim();
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    const val = part.slice(eqIdx + 1).trim().toLowerCase();
    if (key && val) out[key] = val;
  }
  return out;
}
// Composite Commands
// ───────────────────────────────────────────────────────────────────

/**
 * Run the full check suite (no mutations).
 */
export function runFullCheck(opts = {}) {
  const gptworkDir = opts.gptworkDir || GPTWORK_DIR;
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  const backendRoot = opts.backendRoot || BACKEND_ROOT;

  const checks = [
    checkNodeVersion(),
    checkGitAvailability(),
    checkGitRepo(),
    checkGptworkDir(gptworkDir),
    checkRuntimeEnv(gptworkDir),
    checkProjectContext(gptworkDir),
    checkRepoRegistry(gptworkDir),
    checkNpmDeps(backendRoot),
    checkRequiredDirs(projectRoot),
    checkDirtyRepo(PROJECT_ROOT),
    checkCodexAvailability(),
  ];

  // Append production profile checks when requested
  if (opts.production) {
    checks.push(...runProductionProfile(opts));
  }

  return checks;
}

/**
 * Run the full init workflow: create dirs/templates and run checks.
 */
export async function runInit(opts = {}) {
  const gptworkDir = opts.gptworkDir || GPTWORK_DIR;
  const projectRoot = opts.projectRoot || PROJECT_ROOT;

  mkdirSync(gptworkDir, { recursive: true });
  mkdirSync(join(gptworkDir, "goals"), { recursive: true });
  mkdirSync(join(gptworkDir, "reports"), { recursive: true });
  mkdirSync(join(gptworkDir, "workflows"), { recursive: true });
  mkdirSync(join(projectRoot, "data/workspaces/default"), { recursive: true });
  mkdirSync(join(projectRoot, "data/workspaces/archive"), { recursive: true });
  mkdirSync(join(projectRoot, "data/logs"), { recursive: true });

  const checks = runFullCheck(opts);

  // Create project.md if missing
  const projectMdPath = join(gptworkDir, "project.md");
  if (!existsSync(projectMdPath)) {
    writeFileSync(projectMdPath, getDefaultProjectMd(), "utf8");
  }

  // Create project.env if missing
  const projectEnvPath = join(gptworkDir, "project.env");
  if (!existsSync(projectEnvPath)) {
    writeFileSync(projectEnvPath, getDefaultProjectEnv(), "utf8");
  }

  // Create runtime.env from example if both missing and example exists
  const envPath = join(gptworkDir, "runtime.env");
  const examplePath = join(gptworkDir, "runtime.env.example");
  if (!existsSync(envPath) && existsSync(examplePath)) {
    writeFileSync(envPath, readFileSync(examplePath, "utf8"), "utf8");
  }

  return checks;
}

/**
 * Fix common issues (sans security, sans dirty repo).
 */
export async function runFix(opts = {}) {
  const gptworkDir = opts.gptworkDir || GPTWORK_DIR;
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  const backendRoot = opts.backendRoot || BACKEND_ROOT;
  const fixes = [];
  const warnings = [];

  // 1. Check dirty repo — refuse to fix
  const dirtyCheck = checkDirtyRepo(projectRoot);
  if (dirtyCheck.status === "warn") {
    warnings.push("Dirty repo detected — fix aborted. Commit or stash changes first.");
    return { fixes, warnings };
  }

  // 2. Ensure directories
  mkdirSync(join(gptworkDir, "goals"), { recursive: true });
  mkdirSync(join(gptworkDir, "reports"), { recursive: true });
  mkdirSync(join(gptworkDir, "workflows"), { recursive: true });
  mkdirSync(join(projectRoot, "data/workspaces/default"), { recursive: true });
  mkdirSync(join(projectRoot, "data/workspaces/archive"), { recursive: true });
  mkdirSync(join(projectRoot, "data/logs"), { recursive: true });
  fixes.push("Created required directories");

  // 3. Create runtime.env from example if missing
  const envPath = join(gptworkDir, "runtime.env");
  const examplePath = join(gptworkDir, "runtime.env.example");
  if (!existsSync(envPath)) {
    if (existsSync(examplePath)) {
      writeFileSync(envPath, readFileSync(examplePath, "utf8"), "utf8");
      fixes.push("Created .gptwork/runtime.env from template");
    } else {
      writeFileSync(envPath, generateBasicRuntimeEnv(), "utf8");
      fixes.push("Created .gptwork/runtime.env with defaults");
    }
  } else {
    fixes.push(".gptwork/runtime.env already exists (not overwritten)");
  }

  // 4. Create project.md if missing
  const projectMdPath = join(gptworkDir, "project.md");
  if (!existsSync(projectMdPath)) {
    writeFileSync(projectMdPath, getDefaultProjectMd(), "utf8");
    fixes.push("Created .gptwork/project.md");
  }

  // 5. Create project.env if missing
  const projectEnvPath = join(gptworkDir, "project.env");
  if (!existsSync(projectEnvPath)) {
    writeFileSync(projectEnvPath, getDefaultProjectEnv(), "utf8");
    fixes.push("Created .gptwork/project.env");
  }

  // 6. Run npm install if node_modules missing
  const nmPath = join(backendRoot, "node_modules");
  if (!existsSync(nmPath)) {
    try {
      execSync("npm install --no-audit --no-fund 2>/dev/null", { cwd: backendRoot, timeout: 120000, stdio: "pipe" });
      fixes.push("Ran npm install");
    } catch {
      warnings.push("npm install failed — run 'cd backend && npm install' manually");
    }
  }

  // 7. Create repos.json if missing
  const reposPath = join(gptworkDir, "repos.json");
  if (!existsSync(reposPath)) {
    if (existsSync(join(projectRoot, ".git"))) {
      try {
        const remoteUrl = execSync("git remote get-url origin 2>/dev/null", { encoding: "utf8", timeout: 5000 }).trim();
        const repoId = remoteUrl.replace(/^.*@/, "").replace(/^https?:\/\//, "").replace(/\.git$/, "");
        const parts = repoId.split("/");
        const owner = parts.length >= 2 ? parts[parts.length - 2] : "unknown";
        const repoName = parts.length >= 1 ? parts[parts.length - 1] : "repo";
        const registry = {
          version: 1,
          updated_at: new Date().toISOString(),
          repositories: [{
            repo_id: repoId || "local/repo",
            provider: "github",
            host: "github.com",
            owner: owner,
            repo_name: repoName,
            remote_url: remoteUrl || "git@github.com:local/repo.git",
            default_branch: "main",
            canonical_path: projectRoot,
            roles: ["primary"],
            tags: [],
            status: "active",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }]
        };
        writeFileSync(reposPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
        fixes.push("Created .gptwork/repos.json from git remote");
      } catch {
        writeFileSync(reposPath, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), repositories: [] }, null, 2) + "\n", "utf8");
        fixes.push("Created .gptwork/repos.json (empty)");
      }
    } else {
      writeFileSync(reposPath, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), repositories: [] }, null, 2) + "\n", "utf8");
      fixes.push("Created .gptwork/repos.json (empty)");
    }
  }

  return { fixes, warnings };
}

// ───────────────────────────────────────────────────────────────────
// Report Formatting
// ───────────────────────────────────────────────────────────────────

/**
 * Print a formatted init/doctor report to console.
 */
export function printInitReport(checks, { showNextSteps = true } = {}) {
  const statusCounts = { pass: 0, warn: 0, fail: 0, skip: 0, blocker: 0 };
  for (const c of checks) {
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
  }

  console.log("GPTWork Init Report");
  console.log("=".repeat(60));
  for (const c of checks) {
    const icon = c.status === "pass" ? "\u2714" : c.status === "warn" ? "\u26A0" : c.status === "skip" ? "\u2013" : c.status === "blocker" ? "\u26D4" : "\u2718";
    console.log(`  ${icon} ${c.name}: ${c.detail.slice(0, 100)}`);
  }

  console.log("");
  console.log(`Summary: ${statusCounts.pass || 0} passed, ${statusCounts.warn || 0} warnings, ${statusCounts.blocker || 0} blockers, ${statusCounts.fail || 0} failed, ${statusCounts.skip || 0} skipped`);

  const hasIssues = (statusCounts.blocker || 0) > 0 || (statusCounts.fail || 0) > 0 || (statusCounts.warn || 0) > 0;
  if (hasIssues) {
    console.log("");
    console.log("-- Recommended Actions --");
    for (const c of checks) {
      if ((c.status === "blocker" || c.status === "fail" || c.status === "warn") && c.fixHint) {
        console.log(`  * ${c.name}: ${c.fixHint}`);
      }
    }
  }

  if (showNextSteps) {
    console.log("");
    console.log("-- Next Steps --");
    const allPass = (statusCounts.blocker || 0) === 0 && (statusCounts.fail || 0) === 0;
    if (allPass) {
      console.log("  Everything looks good. Start the server:");
      console.log("  $ gptwork start");
      console.log("");
      console.log("  Verify setup:");
      console.log("  $ gptwork doctor --local");
      console.log("  $ gptwork self-test --local");
    } else {
      console.log("  Some checks failed. Use the actions above, or run:");
      console.log("  $ gptwork fix    # automated repair for common issues");
      console.log("  $ gptwork doctor --local  # detailed diagnostics");
    }
  }
}

/**
 * Print a formatted fix report.
 */
export function printFixReport({ fixes, warnings }) {
  console.log("GPTWork Fix Report");
  console.log("=".repeat(60));
  if (fixes.length === 0 && warnings.length === 0) {
    console.log("  Nothing to fix.");
    return;
  }
  if (fixes.length > 0) {
    console.log("Applied fixes:");
    for (const f of fixes) {
      console.log(`  \u2714 ${f}`);
    }
  }
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const w of warnings) {
      console.log(`  \u26A0 ${w}`);
    }
  }
  console.log("");
  console.log("-- Next Steps --");
  console.log("  $ gptwork init        # verify all checks pass");
  console.log("  $ gptwork doctor --local # detailed diagnostics");
  console.log("  $ gptwork start       # start the MCP server");
}

// ───────────────────────────────────────────────────────────────────
// Default Templates
// ───────────────────────────────────────────────────────────────────

export function getDefaultProjectMd() {
  return `# GPTWork Project Context

## Purpose

GPTWork brings ChatGPT intent and Codex execution into a verifiable delivery loop.

## Runtime

- Default server entry: \`backend/src/cli.mjs\`
- Backend directory: \`backend\`
- Plugin proxy: \`plugins/gpt-codex-workspace/mcp/server.mjs\`
- Test: \`cd backend && npm test\`
- Port: 8787 (default)

## Key Directories

- \`.gptwork/\` — goal files, runtime config, workflows, context index
- \`backend/src/\` — server, tools, lifecycle, queues
- \`backend/test/\` — unit and integration tests
- \`docs/\` — architecture, operations, delivery contracts, setup guides

## Defaults

- Host: 127.0.0.1
- Port: 8787
- Tool mode: standard
- Workspace root: \`data/workspaces/default\`
- State path: \`\${workspaceRoot}/.gptwork/state.json\`

## Generated by

gptwork init
`;
}

export function getDefaultProjectEnv() {
  return `# Project environment variables (non-secret)
# Generated by gptwork init
#
# These are NOT runtime environment variables.
# They provide Codex with project-level context.

PROJECT_NAME=gpt-codex-workspace
PROJECT_TYPE=mcp-coordination-backend
PRIMARY_RUNTIME=node
BACKEND_DIR=backend
SERVER_ENTRY=backend/src/cli.mjs
PRIMARY_TEST_COMMAND=npm test
DEFAULT_MCP_PORT=8787
`;
}

function generateBasicRuntimeEnv() {
  return `# GPTWork runtime configuration
# Generated by gptwork fix -- edit with your values (secrets are NOT committed)

GPTWORK_HOST=127.0.0.1
GPTWORK_PORT=8787
GPTWORK_TOOL_MODE=standard
GPTWORK_REQUIRE_AUTH=true
GPTWORK_CODEX_EXEC_TIMEOUT=3600

# GitHub Issues sync (optional)
# GPTWORK_GITHUB_ENABLED=true
# GPTWORK_GITHUB_REPO=your-org/your-repo
# GPTWORK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Bark notifications (optional)
# GPTWORK_BARK_ENABLED=true
# GPTWORK_BARK_URL=https://api.example.com/push
# GPTWORK_BARK_KEY=your-bark-key
`;
}

// ───────────────────────────────────────────────────────────────────
// Internal Helpers
// ───────────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) vars[key] = val;
  }
  return vars;
}

export default { runInit, runFix, runFullCheck, printInitReport, printFixReport };
