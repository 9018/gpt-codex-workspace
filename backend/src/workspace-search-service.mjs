import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SEARCH_MAX_FILE_BYTES, DEFAULT_SEARCH_MAX_TOTAL_BYTES, looksBinary, normalizeSearchExcludeDirs } from "./workspace-search-helpers.mjs";
import { resolvePath } from "./workspace-file-service.mjs";
import { requireScope } from "./auth-context.mjs";
import { sshSearchFiles } from "./ssh-adapter.mjs";

export async function workspaceSearch(store, config, { q, path = ".", limit = 50, exclude_dirs = [], max_file_bytes = DEFAULT_SEARCH_MAX_FILE_BYTES, max_total_bytes = DEFAULT_SEARCH_MAX_TOTAL_BYTES, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  const maxResults = Math.max(1, Math.min(Number(limit) || 50, 500));
  const maxFileBytes = Math.max(0, Number(max_file_bytes) || DEFAULT_SEARCH_MAX_FILE_BYTES);
  const maxTotalBytes = Math.max(0, Number(max_total_bytes) || DEFAULT_SEARCH_MAX_TOTAL_BYTES);
  const excludeDirs = normalizeSearchExcludeDirs(exclude_dirs);
  if (workspace.type === "ssh") {
    const raw = await sshSearchFiles(workspace, q, resolvedPath, 60, maxResults, { maxFileBytes, maxTotalBytes, excludeDirs: [...excludeDirs] });
    const paths = (raw.stdout || "").trim().split("\n").filter(Boolean).slice(0, maxResults);
    const results = paths.map((p) => ({ path: p, matched_name: true, matched_content: true, snippet: "" }));
    return { q, path, count: results.length, results, max_total_bytes: maxTotalBytes, raw: { returncode: raw.returncode, stdout: raw.stdout, stderr: raw.stderr } };
  }
  const results = [];
  let scannedBytes = 0;
  let skippedBinary = 0;
  let skippedTotalBytes = false;
  async function walk(abs, rel) {
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || excludeDirs.has(childRel)) continue;
        await walk(childAbs, childRel);
      }
      else {
        const matchedName = childRel.includes(q);
        const info = await stat(childAbs);
        let text = "";
        let idx = -1;
        if (info.size <= maxFileBytes) {
          const bytes = await readFile(childAbs);
          if (scannedBytes + bytes.length > maxTotalBytes) {
            skippedTotalBytes = true;
            return;
          }
          scannedBytes += bytes.length;
          if (looksBinary(bytes)) {
            skippedBinary += 1;
          } else {
            text = bytes.toString("utf8");
            idx = text.indexOf(q);
          }
        }
        if (matchedName || idx !== -1) {
          results.push({ path: childRel, size: info.size, matched_name: matchedName, matched_content: idx !== -1, snippet: idx === -1 ? "" : text.slice(Math.max(0, idx - 40), idx + q.length + 40) });
        }
      }
    }
  }
  await walk(resolvedPath, path);
  return { q, path, count: results.length, results, scanned_bytes: scannedBytes, max_total_bytes: maxTotalBytes, skipped_binary: skippedBinary, skipped_total_bytes: skippedTotalBytes, truncated: skippedTotalBytes || results.length >= maxResults };
}
