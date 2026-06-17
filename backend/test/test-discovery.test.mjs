import test from "node:test";
import assert from "node:assert/strict";
import { globSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression test: node --test with "test/**/*.test.mjs" glob must NOT
// discover test files outside the test/ directory (e.g. in tmp-deploy/).

test("glob pattern test/**/*.test.mjs excludes non-test dir files", () => {
  const root = mkdtempSync(join(tmpdir(), "gptwork-discovery-"));
  try {
    // Create a rogue test file outside test/
    const rogueDir = join(root, "tmp-deploy");
    mkdirSync(rogueDir, { recursive: true });
    writeFileSync(join(rogueDir, "rogue.test.mjs"), "");

    // Create a valid test inside test/
    const testDir = join(root, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "valid.test.mjs"), "");

    // Use fs.globSync (stable in Node 22) to verify what node --test discovers
    const matched = globSync("test/**/*.test.mjs", { cwd: root });

    assert.ok(
      matched.includes("test/valid.test.mjs"),
      "test/valid.test.mjs should be matched: " + JSON.stringify(matched)
    );
    assert.ok(
      !matched.some(f => f.includes("tmp-deploy")),
      "files under tmp-deploy/ should NOT be matched: " + JSON.stringify(matched)
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test("glob test/**/*.test.mjs matches subdirectory tests", () => {
  const root = mkdtempSync(join(tmpdir(), "gptwork-subdir-"));
  try {
    const nestedDir = join(root, "test", "subdir");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "nested.test.mjs"), "");

    const testDir = join(root, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "valid.test.mjs"), "");

    const matched = globSync("test/**/*.test.mjs", { cwd: root });

    assert.ok(
      matched.includes("test/subdir/nested.test.mjs"),
      "nested files should be matched: " + JSON.stringify(matched)
    );
    assert.ok(
      matched.includes("test/valid.test.mjs"),
      "test/valid.test.mjs should also be matched: " + JSON.stringify(matched)
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
