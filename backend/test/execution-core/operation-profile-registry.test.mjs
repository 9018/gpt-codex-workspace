import test from "node:test";
import assert from "node:assert/strict";

import {
  getProfile,
  hasProfile,
  listProfiles,
  getProfileRequirements,
} from "../../src/execution-core/operation-profile-registry.mjs";

test("hasProfile returns true for known kinds", () => {
  assert.ok(hasProfile("code_change"));
  assert.ok(hasProfile("docs_change"));
  assert.ok(hasProfile("test_only"));
  assert.ok(hasProfile("question"));
  assert.ok(hasProfile("code_review"));
  assert.ok(hasProfile("planning"));
});

test("hasProfile returns false for unknown kinds", () => {
  assert.equal(hasProfile("unknown"), false);
});

test("getProfile returns profile for known kind", () => {
  const profile = getProfile("test_only");
  assert.ok(profile);
  assert.equal(profile.operationKind, "test_only");
  assert.equal(profile.requiresCommit, false);
  assert.equal(profile.requiresIntegration, false);
  assert.equal(profile.requiresWorktree, false);
  assert.equal(profile.allowsMutation, false);
});

test("getProfile returns undefined for unknown kind", () => {
  assert.equal(getProfile("unknown"), undefined);
});

test("code_change requires commit and integration", () => {
  const profile = getProfile("code_change");
  assert.equal(profile.requiresCommit, true);
  assert.equal(profile.requiresIntegration, true);
  assert.equal(profile.requiresWorktree, true);
  assert.ok(profile.requiredEvidence.includes("commit_sha"));
  assert.ok(profile.requiredEvidence.includes("changed_files"));
});

test("docs_change does not require integration", () => {
  const profile = getProfile("docs_change");
  assert.equal(profile.requiresCommit, true);
  assert.equal(profile.requiresIntegration, false);
  assert.ok(profile.forbiddenStates.includes("waiting_for_integration"));
});

test("listProfiles returns all registered profiles", () => {
  const profiles = listProfiles();
  assert.ok(profiles.includes("code_change"));
  assert.ok(profiles.includes("test_only"));
  assert.ok(profiles.includes("question"));
  assert.ok(profiles.includes("planning"));
  assert.ok(profiles.length >= 6);
});

test("getProfileRequirements returns structured requirements", () => {
  const reqs = getProfileRequirements("code_change");
  assert.equal(reqs.requires_commit, true);
  assert.equal(reqs.requires_integration, true);
  assert.equal(reqs.requires_worktree, true);
  assert.ok(reqs.required_evidence.includes("commit_sha"));
});

test("getProfileRequirements returns null for unknown kind", () => {
  assert.equal(getProfileRequirements("unknown"), null);
});

test("profiles are immutable copies", () => {
  const profile = getProfile("test_only");
  profile.requiresCommit = true; // mutate
  const profile2 = getProfile("test_only");
  assert.equal(profile2.requiresCommit, false, "original should not be mutated");
});
