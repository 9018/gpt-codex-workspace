import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileRoleView,
  getCanonicalRoles,
  getAdvisoryRoles,
} from "../src/subagents/role-view-compiler.mjs";

describe("compileRoleView", () => {
  it("produces builder view with write access", () => {
    const view = compileRoleView({
      role: "builder",
      taskContextDigest: "sha256:abc",
      sources: {
        objective: "Fix bug",
        scope: { include: ["src/"], exclude: [] },
        acceptance_criteria: [{ id: "a1", description: "pass", blocking: true }],
      },
    });

    assert.equal(view.role, "builder");
    assert.equal(view.role_kind, "canonical");
    assert.equal(view.permissions.write_product_code, true);
    assert.equal(view.included_sections.includes("objective"), true);
  });

  it("produces reviewer view without write access", () => {
    const view = compileRoleView({ role: "reviewer", taskContextDigest: "sha256:abc", sources: { machine_blockers: [], change_summary: "diff", verification: { passed: true } } });
    assert.equal(view.permissions.write_product_code, false);
    assert.equal(view.included_sections.includes("machine_blockers"), true);
  });

  it("produces explorer advisory view", () => {
    const view = compileRoleView({ role: "explorer", taskContextDigest: "sha256:abc" });
    assert.equal(view.role_kind, "advisory");
    assert.equal(view.permissions.write_product_code, false);
    assert.equal(view.permissions.run_commands, true);
  });

  it("throws for unknown role", () => {
    assert.throws(() => compileRoleView({ role: "unknown" }), /unknown role/);
  });

  it("always excludes raw transcript and term logs", () => {
    const view = compileRoleView({ role: "planner", taskContextDigest: "sha256:abc" });
    assert.ok(view.excluded_sources.includes("raw_chatgpt_transcript"));
    assert.ok(view.excluded_sources.includes("tui_terminal_log"));
  });
});

describe("role enums", () => {
  it("returns canonical roles including finalizer", () => {
    const roles = getCanonicalRoles();
    assert.ok(roles.includes("planner"));
    assert.ok(roles.includes("builder"));
    assert.ok(roles.includes("verifier"));
    assert.ok(roles.includes("reviewer"));
    assert.ok(roles.includes("finalizer"));
  });

  it("returns advisory roles", () => {
    const roles = getAdvisoryRoles();
    assert.ok(roles.includes("explorer"));
    assert.ok(roles.includes("architect"));
    assert.ok(roles.includes("test_analyst"));
  });
});
