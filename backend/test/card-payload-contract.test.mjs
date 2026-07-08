/**
 * card-payload-contract.test.mjs
 *
 * Enforces the GPTWork query/card separation contract:
 * - ChatGPT query payload (structuredContent / modelPayload) = bounded model-facing view
 * - v5 card payload (_meta.gptwork_card / structuredContent.card) = lightweight user-facing view
 * - deep evidence/debug payload = explicit dedicated tools only
 *
 * These tests fail if:
 *   - Card payload embeds deep task details (logs, full result objects, acceptance evidence)
 *   - list_tasks default returns full task objects in structuredContent
 *   - get_task card dumps raw task data instead of lifecycle progress
 *   - Any card payload exceeds 50 KB
 */
import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

const TOOL_CARD_URI = "ui://widget/gptwork-tool-card-v5.html";
const CARD_SCHEMA_VERSION = "gptwork-card-v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "gptwork-card-contract-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true,
    ...extra,
  });
}

async function rpc(server, method, params = {}, token = "test-token") {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return server.handleRpc(
    { jsonrpc: "2.0", id: 1, method, params },
    headers,
  );
}

/**
 * Create a "full" task object with deep evidence fields such as logs,
 * result objects, acceptance checks, verification commands, etc.
 * This simulates a real task after full execution.
 */
function createDeepTask(overrides = {}) {
  return {
    id: "task_deep_1",
    goal_id: "goal_deep_1",
    title: "Deep task with full evidence",
    status: "completed",
    assignee: "codex",
    mode: "builder",
    created_at: "2026-06-01T00:00:00.000Z",
    logs: [
      { time: "2026-06-01T01:00:00.000Z", message: "Started working on implementation" },
      { time: "2026-06-01T01:30:00.000Z", message: "Completed main implementation" },
      { time: "2026-06-01T02:00:00.000Z", message: "Tests all pass" },
    ],
    result: {
      summary: "Implementation complete. All tests pass.",
      commit: "abc123def4567890abcdef1234567890abcdef12",
      tests: "npm test — 24 passing, 0 failing",
      changed_files: ["src/main.mjs", "src/utils.mjs", "test/main.test.mjs", "test/utils.test.mjs"],
      acceptance: {
        overall_status: "passed",
        checks: {
          result_json_valid: true,
          summary_present: true,
          safe_changed_paths: true,
          verification_present_for_non_noop: true,
          verification_passed: true,
          worktree_clean: true,
          no_blocker_or_major_findings: true,
        },
        findings: [],
        repair_proposals: [],
      },
      verification: {
        passed: true,
        commands: [
          { cmd: "npm test", exit_code: 0 },
          { cmd: "npm run check:syntax", exit_code: 0 },
          { cmd: "npm run check:imports", exit_code: 0 },
        ],
      },
      integration: {
        mode: "commit",
        commit: "abc123def4567890",
        push_status: "passed",
        merge_status: "completed",
      },
      convergence: { status: "finalizing", next_action: "auto_finalize_convergence" },
      warnings: [],
    },
    ...overrides,
  };
}

async function seedState(server, storeData) {
  const store = server.getStoreForTests();
  await store.load();
  if (storeData.tasks !== undefined) store.state.tasks = storeData.tasks;
  if (storeData.goals !== undefined) store.state.goals = storeData.goals;
  await store.save();
}

// =========================================================================
// CONTRACT-1: list_tasks card payload must be lightweight
// =========================================================================

