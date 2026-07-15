import { getDefaultAcceptanceContractProfile } from "./contract-profiles.mjs";
import {
  ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  DEFAULT_COMPLETION_POLICY,
  KNOWN_OPERATION_KINDS,
  addReviewReason,
  cloneJson,
  disableAutoCompletion,
  normalizeList,
  normalizeReviewPolicy
} from "./contract-schema.mjs";
import { validateContractSemantics } from "./semantics.mjs";
import { FULL_CONTRACT_DEFAULTS } from "./contract-schema.mjs";


const OPERATION_KIND_ALIASES = Object.freeze({
  implementation: "code_change",
  builder: "code_change",
});

const EXECUTION_MODE_ALIASES = Object.freeze({
  builder: "worktree",
  implementation: "worktree",
});

const MUTATION_SCOPE_ALIASES = Object.freeze({
  code_tests_docs: "repo",
  docs_and_tests_only: "repo",
  docs_tests_only: "repo",
});

function normalizeProductContractAliases(explicit = {}) {
  const normalized = cloneJson(explicit) || {};
  const topKind = String(normalized.operation_kind || "").trim().toLowerCase();
  const intentKind = String(normalized.intent?.operation_kind || "").trim().toLowerCase();
  if (OPERATION_KIND_ALIASES[topKind]) normalized.operation_kind = OPERATION_KIND_ALIASES[topKind];
  if (normalized.intent && OPERATION_KIND_ALIASES[intentKind]) normalized.intent.operation_kind = OPERATION_KIND_ALIASES[intentKind];

  const topExecution = String(normalized.execution_mode || "").trim().toLowerCase();
  const intentExecution = String(normalized.intent?.execution_mode || "").trim().toLowerCase();
  const canonicalExecution = EXECUTION_MODE_ALIASES[topExecution] || EXECUTION_MODE_ALIASES[intentExecution];
  if (canonicalExecution) {
    normalized.intent = { ...(normalized.intent || {}), execution_mode: canonicalExecution };
    delete normalized.execution_mode;
  }

  const topScope = String(normalized.mutation_scope || "").trim().toLowerCase();
  const intentScope = String(normalized.intent?.mutation_scope || "").trim().toLowerCase();
  const canonicalScope = MUTATION_SCOPE_ALIASES[topScope] || MUTATION_SCOPE_ALIASES[intentScope];
  if (canonicalScope) {
    normalized.intent = { ...(normalized.intent || {}), mutation_scope: canonicalScope };
    delete normalized.mutation_scope;
  }

  normalized.requirements = { ...(normalized.requirements || {}) };
  for (const field of ["requires_commit", "requires_integration", "requires_restart", "requires_deployment_check"]) {
    if (typeof normalized[field] === "boolean") {
      normalized.requirements[field] = normalized[field];
      delete normalized[field];
    }
  }
  return normalized;
}

const OPERATION_PATTERNS = [
  ["data_migration", /\b(migrat(e|ion)|schema migration|backfill|rollback plan|database migration)\b|数据迁移|回滚/iu],
  ["external_sync", /\b(sync|synchroni[sz]e|external system|google drive|canva|github issue|remote service)\b|同步|外部系统/iu],
  ["cleanup", /\b(clean ?up|cleanup|remove stale|prune|archive old|delete old|garbage collect)\b|清理|删除旧|归档/iu],
  ["diagnostic", /\b(diagnos(e|tic)|inspect|investigate|analy[sz]e|debug why|read.?only|status only|summari[sz]e findings)\b|诊断|排查|只读|分析原因/iu],
  ["restart", /\b(restart|reload service|bounce|safe restart|reboot)\b|重启|重新启动/iu],
  ["deploy", /\b(deploy|deployment|release to|rollout|start service|container|docker service)\b|部署|发布/iu],
  ["admin_command", /\b(admin command|management command|run command|execute command|queue recovery|recover(y)? command|rotate|flush|repair queue)\b|管理命令|执行命令|恢复队列/iu],
  ["file_write", /\b(write|create|add|save|generate)\b.{0,80}\bfile\b|写入文件|添加文件|新建文件/iu],
  ["docs_only", /\b(docs?|documentation|readme|changelog|guide|manual)\b|文档|说明/iu],
  ["config_change", /\b(config|configuration|env var|\.env|settings|yaml|toml|reload config)\b|配置/iu],
  ["noop", /\b(noop|no-op|do nothing|no action|already done)\b|无需操作|无需改动/iu],
  ["code_change", /\b(fix|implement|modify|refactor|add tests?|bug|feature|code|backend|frontend|api|module)\b|修复|实现|代码|改造/iu],
  ["readonly_validation", /\b(validat(e|ion)|check status|inspect|read.?only|verify state|analy[sz]e only|summari[sz]e)\b|只读验证|检查状态/iu],
  ["already_integrated", /\b(already (integrated|merged)|previously (integrated|applied)|already exist|nothing to integrate)\b|已经集成|已完成|无需集成/iu],
  ["integration", /\b(integrat(e|ion|ing)|merge|ff.?only|fast.?forward|land change|push branch|merge queue|ff-only merge)\b|集成|合并/iu],
  ["repair", /\b(repair|fix issue|correct|remediate|recover|resolve bug|patch|hotfix|fix failing|auto.?repair)\b|修复|更正|补救/iu],
  ["queue_admin", /\b(queue admin|manage queue|queue operation|reorder queue|queue recovery|advance queue|clear queue|pause queue)\b|队列管理|队列操作/iu],
];

