import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "scripts", "c2c-autostart.mjs");
const cli = path.join(repoRoot, "dist", "cli", "index.js");

const TOKEN = "REDACTED_TEST_TOKEN_SUPERSECRET";
const HOSTNAME = "c2c.example.test";

const dirs: string[] = [];
const stopBridge = (workspace: string, stateDir: string): void => {
  spawnSync(process.execPath, [cli, "stop", "-w", workspace], {
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
    windowsHide: true,
  });
};

afterAll(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

/**
 * End-to-end check of the Windows logon script in Named Tunnel mode.
 * `tunnel: false` keeps a real cloudflared out of the test; the point is that
 * the script reports the fixed URL, stays idempotent, never falls back to a
 * random Quick Tunnel URL and never leaks the token.
 */
describe("c2c-autostart in named mode", () => {
  it(
    "is idempotent, keeps the fixed URL and never leaks the token",
    async () => {
      const stateDir = makeTmpDir("autostart-state");
      const workspace = makeTmpDir("autostart-ws");
      dirs.push(stateDir, workspace);
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n");

      const configFile = path.join(stateDir, "autostart.json");
      fs.writeFileSync(configFile, JSON.stringify({ workspaces: [workspace], tunnel: false }));

      const runEnv: NodeJS.ProcessEnv = {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        C2C_AUTOSTART_CONFIG: configFile,
        C2C_TUNNEL_MODE: "named",
        C2C_TUNNEL_HOSTNAME: HOSTNAME,
        C2C_TUNNEL_TOKEN: TOKEN,
      };

      const runScript = (): void => {
        const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: runEnv, windowsHide: true });
        expect(result.status).toBe(0);
      };

      runScript();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const runtimeDir = path.join(stateDir, "runtime");
      const runtimeFiles = fs.readdirSync(runtimeDir);
      expect(runtimeFiles.length).toBeGreaterThan(0);
      const firstPid = JSON.parse(
        fs.readFileSync(path.join(runtimeDir, runtimeFiles[0]), "utf8")
      ).pid as number;

      // Second run must recognise the healthy instance and leave it alone.
      runScript();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const secondPid = JSON.parse(
        fs.readFileSync(path.join(runtimeDir, runtimeFiles[0]), "utf8")
      ).pid as number;
      expect(secondPid).toBe(firstPid);

      const logFile = path.join(stateDir, "logs", "autostart.log");
      const log = fs.readFileSync(logFile, "utf8");

      expect(log).toContain(`fixed url=https://${HOSTNAME}`);
      expect(log).toContain("mode=named");
      // No silent downgrade to a random Quick Tunnel address.
      expect(log.toLowerCase()).not.toContain("trycloudflare.com");
      expect(log).not.toContain("falling back");
      // Secrets never reach disk.
      expect(log).not.toContain(TOKEN);

      stopBridge(workspace, stateDir);
    },
    120_000
  );
});
