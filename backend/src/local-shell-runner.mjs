import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function runLocalShell(command, cwd, timeout, maxOutputBytes, onChildSpawned, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const startedAtIso = new Date(started).toISOString();
    const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
    const shellFlag = process.platform === "win32" ? "/c" : "-c";
    const maxBuf = Number(maxOutputBytes) || 1048576;
    const firstOutputTimeoutSeconds = Math.max(0, Number(options.firstOutputTimeoutSeconds) || 0);
    const contentFirstOutputTimeoutSeconds = Math.max(0, Number(options.contentFirstOutputTimeoutSeconds) || 0);
    const noProgressTimeoutSeconds = Math.max(0, Number(options.noProgressTimeoutSeconds) || 0);
    const onOutput = typeof options.onOutput === "function" ? options.onOutput : null;
    const isContentfulOutput = typeof options.isContentfulOutput === "function" ? options.isContentfulOutput : null;

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: maxBuf
    });

    if (onChildSpawned) {
      onChildSpawned(child.pid);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let firstStdoutAt = null;
    let firstStderrAt = null;
    let firstOutputDelayMs = null;
    let firstOutputTimedOut = false;
    let firstOutputTimer = null;
    let contentFirstOutputAt = null;
    let contentFirstOutputDelayMs = null;
    let lastContentProgressAt = null;
    let lastContentProgressMs = null;
    let contentFirstOutputTimedOut = false;
    let noContentProgressTimedOut = false;
    let contentFirstOutputTimer = null;
    let noProgressTimer = null;
    let settled = false;
    let stdoutLogStream = null;
    let stderrLogStream = null;

    function getLogStream(streamName) {
      const streamPath = streamName === "stdout" ? options.streamStdoutPath : options.streamStderrPath;
      if (!streamPath) return null;
      try {
        if (streamName === "stdout") {
          if (!stdoutLogStream) {
            mkdirSync(dirname(streamPath), { recursive: true });
            stdoutLogStream = createWriteStream(streamPath, { flags: "a" });
            stdoutLogStream.on("error", () => {});
          }
          return stdoutLogStream;
        }
        if (!stderrLogStream) {
          mkdirSync(dirname(streamPath), { recursive: true });
          stderrLogStream = createWriteStream(streamPath, { flags: "a" });
          stderrLogStream.on("error", () => {});
        }
        return stderrLogStream;
      } catch {
        return null;
      }
    }

    function writeLogChunk(streamName, chunk) {
      try {
        getLogStream(streamName)?.write(chunk);
      } catch {}
    }

    function closeLogStreams(done) {
      const streams = [stdoutLogStream, stderrLogStream].filter(Boolean);
      if (!streams.length) { done(); return; }
      let pending = streams.length;
      const finishOne = () => {
        pending -= 1;
        if (pending === 0) done();
      };
      for (const stream of streams) {
        try { stream.end(finishOne); } catch { finishOne(); }
      }
    }

    function terminateProcessGroup() {
      try {
        if (child.pid) process.kill(process.platform !== "win32" ? -child.pid : child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (child.pid) process.kill(process.platform !== "win32" ? -child.pid : child.pid, "SIGKILL");
        } catch {}
      }, 3000);
    }

    function resetNoProgressTimer() {
      if (!noProgressTimeoutSeconds || !contentFirstOutputAt) return;
      if (noProgressTimer) clearTimeout(noProgressTimer);
      noProgressTimer = setTimeout(() => {
        if (!lastContentProgressMs || Date.now() - lastContentProgressMs >= noProgressTimeoutSeconds * 1000) {
          timedOut = true;
          noContentProgressTimedOut = true;
          terminateProcessGroup();
        }
      }, noProgressTimeoutSeconds * 1000);
    }

    function emitOutputEvent() {
      if (!onOutput) return;
      try {
        onOutput({
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          first_stdout_at: firstStdoutAt,
          first_stderr_at: firstStderrAt,
          first_output_delay_ms: firstOutputDelayMs,
          content_first_output_at: contentFirstOutputAt,
          content_first_output_delay_ms: contentFirstOutputDelayMs,
          last_content_progress_at: lastContentProgressAt,
        });
      } catch {}
    }

    function markOutput(streamName, chunk) {
      const bytes = Buffer.byteLength(chunk);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      if (streamName === "stdout") {
        stdoutBytes += bytes;
        if (!firstStdoutAt) firstStdoutAt = nowIso;
      } else {
        stderrBytes += bytes;
        if (!firstStderrAt) firstStderrAt = nowIso;
      }
      if (firstOutputDelayMs === null) {
        firstOutputDelayMs = now - started;
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
      }

      let contentful = false;
      if (isContentfulOutput) {
        try {
          contentful = Boolean(isContentfulOutput({
            streamName,
            chunk,
            stdout_bytes: stdoutBytes,
            stderr_bytes: stderrBytes,
            elapsed_ms: now - started,
          }));
        } catch {
          contentful = false;
        }
      }

      if (contentful) {
        if (!contentFirstOutputAt) {
          contentFirstOutputAt = nowIso;
          contentFirstOutputDelayMs = now - started;
          if (contentFirstOutputTimer) clearTimeout(contentFirstOutputTimer);
        }
        lastContentProgressAt = nowIso;
        lastContentProgressMs = now;
        resetNoProgressTimer();
      }
      emitOutputEvent();
    }

    function finish(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (firstOutputTimer) clearTimeout(firstOutputTimer);
      if (contentFirstOutputTimer) clearTimeout(contentFirstOutputTimer);
      if (noProgressTimer) clearTimeout(noProgressTimer);
      const result = {
        ...payload,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        first_stdout_at: firstStdoutAt,
        first_stderr_at: firstStderrAt,
        first_output_delay_ms: firstOutputDelayMs,
        no_first_output_timeout: firstOutputTimedOut,
        first_output_timeout_seconds: firstOutputTimeoutSeconds || null,
        content_first_output_at: contentFirstOutputAt,
        content_first_output_delay_ms: contentFirstOutputDelayMs,
        last_content_progress_at: lastContentProgressAt,
        no_content_first_output_timeout: contentFirstOutputTimedOut,
        no_content_progress_timeout: noContentProgressTimedOut,
        content_first_output_timeout_seconds: contentFirstOutputTimeoutSeconds || null,
        no_progress_timeout_seconds: noProgressTimeoutSeconds || null,
        started_at: startedAtIso,
      };
      closeLogStreams(() => resolve(result));
    }

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      markOutput("stdout", chunk);
      writeLogChunk("stdout", chunk);
      if (!stdoutTruncated) {
        stdout += chunk;
        if (Buffer.byteLength(stdout) >= maxBuf) {
          stdoutTruncated = true;
        }
      }
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      markOutput("stderr", chunk);
      writeLogChunk("stderr", chunk);
      if (!stderrTruncated) {
        stderr += chunk;
        if (Buffer.byteLength(stderr) >= maxBuf) {
          stderrTruncated = true;
        }
      }
    });

    const timeoutMs = timeout * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup();
    }, timeoutMs);

    firstOutputTimer = firstOutputTimeoutSeconds > 0 ? setTimeout(() => {
      if (stdoutBytes === 0 && stderrBytes === 0) {
        timedOut = true;
        firstOutputTimedOut = true;
        terminateProcessGroup();
      }
    }, firstOutputTimeoutSeconds * 1000) : null;

    contentFirstOutputTimer = contentFirstOutputTimeoutSeconds > 0 ? setTimeout(() => {
      if (!contentFirstOutputAt) {
        timedOut = true;
        contentFirstOutputTimedOut = true;
        terminateProcessGroup();
      }
    }, contentFirstOutputTimeoutSeconds * 1000) : null;

    child.on("error", (err) => {
      finish({
        command,
        cwd,
        returncode: -1,
        stdout,
        stderr: stderr || err.message,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      });
    });

    child.on("exit", (code, signal) => {
      finish({
        command,
        cwd,
        returncode: code ?? -1,
        stdout,
        stderr,
        timed_out: timedOut || (signal === "SIGTERM" || signal === "SIGKILL"),
        duration_ms: Date.now() - started,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      });
    });

    child.stdin?.end();
  });
}
