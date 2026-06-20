import { spawn } from "node:child_process";

export function buildSshExecCommand(workspace, command, cwd = ".") {
  const safeCwd = posixNormalize(posixJoin(workspace.root, cwd || "."));
  if (!safeCwd.startsWith(posixNormalize(workspace.root))) {
    throw new Error("SSH cwd is outside workspace root");
  }
  return {
    file: "ssh",
    args: [...buildSshBaseArgs(workspace), "cd " + shellQuotee(safeCwd) + " && " + command]
  };
}

export function buildSshBaseArgs(workspace) {
  const port = String(workspace.port || 22);
  const userHost = workspace.user ? `${workspace.user}@${workspace.host}` : workspace.host;
  const identityFile = workspace.identity_file || process.env.GPTWORK_SSH_IDENTITY_FILE || "";
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "PreferredAuthentications=publickey",
    "-o", "PasswordAuthentication=no"
  ];
  if (identityFile) args.push("-i", identityFile);
  if (shouldUseSocksProxy(workspace.host)) {
    const socksProxy = workspace.socks_proxy || process.env.GPTWORK_SSH_SOCKS_PROXY || "10.0.1.105:20177";
    args.push("-o", `ProxyCommand=nc -x ${socksProxy} %h %p`);
  }
  args.push("-p", port, userHost);
  return args;
}

export async function runSshExec(workspace, command, cwd = ".", timeout = 60, maxOutputBytes = 200000) {
  const built = buildSshExecCommand(workspace, command, cwd);
  return runCommand(built.file, built.args, timeout, maxOutputBytes);
}

export async function sshListDir(workspace, sshPath = ".", timeout = 15) {
  return runSshExec(workspace, "ls -la " + shellQuotee(sshPath), ".", timeout, 50000);
}

export async function sshReadTextFile(workspace, sshPath, timeout = 15) {
  return runSshExec(workspace, "cat " + shellQuotee(sshPath), ".", timeout, 200000);
}

export async function sshDownloadBase64(workspace, sshPath, timeout = 30) {
  return runSshExec(workspace, "base64 -w0 " + shellQuotee(sshPath), ".", timeout, 500000);
}

export async function sshWriteTextFile(workspace, sshPath, content, timeout = 30) {
  const safeDir = posixDirname(sshPath);
  const ensureDir = "mkdir -p " + shellQuotee(safeDir);
  await runSshExec(workspace, ensureDir, ".", 10, 1000);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("ssh", [...buildSshBaseArgs(workspace), "cat > " + shellQuotee(sshPath)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ ok: false, error: error.message, duration_ms: Date.now() - started }));
    child.on("close", (code) => {
      if (code !== 0) resolve({ ok: false, error: stderr || "exit code " + code, duration_ms: Date.now() - started });
      else resolve({ ok: true, path: sshPath, duration_ms: Date.now() - started });
    });
    child.stdin.write(Buffer.from(content, "utf8"));
    child.stdin.end();
  });
}

export async function sshUploadBase64(workspace, sshPath, base64Content, timeout = 60) {
  const safeDir = posixDirname(sshPath);
  const ensureDir = "mkdir -p " + shellQuotee(safeDir);
  await runSshExec(workspace, ensureDir, ".", 10, 1000);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("ssh", [...buildSshBaseArgs(workspace), "base64 -d > " + shellQuotee(sshPath)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ ok: false, error: error.message, duration_ms: Date.now() - started }));
    child.on("close", (code) => {
      if (code !== 0) resolve({ ok: false, error: stderr || "exit code " + code, duration_ms: Date.now() - started });
      else resolve({ ok: true, path: sshPath, duration_ms: Date.now() - started });
    });
    child.stdin.write(Buffer.from(base64Content, "base64"));
    child.stdin.end();
  });
}

export async function sshMkdir(workspace, sshPath, timeout = 10) {
  return runSshExec(workspace, "mkdir -p " + shellQuotee(sshPath), ".", timeout, 1000);
}

