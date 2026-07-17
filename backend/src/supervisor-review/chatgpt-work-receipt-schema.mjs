/**
 * chatgpt-work-receipt-schema.mjs — ChatGPT Work Receipt schema.
 *
 * A structured record of what ChatGPT changed during a takeover.
 * Required before handoff back to Codex.
 *
 * @module supervisor-review/chatgpt-work-receipt-schema
 */

/**
 * Create a ChatGPTWorkReceipt.
 *
 * @param {object} input
 * @param {string} input.run_id
 * @param {string} input.takeover_command_id
 * @param {number} input.controller_epoch
 * @param {string} [input.base_sha]
 * @param {string} [input.final_head_sha]
 * @param {string[]} [input.changed_files]
 * @param {Array<{ command: string, cwd?: string, exit_code: number, output_ref?: string }>} [input.commands]
 * @param {Array<{ name: string, passed: boolean, output?: string }>} [input.tests]
 * @param {string[]} [input.unresolved_findings]
 * @param {string} [input.recommended_next_action]
 * @returns {object} ChatGPTWorkReceipt
 * @throws {Error} On missing required fields
 */
export function createChatGPTWorkReceipt(input = {}) {
  if (!input.run_id) throw new Error("run_id is required");
  if (!input.takeover_command_id) throw new Error("takeover_command_id is required");
  if (input.controller_epoch == null) throw new Error("controller_epoch is required");

  // Validate commands have exit_code
  const commands = (input.commands || []).map((cmd, i) => {
    if (cmd.exit_code == null) {
      throw new Error(`commands[${i}]: exit_code is required`);
    }
    return {
      command: cmd.command || "",
      cwd: cmd.cwd || null,
      exit_code: cmd.exit_code,
      output_ref: cmd.output_ref || null,
    };
  });

  return {
    schema_version: 1,
    id: input.id || `receipt_${input.run_id}_${input.takeover_command_id}`,
    run_id: input.run_id,
    takeover_command_id: input.takeover_command_id,
    controller_epoch: input.controller_epoch,
    base_sha: input.base_sha || null,
    final_head_sha: input.final_head_sha || null,
    changed_files: input.changed_files || [],
    commands,
    tests: input.tests || [],
    unresolved_findings: input.unresolved_findings || [],
    recommended_next_action: input.recommended_next_action || "handoff_to_codex",
    created_at: new Date().toISOString(),
  };
}
