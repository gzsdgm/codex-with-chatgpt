import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "src");
const distRoot = path.join(root, "dist");

function sourceFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
    hash.update(fs.readFileSync(path.join(srcRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const localCompiler = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const compiler = fs.existsSync(localCompiler) ? localCompiler : process.platform === "win32" ? "tsc.cmd" : "tsc";
const result = spawnSync(compiler, ["-p", "tsconfig.json"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (result.error) {
  console.error(`BUILD_COMPILER_FAILED: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

fs.writeFileSync(
  path.join(distRoot, "build-manifest.json"),
  JSON.stringify({ format: 1, sourceFingerprint: sourceFingerprint() }, null, 2) + "\n",
  "utf8"
);
