/**
 * acceptance-agent.test.mjs
 * Tests for acceptance-agent.mjs — evidence-based acceptance verification.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hasCodeOrConfigOrRuntimeChanges } from "../src/acceptance-agent.mjs";

// ===========================================================================
// Tests for hasCodeOrConfigOrRuntimeChanges
// ===========================================================================

test("hasCodeOrConfigOrRuntimeChanges: code change files returns true", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "code_change",
      evidence: { changed_files: ["src/server.mjs", "src/worker.mjs"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: noop profile returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "noop",
      evidence: { changed_files: [] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: docs_only profile returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "docs_only",
      evidence: { changed_files: ["docs/readme.md"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: no changed_files returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: [] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: only md files returns false for code_change profile", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "code_change",
      evidence: { changed_files: ["README.md", "CHANGELOG.md"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: config-only files returns false for default profile", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["config.json", "deploy.yaml"] },
    },
  });
  assert.equal(result, false);
});

test("hasCodeOrConfigOrRuntimeChanges: mixed code+docs returns true", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    acceptanceResult: {
      profile: "default",
      evidence: { changed_files: ["src/app.mjs", "docs/guide.md"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: falls back to task.result.changed_files", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({
    task: {
      result: { changed_files: ["src/app.mjs"] },
    },
  });
  assert.equal(result, true);
});

test("hasCodeOrConfigOrRuntimeChanges: no acceptanceResult nor task returns false", async () => {
  const result = hasCodeOrConfigOrRuntimeChanges({});
  assert.equal(result, false);
});

// ===========================================================================
// Test: exports are present
// ===========================================================================

test("acceptance-agent exports expected symbols", async () => {
  const mod = await import("../src/acceptance-agent.mjs");
  assert.equal(typeof mod.runAcceptanceAgent, "function");
  assert.equal(typeof mod.buildEvidence, "function");
  assert.equal(typeof mod.hasCodeOrConfigOrRuntimeChanges, "function");
  assert.ok(mod.ACCEPTANCE_PROFILES);
  assert.equal(mod.ACCEPTANCE_PROFILES.CODE_CHANGE, "code_change");
  assert.equal(mod.ACCEPTANCE_PROFILES.DOCS_ONLY, "docs_only");
  assert.equal(mod.ACCEPTANCE_PROFILES.NOOP, "noop");
});

console.log("acceptance-agent tests loaded");
