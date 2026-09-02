#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "index.js");
const srcRoot = path.join(here, "..", "src");
const manifest = path.join(here, "..", "dist", "build-manifest.json");

function sourceFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
  }
  return files.sort();
}

function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const relative of sourceFiles(srcRoot)) {
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path.join(srcRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (existsSync(dist)) {
  if (existsSync(srcRoot)) {
    let builtFingerprint = "";
    try {
      builtFingerprint = JSON.parse(readFileSync(manifest, "utf8")).sourceFingerprint;
    } catch {
      // A source checkout must have a readable build manifest.
    }
    if (builtFingerprint !== sourceFingerprint()) {
      console.error("DIST_STALE_REBUILD_REQUIRED");
      process.exit(1);
    }
  }
  // Windows: a bare "C:\..." specifier is parsed as the URL scheme "c:".
  await import(pathToFileURL(dist).href);
} else {
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const entry = path.join(here, "..", "src", "cli", "index.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