function inferOperationKind({ user_request = "", goal_prompt = "", mode = "" } = {}) {
  const text = `${mode}\n${user_request}\n${goal_prompt}`;
  const requestedMode = String(mode || "").toLowerCase();
  const normalizedMode = requestedMode === "implementation" || requestedMode === "code_change" ? "builder" : requestedMode;
  if (normalizedMode === "deploy") return { operation_kind: "deploy", semantic_confidence: "high" };
  if (normalizedMode === "readonly" && /validat(e|ion)|检查|验证/iu.test(text)) return { operation_kind: "readonly_validation", semantic_confidence: "medium" };
  if (normalizedMode === "readonly") return { operation_kind: "diagnostic", semantic_confidence: "medium" };
  if (normalizedMode === "admin" && /restart|重启/iu.test(text)) return { operation_kind: "restart", semantic_confidence: "high" };
  if (normalizedMode === "admin" && /cleanup|clean ?up|清理|delete old|prune/iu.test(text)) return { operation_kind: "cleanup", semantic_confidence: "high" };
  if (normalizedMode === "admin" && /command|queue recovery|recover|管理命令|执行命令/iu.test(text)) return { operation_kind: "admin_command", semantic_confidence: "high" };

  const matches = [];
  for (const [kind, pattern] of OPERATION_PATTERNS) {
    if (pattern.test(text)) matches.push(kind);
  }
  if (matches.length === 0 && normalizedMode === "builder") return { operation_kind: "code_change", semantic_confidence: "low" };
  if (matches.length === 0) return { operation_kind: "noop", semantic_confidence: "low" };

  const selected = selectOperationKind({ matches, text, normalizedMode });
  const semantic_confidence = matches.length === 1 ? "high" : "medium";
  return { operation_kind: selected, semantic_confidence };
}

const BUILDER_CODE_INTENT_PATTERN = /\b(fix|implement|modify|refactor|add tests?|bug|feature|code|backend|frontend|api|module|runtime[- ]fix|reconciler|classifier|classification|contract|test|commit)\b|修复|实现|代码|改造|验收|合约|误判|分类|收敛/iu;

function selectOperationKind({ matches = [], text = "", normalizedMode = "" } = {}) {
  const unique = [...new Set(matches)];

  // Builder tasks often mention the *wrong* contract/profile they are fixing
  // (for example: "cleanup/admin contract was misclassified").  Do not let a
  // negative reference to cleanup/admin outrank a clear code-change intent.
  if (
    normalizedMode === "builder" &&
    (unique.includes("code_change") || unique.includes("repair")) &&
    BUILDER_CODE_INTENT_PATTERN.test(text)
  ) {
    // Builder prompts frequently describe runtime operations (migration, restart,
    // deploy, cleanup) as capabilities being implemented or as prior bad
    // classifications. A clear code-edit intent must outrank those referenced
    // operation words; explicit acceptance_contract values still win earlier.
    return unique.includes("code_change") ? "code_change" : "repair";
  }

  return unique[0];
}

function byId(items) {
  const result = new Map();
  for (const item of normalizeList(items)) {
    const id = item?.id ? String(item.id) : JSON.stringify(item);
    result.set(id, item);
  }
  return result;
}

function mergeUniqueById(defaultItems, explicitItems) {
  const merged = byId(defaultItems);
  for (const item of normalizeList(explicitItems)) {
    const id = item?.id ? String(item.id) : JSON.stringify(item);
    merged.set(id, { ...(merged.get(id) || {}), ...item });
  }
  return [...merged.values()];
}

function mergeVerificationPlan(defaultPlan = {}, explicitPlan = {}) {
  return {
    ...defaultPlan,
    ...explicitPlan,
    required_commands: [...new Set([...normalizeList(defaultPlan.required_commands), ...normalizeList(explicitPlan.required_commands)].map(String))],
    required_reports: [...new Set([...normalizeList(defaultPlan.required_reports), ...normalizeList(explicitPlan.required_reports)].map(String))]
  };
}

function hasCharacterIndexedKeys(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (/^\d+$/.test(key)) return true;
  }
  return false;
}

