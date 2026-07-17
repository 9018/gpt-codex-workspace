import test from "node:test";
import assert from "node:assert/strict";
import { classifyTuiState } from "../src/tui-autopilot/tui-state-classifier.mjs";

test("classifyTuiState prioritizes confirmation and choice prompts", () => {
  assert.equal(classifyTuiState({ confirmation_markers: ["allow_command"] }).state, "awaiting_confirmation");
  assert.equal(classifyTuiState({ selectable_options: [{ index: 1 }] }).state, "awaiting_choice");
});

test("classifyTuiState recognizes progress, prompt return, and bounded uncertainty", () => {
  assert.equal(classifyTuiState({ progress_markers: ["working"] }).state, "executing");
  assert.equal(classifyTuiState({ prompt_markers: ["codex_prompt"] }).state, "ready_for_instruction");
  assert.equal(classifyTuiState({ normalized_text: "ambiguous screen" }).state, "unclassified");
});
