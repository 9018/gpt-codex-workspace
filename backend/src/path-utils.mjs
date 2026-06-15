import { mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function resolveWorkspacePath(root, target = ".") {
  await ensureDir(root);
  const realRoot = await realpath(root);
  const normalizedTarget = String(target || ".").replaceAll("\\", "/");
  if (normalizedTarget.startsWith("/") || /^[A-Za-z]:\//.test(normalizedTarget)) {
    throw new Error("absolute paths are outside workspace root");
  }

  const absolutePath = resolve(realRoot, normalizedTarget);
  const rel = relative(realRoot, absolutePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== absolutePath) {
    throw new Error(`path is outside workspace root: ${target}`);
  }

  return {
    root: realRoot,
    absolutePath,
    relativePath: rel === "" ? "." : rel.replaceAll("\\", "/")
  };
}

export async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}