test("CONTRACT-1: list_tasks card payload excludes deep task details", async () => {
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const res = await rpc(server, "tools/call", { name: "list_tasks", arguments: {} });

  const card = res.result._meta?.gptwork_card;
  assert.ok(card, "list_tasks must have gptwork_card in _meta");

  // Card must NOT embed deep task details
  assert.equal(card.logs, undefined, "card must not embed task logs");
  assert.equal(card.result, undefined, "card must not embed task result object");
  assert.equal(card.acceptance, undefined, "card must not embed acceptance details");
  assert.equal(card.verification, undefined, "card must not embed verification details");
  assert.equal(card.task, undefined, "card must not embed full task object");
  assert.equal(card.tasks, undefined, "card must not embed raw tasks array");
  assert.equal(card.evidence, undefined, "card must not embed evidence");

  // Card must have the correct bounded structure
  assert.equal(card.card_version, CARD_SCHEMA_VERSION, "card must have correct schema version");
  assert.equal(card.card_type, "queue", "card type must be queue for list_tasks");
  assert.ok(card.identity, "card must have identity");
  assert.equal(card.identity.tool, "list_tasks", "card identity must identify tool");
  assert.ok(card.summary, "card must have summary");
  assert.ok(Array.isArray(card.key_values), "card must have key_values array");

  // Key values are summary counts only
  const hasTaskCount = card.key_values.some(kv => kv.key === "tasks" && kv.value === 1);
  assert.ok(hasTaskCount, "card key_values must include task count");

  // All sections use bounded row fields (no logs/result dump)
  for (const section of card.sections) {
    if (section.type === "table" && Array.isArray(section.rows)) {
      for (const row of section.rows) {
        assert.ok(typeof row.id === "string", "table row must have bounded id field");
        assert.ok(!("result" in row), "table row must not embed task result");
        assert.ok(!("logs" in row), "table row must not embed task logs");
        assert.ok(!("evidence" in row), "table row must not embed evidence");
        assert.ok(!("acceptance" in row), "table row must not embed acceptance");
      }
    }
  }
});

// =========================================================================
// CONTRACT-1b: list_tasks modelPayload excludes raw task array
// =========================================================================

test("CONTRACT-1b: list_tasks modelPayload excludes raw tasks array", async () => {
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const res = await rpc(server, "tools/call", { name: "list_tasks", arguments: {} });
  const sc = res.result.structuredContent;

  // modelPayload must have tool metadata
  assert.equal(sc.gptwork_tool, "list_tasks", "modelPayload must identify tool");
  assert.equal(sc.gptwork_type, "tool_result", "modelPayload must have tool_result type");
  assert.ok(typeof sc.summary === "string", "modelPayload must have string summary");
  assert.ok(typeof sc.status === "string", "modelPayload must have string status");
  assert.ok(sc.gptwork_payload_hash, "modelPayload must have payload hash");
  assert.equal(sc.rawAvailable, true, "modelPayload must declare rawAvailable");

  // modelPayload must NOT contain raw task objects or deep details
  assert.equal(sc.tasks, undefined, "modelPayload must not embed raw tasks array");
  assert.equal(sc.logs, undefined, "modelPayload must not embed task logs");
  assert.equal(sc.result, undefined, "modelPayload must not embed task result");
  assert.equal(sc.acceptance, undefined, "modelPayload must not embed acceptance");
  assert.equal(sc.verification, undefined, "modelPayload must not embed verification");

  // Backward compat card exists inside modelPayload and is bounded
  assert.ok(sc.card, "modelPayload must have backward compat card");
  assert.equal(sc.card.card_version, CARD_SCHEMA_VERSION, "backward compat card must use correct schema version");
  assert.equal(sc.card.card_type, "queue", "backward compat card must have queue type");
});

// =========================================================================
// CONTRACT-2: Model-facing output vs card payload are structurally distinct
// =========================================================================

