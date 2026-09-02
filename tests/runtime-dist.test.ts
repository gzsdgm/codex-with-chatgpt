import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertDistFresh, sourceFingerprint } from "../src/task/parity.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("source and dist runtime parity", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) cleanup(root);
  });

  it("refuses a stale or missing build manifest", () => {
    root = makeTmpDir("runtime-parity");
    const src = path.join(root, "src");
    const dist = path.join(root, "dist");
    write(src, "entry.ts", "export const version = 1;\n");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "build-manifest.json"), JSON.stringify({ sourceFingerprint: "stale" }));
    expect(() => assertDistFresh(root!, dist)).toThrow("DIST_STALE_REBUILD_REQUIRED");

    fs.writeFileSync(path.join(dist, "build-manifest.json"), JSON.stringify({ sourceFingerprint: sourceFingerprint(src) }));
    expect(() => assertDistFresh(root!, dist)).not.toThrow();
    write(src, "entry.ts", "export const version = 2;\n");
    expect(() => assertDistFresh(root!, dist)).toThrow("DIST_STALE_REBUILD_REQUIRED");
  });
});
