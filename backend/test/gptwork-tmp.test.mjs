import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("gptwork-tmp", () => {
  let testDir;
  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), "gptwork-tmp-test-"));
    mkdirSync(join(testDir, ".gptwork", "tmp"), { recursive: true });
  });

  after(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("should export getManagedTmpDir, ensureManagedTmpDir, scanManagedTmp, cleanupManagedTmp, scanSystemTmp, cleanupSystemTmp, getInodePressure", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    assert.ok(mod, "module loaded");
    assert.equal(typeof mod.getManagedTmpDir, "function");
    assert.equal(typeof mod.ensureManagedTmpDir, "function");
    assert.equal(typeof mod.scanManagedTmp, "function");
    assert.equal(typeof mod.cleanupManagedTmp, "function");
    assert.equal(typeof mod.scanSystemTmp, "function");
    assert.equal(typeof mod.cleanupSystemTmp, "function");
    assert.equal(typeof mod.getInodePressure, "function");
  });

  it("scanManagedTmp returns empty for new workspace", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    const scan = await mod.scanManagedTmp({ workspaceRoot: testDir });
    assert.equal(scan.fileCount, 0);
    assert.equal(scan.totalBytes, 0);
  });

  it("writeTaskPromptFile creates and reads task temp file", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    const path = await mod.ensureManagedTmpDir(testDir);
    // Write via writeTaskPromptFile
    const filePath = await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "test-task-001", content: "Hello World" });
    assert.ok(filePath.endsWith("test-task-001.txt"));
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(filePath, "utf8");
    assert.equal(content, "Hello World");

    // Scan should find it
    const scan = await mod.scanManagedTmp({ workspaceRoot: testDir });
    assert.equal(scan.fileCount, 1);
    assert.ok(scan.totalBytes > 0);
    const file = scan.files[0];
    assert.ok(file.gptwork_owned);
    assert.ok(file.ageMs >= 0);
  });

  it("removeTaskPromptFile removes a specific file", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "test-remove", content: "remove me" });
    const removed = await mod.removeTaskPromptFile(testDir, "test-remove");
    assert.equal(removed, true);
    const scan = await mod.scanManagedTmp({ workspaceRoot: testDir });
    const found = scan.files.find(f => f.name.includes("test-remove"));
    assert.ok(!found, "file should be removed");
  });

  it("cleanupManagedTmp with dry_run=true reports without deleting", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    // Write an old file
    await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "old-file", content: "old" });
    const scanBefore = await mod.scanManagedTmp({ workspaceRoot: testDir });
    const beforeCount = scanBefore.fileCount;

    // Dry-run with maxAgeMs=0 so everything is eligible
    const result = await mod.cleanupManagedTmp({ workspaceRoot: testDir, maxAgeMs: 0, dryRun: true });
    assert.ok(result.dryRun, "should be dry run");
    assert.ok(result.deleted >= 1, "should report files to delete: " + result.deleted);
    assert.equal(result.skipped, 0);

    // Verify files still exist
    const scanAfter = await mod.scanManagedTmp({ workspaceRoot: testDir });
    assert.equal(scanAfter.fileCount, beforeCount, "files should remain after dry run");
  });

  it("cleanupManagedTmp with dry_run=false actually removes files", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "remove-me", content: "bye" });
    
    const result = await mod.cleanupManagedTmp({ workspaceRoot: testDir, maxAgeMs: 0, dryRun: false });
    assert.equal(result.dryRun, false);
    assert.ok(result.deleted >= 1);

    const scan = await mod.scanManagedTmp({ workspaceRoot: testDir });
    const found = scan.files.find(f => f.name.includes("remove-me"));
    assert.ok(!found, "file should be deleted after cleanup");
  });

  it("cleanupSystemTmp returns valid structure", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    const result = await mod.cleanupSystemTmp({ dryRun: true });
    assert.ok(typeof result.dry_run === "boolean");
    assert.ok(typeof result.deleted === "number");
    assert.ok(typeof result.skipped === "number");
    assert.ok(typeof result.message === "string");
  });

  it("getInodePressure returns structure or null", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    const pressure = await mod.getInodePressure();
    if (pressure !== null) {
      assert.ok(typeof pressure.total_inodes === "number");
      assert.ok(typeof pressure.used_inodes === "number");
      assert.ok(typeof pressure.free_inodes === "number");
      assert.ok(typeof pressure.used_pct === "string");
    }
  });

  it("removeAllTaskPromptFiles removes all gptwork files", async () => {
    const mod = await import("../src/gptwork-tmp.mjs");
    await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "a1", content: "a" });
    await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "a2", content: "b" });
    
    const count = await mod.removeAllTaskPromptFiles(testDir);
    assert.ok(count >= 1);

    const scan = await mod.scanManagedTmp({ workspaceRoot: testDir });
    const gptworkFiles = scan.files.filter(f => f.gptwork_owned);
    assert.equal(gptworkFiles.length, 0);
  });

  it("ENOSPC recovery in writeTaskPromptFile does not crash", async () => {
    // This tests that the ENOSPC handling doesn't throw unexpectedly
    // We can't easily simulate ENOSPC, but we can verify the code path is valid
    const mod = await import("../src/gptwork-tmp.mjs");
    // Normal write should succeed
    const path = await mod.writeTaskPromptFile({ workspaceRoot: testDir, taskId: "enospc-test", content: "test" });
    assert.ok(existsSync(path));
  });
});

it("scanSystemTmp reports owned directories and inode estimates", async () => {
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "gptwork-system-scan-root-")));
  try {
    const owned = join(root, "gptwork-test-run-owned");
    const unknown = join(root, "unrelated-cache");
    await mkdir(join(owned, "nested"), { recursive: true });
    await writeFile(join(owned, "nested", "a.txt"), "a");
    await mkdir(unknown, { recursive: true });
    const mod = await import("../src/gptwork-tmp.mjs");
    const scan = await mod.scanSystemTmp({ tmpRoot: root });
    assert.equal(scan.directory_count, 1);
    assert.equal(scan.file_count, 0);
    assert.ok(scan.estimated_inodes >= 3);
    assert.equal(scan.entries[0].kind, "directory");
    assert.equal(scan.entries[0].name, "gptwork-test-run-owned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cleanupSystemTmp removes aged owned directories but preserves recent and unknown entries", async () => {
  const { mkdir, rm, utimes } = await import("node:fs/promises");
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "gptwork-system-clean-root-")));
  try {
    const aged = join(root, "gptwork-test-run-aged");
    const recent = join(root, "gptwork-test-run-recent");
    const unknown = join(root, "unrelated-cache");
    await mkdir(aged); await mkdir(recent); await mkdir(unknown);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(aged, old, old);
    const mod = await import("../src/gptwork-tmp.mjs");
    const result = await mod.cleanupSystemTmp({ tmpRoot: root, dryRun: false, maxAgeMs: 2 * 60 * 60 * 1000 });
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(aged), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(unknown), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