test("CONTRACT-2: modelPayload and card are structurally distinct", async () => {
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const res = await rpc(server, "tools/call", { name: "list_tasks", arguments: {} });

  const sc = res.result.structuredContent;
  const card = res.result._meta?.gptwork_card;

  // modelPayload and card are separate objects
  assert.notEqual(sc, card, "modelPayload and card must be different objects");

  // modelPayload has card embedded for backward compat
  assert.equal(sc.card, card, "structuredContent.card must reference same card as _meta.gptwork_card");

  // modelPayload has tool metadata that the card does not mirror
  assert.ok(sc.gptwork_tool, "modelPayload has gptwork_tool");
  assert.ok(sc.gptwork_type, "modelPayload has gptwork_type");
  assert.ok(sc.gptwork_payload_hash, "modelPayload has payload hash");
  assert.ok(sc.gptwork_card_instance_id, "modelPayload has card instance id");

  // modelPayload fields that the card does NOT have
  assert.equal(card.gptwork_tool, undefined, "card must not have gptwork_tool field");
  assert.equal(card.gptwork_type, undefined, "card must not have gptwork_type field");
  assert.equal(card.gptwork_payload_hash, undefined, "card must not have payload hash");
  assert.equal(card.gptwork_card_instance_id, undefined, "card must not have instance id");

  // Card has view model fields that modelPayload does NOT have
  assert.ok(card.card_version, "card has card_version");
  assert.ok(card.card_type, "card has card_type");
  assert.ok(card.identity, "card has identity");
  assert.ok(Array.isArray(card.sections) || Array.isArray(card.key_values),
    "card must have sections or key_values");
});

// =========================================================================
// CONTRACT-2b: runtime_status card boundedness
// =========================================================================

test("CONTRACT-2b: runtime_status card payload is bounded view model", async () => {
  const server = await makeServer({ toolMode: "standard" });

  const res = await rpc(server, "tools/call", { name: "runtime_status", arguments: {} });

  // Card must be a bounded view model
  const card = res.result._meta?.gptwork_card;
  assert.ok(card, "runtime_status must have card");
  assert.equal(card.card_version, CARD_SCHEMA_VERSION);
  assert.equal(card.card_type, "runtime_health", "card type must be runtime_health");
  assert.ok(card.identity, "card must have identity");
  assert.equal(card.identity.tool, "runtime_status", "card identity must identify tool");

  // Card must NOT carry raw runtime fields
  assert.equal(card.pid, undefined, "card must not have raw pid");
  assert.equal(card.running_commit, undefined, "card must not have raw running_commit");
  assert.equal(card.worker, undefined, "card must not embed raw worker object");
  assert.equal(card.queue, undefined, "card must not embed raw queue object");
  assert.equal(card.dirty_paths, undefined, "card must not embed raw dirty_paths array");

  // modelPayload must also be bounded (no raw fields)
  const sc = res.result.structuredContent;
  assert.equal(sc.pid, undefined, "modelPayload must not have raw pid");
  assert.equal(sc.running_commit, undefined, "modelPayload must not have raw running_commit");
  assert.equal(sc.worker, undefined, "modelPayload must not embed raw worker object");
  assert.equal(sc.queue, undefined, "modelPayload must not embed raw queue object");
});

// =========================================================================
// CONTRACT-3: List-style queries default to shallow
// =========================================================================

test("CONTRACT-3: list_tasks default query has no deep task details in sections", async () => {
  const deepTasks = [
    createDeepTask({ id: "task_a", title: "Task A with deep evidence" }),
    createDeepTask({ id: "task_b", title: "Task B with deep evidence" }),
  ];
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: deepTasks });

  const res = await rpc(server, "tools/call", { name: "list_tasks", arguments: {} });
  const card = res.result._meta?.gptwork_card;
  assert.ok(card, "must have card");

  const recentSection = card.sections.find(s => s.title === "Recent tasks");
  assert.ok(recentSection, "card must have Recent tasks section");

  // Each row in recent tasks must use bounded fields only
  if (Array.isArray(recentSection.rows)) {
    for (const row of recentSection.rows) {
      assert.ok(typeof row.id === "string", "row must have bounded id");
      assert.ok(typeof row.title === "string", "row must have bounded title");
      assert.ok(typeof row.status === "string", "row must have bounded status");
      assert.equal(row.result, undefined, "row must not embed result object");
      assert.equal(row.logs, undefined, "row must not embed logs array");
      assert.equal(row.acceptance, undefined, "row must not embed acceptance object");
      assert.equal(row.verification, undefined, "row must not embed verification object");
      assert.equal(row.changed_files, undefined, "row must not embed changed_files array");
    }
  }

  // structuredContent must not carry raw task data either
  const sc = res.result.structuredContent;
  assert.equal(sc.tasks, undefined, "structuredContent must not embed raw tasks array");
});

