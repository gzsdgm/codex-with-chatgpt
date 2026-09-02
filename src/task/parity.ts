import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function sourceFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
  }
  return files.sort();
}

export function sourceFingerprint(srcRoot: string): string {
  const hash = createHash("sha256");
  for (const relative of sourceFiles(srcRoot)) {
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(srcRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertDistFresh(projectRoot: string, distRoot: string): void {
  const srcRoot = path.join(projectRoot, "src");
  if (!fs.existsSync(srcRoot)) return;
  let manifest: { sourceFingerprint?: string };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distRoot, "build-manifest.json"), "utf8")) as { sourceFingerprint?: string };
  } catch {
    throw new Error("DIST_STALE_REBUILD_REQUIRED");
  }
  if (manifest.sourceFingerprint !== sourceFingerprint(srcRoot)) throw new Error("DIST_STALE_REBUILD_REQUIRED");
}
