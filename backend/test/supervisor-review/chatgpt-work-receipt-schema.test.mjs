/**
 * chatgpt-work-receipt-schema.test.mjs — Tests for ChatGPT Work Receipt
 *
 * @module test/supervisor-review/chatgpt-work-receipt-schema
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createChatGPTWorkReceipt } from "../../src/supervisor-review/chatgpt-work-receipt-schema.mjs";

// ---------------------------------------------------------------------------
// Valid receipt
// ---------------------------------------------------------------------------

test("creates receipt with required fields", () => {
  const receipt = createChatGPTWorkReceipt({
    run_id: "run_1",
    takeover_command_id: "cmd_1",
    controller_epoch: 3,
    base_sha: "abc123",
    final_head_sha: "def456",
    changed_files: ["src/x.mjs"],
    commands: [
      { command: "npm test", cwd: "/home/user/project", exit_code: 0 },
    ],
    tests: [{ name: "unit", passed: true }],
    unresolved_findings: [],
    recommended_next_action: "handoff_to_codex",
  });

  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.run_id, "run_1");
  assert.equal(receipt.takeover_command_id, "cmd_1");
  assert.equal(receipt.controller_epoch, 3);
  assert.equal(receipt.base_sha, "abc123");
  assert.equal(receipt.final_head_sha, "def456");
  assert.deepEqual(receipt.changed_files, ["src/x.mjs"]);
  assert.equal(receipt.commands.length, 1);
  assert.equal(receipt.commands[0].exit_code, 0);
  assert.equal(typeof receipt.created_at, "string");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("requires run_id", () => {
  assert.throws(
    () => createChatGPTWorkReceipt({
      takeover_command_id: "cmd_1",
      controller_epoch: 3,
    }),
    /run_id is required/
  );
});

test("requires takeover_command_id", () => {
  assert.throws(
    () => createChatGPTWorkReceipt({
      run_id: "run_1",
      controller_epoch: 3,
    }),
    /takeover_command_id is required/
  );
});

test("requires controller_epoch", () => {
  assert.throws(
    () => createChatGPTWorkReceipt({
      run_id: "run_1",
      takeover_command_id: "cmd_1",
    }),
    /controller_epoch is required/
  );
});

test("requires commands array with exit_code", () => {
  assert.throws(
    () => createChatGPTWorkReceipt({
      run_id: "run_1",
      takeover_command_id: "cmd_1",
      controller_epoch: 3,
      commands: [{ command: "npm test", exit_code: undefined }],
    }),
    /exit_code/
  );
});

test("defaults recommended_next_action if not provided", () => {
  const receipt = createChatGPTWorkReceipt({
    run_id: "run_1",
    takeover_command_id: "cmd_1",
    controller_epoch: 3,
    commands: [{ command: "npm test", exit_code: 0 }],
  });
  assert.equal(receipt.recommended_next_action, "handoff_to_codex");
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("receipt has all expected sections", () => {
  const receipt = createChatGPTWorkReceipt({
    run_id: "run_1",
    takeover_command_id: "cmd_1",
    controller_epoch: 3,
    commands: [],
  });

  assert.ok(receipt.tests);
  assert.ok(receipt.unresolved_findings);
  assert.ok(Array.isArray(receipt.changed_files));
  assert.equal(typeof receipt.created_at, "string");
});