// =========================================================================
// CONTRACT-4: get_task card is a bounded lifecycle view
// =========================================================================

test("CONTRACT-4: get_task card uses lifecycle progress, not raw task dump", async () => {
  const task = createDeepTask();
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [task] });

  const res = await rpc(server, "tools/call", {
    name: "get_task",
    arguments: { task_id: "task_deep_1" },
  });

  const card = res.result._meta?.gptwork_card;
  assert.ok(card, "get_task must have card");
  assert.equal(card.card_version, CARD_SCHEMA_VERSION);
  assert.equal(card.card_type, "task_execution", "card type must be task_execution");

  // Card must NOT embed raw task objects or deep logs
  assert.equal(card.logs, undefined, "card must not embed task logs");
  assert.equal(card.task, undefined, "card must not embed full task object");
  assert.equal(card.stdout, undefined, "card must not embed stdout");
  assert.equal(card.stderr, undefined, "card must not embed stderr");

  // Card uses lifecycle progress
  assert.ok(card.identity, "card must have identity");
  assert.equal(card.identity.task_id, "task_deep_1", "card must identify task_id");
  assert.ok(card.progress, "card must have progress lifecycle");
  assert.equal(card.progress.current_stage, "completed", "progress must show current stage");
  assert.ok(Array.isArray(card.progress.stages), "progress must have stages array");

  // Card has bounded sections, not raw data dump
  assert.ok(Array.isArray(card.sections), "card must have sections");
  const acceptSection = card.sections.find(s => s.title === "Acceptance");
  assert.ok(acceptSection, "card must have Acceptance section");
  assert.equal(acceptSection.type, "checklist", "acceptance must be checklist type");

  // modelPayload must not embed full task object
  const sc = res.result.structuredContent;
  assert.equal(sc.task, undefined, "modelPayload must not embed full task object");
  assert.ok(sc.gptwork_tool, "modelPayload must have tool metadata");
  assert.equal(sc.rawAvailable, true, "modelPayload must declare rawAvailable");
});

// =========================================================================
// CONTRACT-5: Deep evidence is gated behind dedicated tools
// =========================================================================

test("CONTRACT-5: deep evidence not embedded in general card payloads", async () => {
  const task = createDeepTask();
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [task] });

  // Standard get_task card must NOT carry full acceptance/evidence
  const getRes = await rpc(server, "tools/call", {
    name: "get_task",
    arguments: { task_id: "task_deep_1" },
  });
  const card = getRes.result._meta?.gptwork_card;
  assert.ok(card, "get_task must have card");

  // Card has acceptance status in key_values or checklist, but NOT full raw data
  assert.equal(card.acceptance_bundle, undefined, "card must not embed acceptance_bundle");
  assert.equal(card.review_packet, undefined, "card must not embed review_packet");
  assert.equal(card.full_acceptance, undefined, "card must not embed full_acceptance");

  // modelPayload must not embed acceptance/review bundles
  const sc = getRes.result.structuredContent;
  assert.equal(sc.acceptance_bundle, undefined, "modelPayload must not embed acceptance_bundle");
  assert.equal(sc.review_packet, undefined, "modelPayload must not embed review_packet");

  // Dedicated deep inspection tools must exist as registered tools
  const toolsRes = await rpc(server, "tools/list", {});
  const toolNames = toolsRes.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("get_task_acceptance_bundle"),
    "get_task_acceptance_bundle dedicated tool must be registered");
  assert.ok(toolNames.includes("get_task_review_packet"),
    "get_task_review_packet dedicated tool must be registered");
});

// =========================================================================
// CONTRACT-6: All card-enabled tools produce bounded cards under 50 KB
// =========================================================================