export async function sshDelete(workspace, sshPath, recursive = false, timeout = 15) {
  return runSshExec(workspace, "rm " + (recursive ? "-rf " : "-f ") + shellQuotee(sshPath), ".", timeout, 1000);
}

export async function sshMove(workspace, src, dst, timeout = 15) {
  return runSshExec(workspace, "mv " + shellQuotee(src) + " " + shellQuotee(dst), ".", timeout, 1000);
}

export async function sshCopy(workspace, src, dst, timeout = 30) {
  return runSshExec(workspace, "cp -r " + shellQuotee(src) + " " + shellQuotee(dst), ".", timeout, 1000);
}

export async function sshSha256(workspace, sshPath, timeout = 15) {
  const result = await runSshExec(workspace, "sha256sum " + shellQuotee(sshPath), ".", timeout, 5000);
  if (result.returncode !== 0) throw new Error("SSH sha256 failed: " + result.stderr);
  const hash = result.stdout.trim().split(/\s+/)[0];
  if (!hash || hash.length !== 64) throw new Error("SSH sha256: unexpected output");
  return hash;
}

export async function sshStat(workspace, sshPath, timeout = 10) {
  const result = await runSshExec(workspace, "stat --format='%F|%s|%Y' " + shellQuotee(sshPath) + " 2>/dev/null || stat -f '%HT|%z|%m' " + shellQuotee(sshPath) + " 2>/dev/null", ".", timeout, 5000);
  if (result.returncode !== 0) throw new Error("SSH stat failed: " + result.stderr);
  const parts = result.stdout.trim().split("|");
  const isDir = parts[0]?.toLowerCase().includes("directory") || parts[0]?.toLowerCase().includes("dir");
  return { path: sshPath, type: isDir ? "directory" : "file", size: Number(parts[1]) || 0, modified_at: parts[2] ? new Date(Number(parts[2]) * 1000).toISOString() : new Date().toISOString() };
}

export async function sshSearchFiles(workspace, query, sshBasePath = ".", timeout = 60, limit = 50, options = {}) {
  const maxFileBytes = Math.max(0, Number(options.maxFileBytes) || 1024 * 1024);
  const maxTotalBytes = Math.max(0, Number(options.maxTotalBytes) || 10 * 1024 * 1024);
  const excludedNames = new Set((options.excludeDirs || []).map(String).filter((name) => !name.includes("/")));
  const prune = [...excludedNames].map((name) => " -name " + shellQuotee(name)).join(" -o");
  const pruneExpr = prune ? "\\( " + prune + " \\) -prune -o " : "";
  const command = "find " + shellQuotee(sshBasePath) + " " + pruneExpr + "-type f -size -" + (maxFileBytes + 1) + "c -print0 2>/dev/null | "
    + "xargs -0 grep -I -l -m1 " + shellQuotee(query) + " 2>/dev/null | head -" + limit;
  return runSshExec(workspace, command, ".", timeout, Math.min(maxTotalBytes, 50000));
}

function posixNormalize(p) {
  const abs = String(p).startsWith("/");
  const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
  return (abs ? "/" : "") + parts.join("/") || ".";
}

function posixJoin(...parts) {
  return parts.map((p) => String(p).replace(/\\/g, "/")).join("/").replace(/\/+/g, "/");
}

function posixDirname(p) {
  const normalized = posixNormalize(p);
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "/";
}

function shouldUseSocksProxy(host) {
  return !/^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(String(host || ""));
}

function shellQuotee(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function runCommand(file, args, timeout, maxOutputBytes) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const started = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.max(1, timeout) * 1000);
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]).subarray(0, maxOutputBytes); });
    child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, maxOutputBytes); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ command: file + " " + args.join(" "), returncode: 127, stdout: "", stderr: error.message, timed_out: false, duration_ms: Date.now() - started }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ command: file + " " + args.join(" "), returncode: timedOut ? 124 : code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timed_out: timedOut, duration_ms: Date.now() - started }); });
  });
}