function normalizeExplicitContract(explicit) {
  if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) return { normalized: {}, intentCorrupted: false };
  const normalized = cloneJson(explicit) || {};
  if (typeof normalized.intent === "string") {
    normalized.intent = { operation_kind: normalized.intent };
  }
  // Detect and strip character-indexed keys from intent (serialization
  // artifacts where a string was serialized as {"0":"i","1":"m",...}).
  // Track whether the intent was corrupted so callers can restore defaults.
  const intentCorrupted = hasCharacterIndexedKeys(normalized.intent);
  if (intentCorrupted && normalized.intent && typeof normalized.intent === "object") {
    for (const key of Object.keys(normalized.intent)) {
      if (/^\d+$/.test(key)) {
        delete normalized.intent[key];
      }
    }
  }
  return { normalized, intentCorrupted };
}

export function buildAcceptanceContract(args = {}) {
  const rawExplicit = normalizeProductContractAliases(args.acceptance_contract || args.acceptanceContract);
  const { normalized: explicit, intentCorrupted } = normalizeExplicitContract(rawExplicit);
  // P0: Top-level explicit fields beat intent block enrichment.
  // The intent block may contain auto-classified or corrupted values
  // (e.g. data_migration from semantic inference), while the top-level
  // fields are set deliberately by the caller.
  const explicitTopKind = explicit.operation_kind || args.operation_kind;
  const explicitIntentKind = explicit.intent?.operation_kind;
  const explicitKind = KNOWN_OPERATION_KINDS.has(explicitTopKind) ? explicitTopKind
    : KNOWN_OPERATION_KINDS.has(explicitIntentKind) ? explicitIntentKind
    : undefined;
  const inferred = inferOperationKind(args);
  const operationKind = explicitKind || inferred.operation_kind;
  const defaults = getDefaultAcceptanceContractProfile(operationKind);

  const contract = {
    ...defaults,
    ...explicit,
    schema_version: ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    intent: {
      ...defaults.intent,
      ...(explicit.intent || {})
    },
    requirements: {
      ...defaults.requirements,
      ...(explicit.requirements || {})
    },
    verification_plan: mergeVerificationPlan(defaults.verification_plan, explicit.verification_plan || {}),
    blocking_requirements: mergeUniqueById(defaults.blocking_requirements, explicit.blocking_requirements),
    state_assertions: mergeUniqueById(defaults.state_assertions, explicit.state_assertions),
    non_blocking_quality_expectations: mergeUniqueById(defaults.non_blocking_quality_expectations, explicit.non_blocking_quality_expectations),
    completion_policy: {
      ...DEFAULT_COMPLETION_POLICY,
      ...(defaults.completion_policy || {}),
      ...(explicit.completion_policy || {})
    },
    review_policy: normalizeReviewPolicy({
      requires_review_when: [
        ...normalizeList(defaults.review_policy?.requires_review_when),
        ...normalizeList(explicit.review_policy?.requires_review_when)
      ]
    })
  };

  contract.intent.operation_kind = operationKind;
  if (!explicit.intent?.semantic_confidence) contract.intent.semantic_confidence = inferred.semantic_confidence;

  // When explicit intent had character-indexed keys (serialization artifact),
  // restore mutation_scope and execution_mode from profile defaults to prevent
  // corrupted enrichment fields from leaking into the contract.
  // Full-mode enforcement below overrides the restored value when applicable.
  if (intentCorrupted) {
    const profileDefaults = getDefaultAcceptanceContractProfile(operationKind);
    if (profileDefaults?.intent) {
      contract.intent.mutation_scope = profileDefaults.intent.mutation_scope || defaults.intent.mutation_scope;
      contract.intent.execution_mode = profileDefaults.intent.execution_mode || defaults.intent.execution_mode;
    }
  }

  // P1: Full mode enforcement — all contracts operate in "full" mode.
  // Legacy modes (readonly, diagnostic, implementation, deploy, admin) are removed.
  contract.mode = "full";
  contract.intent.execution_mode = "full";

  // Apply full contract defaults for new v2 fields
  // Legacy top-level aliases must mirror canonical requirements. Applying
  // full-mode defaults here incorrectly upgrades diagnostic/readonly contracts
  // to code-change semantics even when requirements explicitly disable them.
  contract.requires_commit = typeof contract.requirements?.requires_commit === "boolean"
    ? contract.requirements.requires_commit
    : FULL_CONTRACT_DEFAULTS.requires_commit;
  contract.requires_integration = typeof contract.requirements?.requires_integration === "boolean"
    ? contract.requirements.requires_integration
    : FULL_CONTRACT_DEFAULTS.requires_integration;
  if (!Array.isArray(contract.required_checks)) contract.required_checks = [];
  if (!contract.retry_policy) contract.retry_policy = { ...FULL_CONTRACT_DEFAULTS.retry_policy };
  if (!contract.acceptance_policy) contract.acceptance_policy = { ...FULL_CONTRACT_DEFAULTS.acceptance_policy };

  if (contract.intent.semantic_confidence === "low") {
    addReviewReason(contract, "semantic_ambiguity");
    disableAutoCompletion(contract);
  }

  const validation = validateContractSemantics(contract);
  return validation.normalized;
}

export { inferOperationKind };