test("CONTRACT-6: all card-enabled tools produce bounded cards under 50 KB", async () => {
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const toolsUnderTest = [
    "runtime_status",
    "worker_status",
    "gptwork_doctor",
    "gptwork_self_test",
    "list_goals",
    "list_tasks",
    "get_task",
    "read_handoff",
    "show_changes",
  ];

  for (const toolName of toolsUnderTest) {
    const args = toolName === "get_task"
      ? { task_id: "task_deep_1" }
      : {};

    const res = await rpc(server, "tools/call", { name: toolName, arguments: args });

    if (res.error) {
      assert.ok(toolName === "get_task", `unexpected error for ${toolName}: ${res.error.message}`);
      continue;
    }

    const card = res.result._meta?.gptwork_card || res.result.structuredContent?.card;
    if (!card) continue;

    const cardSize = JSON.stringify(card).length;
    assert.ok(cardSize < 51200,
      `${toolName} card size ${cardSize} bytes must be < 50 KB`);

    assert.ok(card.card_version, `${toolName} card must have card_version`);
    assert.equal(card.card_version, CARD_SCHEMA_VERSION,
      `${toolName} card must use ${CARD_SCHEMA_VERSION}`);
    assert.ok(card.card_type, `${toolName} card must have card_type`);
  }
});

// =========================================================================
// CONTRACT-7: Tool result metadata uses correct v5 URI and schema
// =========================================================================

test("CONTRACT-7: tool result _meta uses v5 card URI with distinct schema version", async () => {
  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const res = await rpc(server, "tools/call", { name: "runtime_status", arguments: {} });

  // _meta references the v5 widget URI
  assert.equal(res.result._meta?.resourceUri, TOOL_CARD_URI,
    "_meta.resourceUri must reference v5 card URI");

  // _meta has gptwork_card with card schema version (gptwork-card-v1)
  const card = res.result._meta?.gptwork_card;
  assert.ok(card, "_meta must have gptwork_card");
  assert.equal(card.card_version, CARD_SCHEMA_VERSION,
    "card schema version must be gptwork-card-v1");

  // Widget version and card schema version are distinct
  assert.notEqual(TOOL_CARD_URI, CARD_SCHEMA_VERSION,
    "widget URI version (v5.html) and card schema version (v1) must be different identifiers");
  assert.equal(card.__widget_uri, undefined,
    "card must not conflate widget URI with card schema version");

  // backward compat card in structuredContent has same version
  const bcCard = res.result.structuredContent?.card;
  if (card && bcCard) {
    assert.equal(card.card_version, bcCard.card_version,
      "backward compat card must share card_version with _meta card");
    assert.equal(card.card_type, bcCard.card_type,
      "backward compat card must share card_type with _meta card");
  }
});

// =========================================================================
// CONTRACT-8: All deep-task fields forbidden in every card
// =========================================================================

test("CONTRACT-8: forbidden deep-data fields absent from all card payloads", async () => {
  const forbiddenDeepFields = [
    "logs", "task", "tasks", "result", "acceptance",
    "evidence", "stdout", "stderr", "explicit_evidence",
    "acceptance_bundle", "review_packet", "full_acceptance",
    "raw_acceptance", "deep_evidence", "debug_data",
  ];

  const server = await makeServer({ toolMode: "standard" });
  await seedState(server, { tasks: [createDeepTask()] });

  const toolsUnderTest = [
    "runtime_status", "worker_status", "gptwork_doctor", "gptwork_self_test",
    "list_goals", "list_tasks", "get_task", "read_handoff", "show_changes",
  ];

  for (const toolName of toolsUnderTest) {
    const args = toolName === "get_task" ? { task_id: "task_deep_1" } : {};
    const res = await rpc(server, "tools/call", { name: toolName, arguments: args });
    if (res.error) continue;

    const card = res.result._meta?.gptwork_card || res.result.structuredContent?.card;
    if (!card) continue;

    for (const field of forbiddenDeepFields) {
      assert.equal(card[field], undefined,
        `${toolName} card must not contain '${field}'`);
    }
  }
});
