import { dirname } from "node:path";
import { shellQuotee } from "./mcp-tooling.mjs";
import { runLocalShell } from "./local-shell-runner.mjs";

export async function runZipCommand(mode, sourcePath, zipPath, pythonCommand = process.platform === "win32" ? "python" : "python3") {
  const command = mode === "create"
    ? pythonCommand + " -m zipfile -c " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath)
    : pythonCommand + " -m zipfile -e " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath);
  const result = await runLocalShell(command, dirname(zipPath), 60, 1000000);
  if (result.returncode !== 0) throw new Error(`zip command failed: ${result.stderr || result.stdout}`);
  return result;
}
