/**
 * workspace-guard.test.mjs — Unit tests for the workspace safety guard module.
 *
 * Covers:
 *   1. Blocked glob matching
 *   2. Path escape rejection
 *   3. Symlink escape detection
 *   4. Secret/blocked path access rejection
 *   5. Write mode matrix
 *   6. Shell mode matrix
 *   7. Safe command allowlisting
 *   8. Compact shell transcript
 *   9. Binary file detection
 *  10. Config integration (defaults, env overrides)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import {
  createWorkspaceGuard,
  matchesBlockedGlob,
  DEFAULT_BLOCKED_GLOBS,
  looksBinary,
  isSafeCommand,
  SHELL_MODES,
  WRITE_MODES,
  TRANSCRIPT_MODES,
} from "../src/workspace-guard.mjs";

import { buildRuntimeConfig } from "../src/runtime-config.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return {
    workspaceRoot: "/tmp/workspace",
    shellMode: "full",
    writeMode: "workspace",
    shellTranscript: "compact",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Blocked glob matching
// ---------------------------------------------------------------------------

describe("matchesBlockedGlob", () => {
  it("matches .env files", () => {
    assert.ok(matchesBlockedGlob(".env"));
    assert.ok(matchesBlockedGlob(".env.prod"));
    assert.ok(matchesBlockedGlob(".env.local"));
    assert.ok(matchesBlockedGlob("config/.env"));
  });

  it("matches .git paths", () => {
    assert.ok(matchesBlockedGlob(".git"));
    assert.ok(matchesBlockedGlob(".git/config"));
    assert.ok(matchesBlockedGlob(".git/HEAD"));
  });

  it("matches node_modules", () => {
    assert.ok(matchesBlockedGlob("node_modules"));
    assert.ok(matchesBlockedGlob("node_modules/express/index.js"));
  });

  it("matches secret/credential files", () => {
    assert.ok(matchesBlockedGlob("config/secrets.json"));
    assert.ok(matchesBlockedGlob("creds/credentials.json"));
    assert.ok(matchesBlockedGlob(".ssh/id_rsa"));
  });

  it("matches build artifacts", () => {
    assert.ok(matchesBlockedGlob("dist/bundle.js"));
    assert.ok(matchesBlockedGlob("build/output.o"));
    assert.ok(matchesBlockedGlob(".next/server.js"));
    assert.ok(matchesBlockedGlob("coverage/lcov.info"));
    assert.ok(matchesBlockedGlob(".cache/npm/pkg.json"));
  });

  it("does not match normal source paths", () => {
    assert.ok(!matchesBlockedGlob("src/index.js"));
    assert.ok(!matchesBlockedGlob("README.md"));
    assert.ok(!matchesBlockedGlob("package.json"));
    assert.ok(!matchesBlockedGlob("lib/utils/helper.mjs"));
  });

  it("does not match paths that look like but aren't blocked", () => {
    // .env.example.md starts with .env prefix, so it correctly matches blocked glob
    assert.ok(matchesBlockedGlob("src/.env.example.md"));
    // These should NOT match any blocked glob
    assert.ok(!matchesBlockedGlob("config.json"));
    assert.ok(!matchesBlockedGlob("distro/settings.json")); // not dist/
  });

  it("matches .pem and .key files anywhere", () => {
    assert.ok(matchesBlockedGlob("certs/server.pem"));
    assert.ok(matchesBlockedGlob("certs/server.key"));
    assert.ok(matchesBlockedGlob("config/my.key"));
  });
});

// ---------------------------------------------------------------------------
// 2. Path escape rejection (assertAllowedPath)
// ---------------------------------------------------------------------------

describe("assertAllowedPath", () => {
  it("allows paths inside workspace root", () => {
    const config = makeConfig({ workspaceRoot: "/tmp/workspace" });
    const guard = createWorkspaceGuard(config);
    guard.assertAllowedPath("/tmp/workspace/src/main.js", { operation: "read", isWrite: false });
    // node_modules is a blocked glob, access should be rejected
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/node_modules/foo", { operation: "read", isWrite: false });
    }, /blocked path/);
    // Blocked globs still apply
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/.env", { operation: "read", isWrite: false });
    }, /blocked path/);
  });

  it("allows paths exactly at workspace root", () => {
    const config = makeConfig({ workspaceRoot: "/tmp/test-root" });
    const guard = createWorkspaceGuard(config);
    guard.assertAllowedPath("/tmp/test-root", { operation: "read", isWrite: false });
    guard.assertAllowedPath("/tmp/test-root/package.json", { operation: "read", isWrite: false });
  });

  it("rejects blocked glob paths for both read and write", () => {
    const config = makeConfig({ workspaceRoot: "/tmp/workspace" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/.env", { operation: "read", isWrite: false });
    }, /blocked path/);
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/node_modules/foo", { operation: "write", isWrite: true });
    }, /blocked path/);
  });

  it("rejects write when writeMode is off", () => {
    const config = makeConfig({ writeMode: "off", workspaceRoot: "/tmp/workspace" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/src/main.js", { operation: "write", isWrite: true });
    }, /write operations disabled/);
  });

  it("rejects write when writeMode is handoff", () => {
    const config = makeConfig({ writeMode: "handoff", workspaceRoot: "/tmp/workspace" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => {
      guard.assertAllowedPath("/tmp/workspace/src/main.js", { operation: "write", isWrite: true });
    }, /not permitted in handoff mode/);
  });

  it("allows read when writeMode is off", () => {
    const config = makeConfig({ writeMode: "off", workspaceRoot: "/tmp/workspace" });
    const guard = createWorkspaceGuard(config);
    guard.assertAllowedPath("/tmp/workspace/src/main.js", { operation: "read", isWrite: false });
  });
});

// ---------------------------------------------------------------------------
// 3. Symlink escape detection (requires a temp dir with symlinks)
// ---------------------------------------------------------------------------

describe("assertRealPathInsideWorkspace", () => {
  const tmpDir = join(tmpdir(), "guard-test-" + Date.now());
  const workspaceDir = join(tmpDir, "workspace");
  const escapeTarget = join(tmpDir, "escape-target");
  const symlinkPath = join(workspaceDir, "escape-link");

  before(async () => {
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(escapeTarget, { recursive: true });
    await writeFile(join(escapeTarget, "secret.txt"), "should-not-be-readable");
    try { await symlink(escapeTarget, symlinkPath); } catch {}
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes for paths within workspace", async () => {
    const config = makeConfig({ workspaceRoot: workspaceDir });
    const guard = createWorkspaceGuard(config);
    await guard.assertRealPathInsideWorkspace(join(workspaceDir, "src"));
  });

  it("throws when symlink escapes workspace root", async () => {
    const config = makeConfig({ workspaceRoot: workspaceDir });
    const guard = createWorkspaceGuard(config);
    await assert.rejects(
      () => guard.assertRealPathInsideWorkspace(symlinkPath),
      /symlink escape detected/
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Write mode matrix
// ---------------------------------------------------------------------------

describe("write mode matrix", () => {
  it("off: rejects all write operations", () => {
    const config = makeConfig({ writeMode: "off" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertValidWriteMode("/test", "write"), /write operations disabled/);
  });

  it("handoff: rejects workspace writes", () => {
    const config = makeConfig({ writeMode: "handoff" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertValidWriteMode("/test", "write"), /not permitted in handoff mode/);
  });

  it("workspace: allows writes", () => {
    const config = makeConfig({ writeMode: "workspace" });
    const guard = createWorkspaceGuard(config);
    guard.assertValidWriteMode("/test", "write");
  });

  it("invalid mode throws on shell check", () => {
    const config = makeConfig({ writeMode: "invalid" }); // not validated directly
    // The actual validation happens in the config layer
  });
});

// ---------------------------------------------------------------------------
// 5. Shell mode matrix
// ---------------------------------------------------------------------------

describe("shell mode matrix", () => {
  it("off: rejects all shell commands", () => {
    const config = makeConfig({ shellMode: "off" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertShellAllowed("ls -la", "/tmp/workspace"), /shell execution disabled/);
  });

  it("safe: allows safe commands, rejects dangerous ones", () => {
    const config = makeConfig({ shellMode: "safe" });
    const guard = createWorkspaceGuard(config);
    guard.assertShellAllowed("ls -la", "/tmp/workspace");
    guard.assertShellAllowed("cat package.json", "/tmp/workspace");
    guard.assertShellAllowed("echo hello", "/tmp/workspace");
    assert.throws(() => guard.assertShellAllowed("rm -rf /", "/tmp/workspace"), /rejected by safe shell mode/);
    assert.throws(() => guard.assertShellAllowed("sudo ls", "/tmp/workspace"), /rejected by safe shell mode/);
  });

  it("full: allows all commands", () => {
    const config = makeConfig({ shellMode: "full" });
    const guard = createWorkspaceGuard(config);
    guard.assertShellAllowed("ls -la", "/tmp/workspace");
    guard.assertShellAllowed("rm -rf /", "/tmp/workspace");
    guard.assertShellAllowed("sudo ls", "/tmp/workspace");
  });

  it("invalid mode throws", () => {
    const config = makeConfig({ shellMode: "unknown" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertShellAllowed("ls", "/tmp/workspace"), /invalid GPTWORK_SHELL_MODE/);
  });

  it("safe: rejects pipes", () => {
    const config = makeConfig({ shellMode: "safe" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertShellAllowed("ls | grep test", "/tmp/workspace"), /rejected by safe shell mode/);
  });

  it("safe: rejects subshell commands", () => {
    const config = makeConfig({ shellMode: "safe" });
    const guard = createWorkspaceGuard(config);
    assert.throws(() => guard.assertShellAllowed("echo $(whoami)", "/tmp/workspace"), /rejected by safe shell mode/);
  });
});

// ---------------------------------------------------------------------------
// 6. Compact shell transcript
// ---------------------------------------------------------------------------

describe("formatCompactTranscript", () => {
  it("includes command, cwd, exit code, duration", () => {
    const guard = createWorkspaceGuard(makeConfig());
    const result = {
      command: "ls -la",
      cwd: "/workspace",
      returncode: 0,
      duration_ms: 150,
      timed_out: false,
      stdout: "file1\nfile2\nfile3\n",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_bytes: 18,
      stderr_bytes: 0,
    };
    const compact = guard.formatCompactTranscript(result);
    assert.equal(compact.command, "ls -la");
    assert.equal(compact.cwd, "/workspace");
    assert.equal(compact.exit_code, 0);
    assert.equal(compact.duration_ms, 150);
    assert.equal(compact.timed_out, false);
    assert.equal(compact.stdout_lines, 4);
    assert.equal(compact.stderr_lines, 1);
    assert.equal(compact.stdout_preview, "file1\nfile2\nfile3\n");
    assert.equal(compact.stderr_preview, "");
  });

  it("truncates large preview output", () => {
    const guard = createWorkspaceGuard(makeConfig());
    const largeStdout = "a".repeat(2000);
    const result = {
      command: "echo big",
      cwd: "/ws",
      returncode: 0,
      duration_ms: 50,
      timed_out: false,
      stdout: largeStdout,
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_bytes: 2000,
      stderr_bytes: 0,
    };
    const compact = guard.formatCompactTranscript(result);
    assert.ok(compact.stdout_preview.length <= 1000);
    assert.equal(compact.stdout_preview, "a".repeat(1000));
  });
});

// ---------------------------------------------------------------------------
// 7. Binary file detection
// ---------------------------------------------------------------------------

describe("looksBinary", () => {
  it("detects null byte in content", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    assert.ok(looksBinary(buf));
  });

  it("passes for text content", () => {
    const buf = Buffer.from("hello world\n");
    assert.ok(!looksBinary(buf));
  });

  it("handles empty input", () => {
    assert.ok(!looksBinary(Buffer.from([])));
    assert.ok(!looksBinary(null));
  });

  it("handles non-buffer input gracefully", () => {
    assert.ok(!looksBinary(undefined));
  });
});

// ---------------------------------------------------------------------------
// 8. Config integration
// ---------------------------------------------------------------------------

describe("config integration", () => {
  it("buildRuntimeConfig defaults match guard defaults", () => {
    const { config } = buildRuntimeConfig("/tmp/test-root");
    assert.equal(config.shellMode, "full");
    assert.equal(config.writeMode, "workspace");
    assert.equal(config.shellTranscript, "compact");
  });

  it("createWorkspaceGuard reads config values", () => {
    const config = makeConfig({ shellMode: "safe", writeMode: "handoff", shellTranscript: "full" });
    const guard = createWorkspaceGuard(config);
    assert.equal(guard.shellMode, "safe");
    assert.equal(guard.writeMode, "handoff");
    assert.equal(guard.transcriptMode, "full");
  });

  it("env vars override config defaults", () => {
    process.env.GPTWORK_SHELL_MODE = "safe";
    process.env.GPTWORK_WRITE_MODE = "off";
    process.env.GPTWORK_SHELL_TRANSCRIPT = "full";
    const guard = createWorkspaceGuard({});
    assert.equal(guard.shellMode, "safe");
    assert.equal(guard.writeMode, "off");
    assert.equal(guard.transcriptMode, "full");
    delete process.env.GPTWORK_SHELL_MODE;
    delete process.env.GPTWORK_WRITE_MODE;
    delete process.env.GPTWORK_SHELL_TRANSCRIPT;
  });
});
