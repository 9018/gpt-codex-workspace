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
  ["code_change", /\b(fix|implement|modify|refactor|add tests?|bug|feature|code|backend|frontend|api|module)\b|修复|实现|代码|改造/iu]
];

function inferOperationKind({ user_request = "", goal_prompt = "", mode = "" } = {}) {
  const text = `${mode}\n${user_request}\n${goal_prompt}`;
  const normalizedMode = String(mode || "").toLowerCase();
  if (normalizedMode === "deploy") return { operation_kind: "deploy", semantic_confidence: "high" };
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

  const selected = matches[0];
  const semantic_confidence = matches.length === 1 ? "high" : "medium";
  return { operation_kind: selected, semantic_confidence };
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

function normalizeExplicitContract(explicit) {
  if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) return {};
  return cloneJson(explicit) || {};
}

export function buildAcceptanceContract(args = {}) {
  const explicit = normalizeExplicitContract(args.acceptance_contract || args.acceptanceContract);
  const explicitKind = explicit.intent?.operation_kind;
  const inferred = inferOperationKind(args);
  const operationKind = KNOWN_OPERATION_KINDS.has(explicitKind) ? explicitKind : inferred.operation_kind;
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

  if (contract.intent.semantic_confidence === "low") {
    addReviewReason(contract, "semantic_ambiguity");
    disableAutoCompletion(contract);
  }

  const validation = validateContractSemantics(contract);
  return validation.normalized;
}

export { inferOperationKind };
