// Windows logon auto-restore for Codex with ChatGPT.
//
// Restores the Bridge + Cloudflare tunnel for every workspace listed in
// c2c-autostart.json. Guarantees:
//   * never reinstalls, never re-pairs, never un-pairs, never touches OAuth state
//   * skips a workspace whose bridge is already listening AND whose public URL
//     answers /health (so a healthy instance is never started twice)
//   * only re-establishes the tunnel when it is down, leaving the running
//     bridge (and its OAuth tokens) untouched
//
// Launch hidden through c2c-autostart.vbs (wscript.exe //B).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "dist", "cli", "index.js");
// C2C_AUTOSTART_CONFIG only exists so the test-suite can point at a temp file;
// production always uses scripts/c2c-autostart.json.
const configFile = process.env.C2C_AUTOSTART_CONFIG?.trim() || path.join(here, "c2c-autostart.json");
const nodeBin = process.execPath;

function stateDir() {
  const override = process.env.C2C_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "codex-with-chatgpt");
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) return path.join(userProfile, "AppData", "Local", "codex-with-chatgpt");
  throw new Error("C2C_STATE_DIR_UNRESOLVED: set C2C_STATE_DIR or LOCALAPPDATA before autostart");
}

const logFile = (() => {
  const dir = path.join(stateDir(), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return path.join(dir, "autostart.log");
})();

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.appendFileSync(logFile, line, "utf8");
  } catch {
    /* best effort */
  }
}

/** Tunnel settings are inherited from the logon environment; re-pass them explicitly. */
const TUNNEL_ENV_KEYS = [
  "C2C_STATE_DIR",
  "C2C_TUNNEL_MODE",
  "C2C_TUNNEL_TOKEN_FILE",
  "C2C_TUNNEL_TOKEN",
  "C2C_TUNNEL_HOSTNAME",
  "C2C_TUNNEL_NAME",
  "C2C_TUNNEL_CONFIG",
  "C2C_TUNNEL_FALLBACK_QUICK",
  "C2C_CLOUDFLARED_PROTOCOL",
];

function childEnv() {
  // Make the effective state location explicit so a logon task and a manual
  // CLI invocation cannot silently choose different OAuth/runtime stores.
  const env = { ...process.env, C2C_STATE_DIR: stateDir() };
  for (const key of TUNNEL_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/**
 * Fixed URL expected when C2C_TUNNEL_MODE=named, or null in Quick mode.
 * Never logs the token.
 */
function expectedNamedUrl() {
  const mode = (process.env.C2C_TUNNEL_MODE ?? "quick").trim().toLowerCase();
  if (mode !== "named") return null;
  const raw = (process.env.C2C_TUNNEL_HOSTNAME ?? "").trim();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/\.$/, "").toLowerCase();
  return host ? `https://${host}` : null;
}

function runCli(args, timeoutMs = 60_000) {
  const result = spawnSync(nodeBin, [cli, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: childEnv(),
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.filter((w) => typeof w === "string" && w) : [];
    return { workspaces, tunnel: raw.tunnel !== false };
  } catch (error) {
    log(`config error: ${error.message}`);
    return { workspaces: [], tunnel: true };
  }
}

async function publicUrlHealthy(url) {
  if (!url) return false;
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Ask the running bridge to (re)open the tunnel without restarting it. */
async function startTunnelViaAdmin(workspaceId, port, adminToken) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/tunnel/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(95_000),
    });
    const body = await response.json().catch(() => ({}));
    log(`admin tunnel/start -> ${response.status} ${JSON.stringify(body)}`);
    return response.ok && Boolean(body.url) ? body.url : null;
  } catch (error) {
    log(`admin tunnel/start failed: ${error.message}`);
    return null;
  }
}

function readRuntimeState(workspaceId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), "runtime", `${workspaceId}.json`), "utf8"));
  } catch {
    return null;
  }
}

function startBridgeDetached(workspace, tunnel) {
  const args = [cli, "start", "-w", workspace, "--json"];
  if (tunnel) args.push("--tunnel");
  const out = fs.openSync(logFile, "a");
  const child = spawn(nodeBin, args, {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    cwd: repoRoot,
    env: childEnv(),
  });
  child.unref();
  fs.closeSync(out);
}

/**
 * Guard: in named mode the public URL must be exactly the configured hostname.
 * A random trycloudflare.com address here would silently break the ChatGPT
 * Connector, so it is reported instead of being accepted.
 */
function verifyExpectedUrl(url) {
  const expected = expectedNamedUrl();
  if (!expected) return true;
  if (url === expected) return true;
  log(
    `ERROR: named mode expects ${expected} but the bridge reports ${String(url ?? "none")};` +
      ` refusing to accept a random URL (no fallback to Quick Tunnel)`
  );
  return false;
}

async function handleWorkspace(workspace, useTunnel) {
  const expected = expectedNamedUrl();
  log(
    `--- workspace ${workspace} (mode=${(process.env.C2C_TUNNEL_MODE ?? "quick").trim().toLowerCase()}` +
      `${expected ? `, fixed url=${expected}` : ""})`
  );
  const status = runCli(["status", "-w", workspace, "--json"], 30_000);
  let info = null;
  try {
    info = JSON.parse(status.stdout);
  } catch {
    info = null;
  }

  if (!info || !info.ok || !info.running) {
    log("no live bridge -> starting");
    startBridgeDetached(workspace, useTunnel);
    return;
  }

  log(
    `bridge live (pid ${info.pid}, port ${info.port}, provider=${info.tunnel?.provider ?? "?"}, ` +
      `authMode=${info.tunnel?.authMode ?? "n/a"}), tunnel.running=${info.tunnel?.running}`
  );
  if (!useTunnel) {
    log("tunnel disabled in config -> nothing to do");
    return;
  }
  if (info.tunnel?.running && (await publicUrlHealthy(info.publicUrl))) {
    verifyExpectedUrl(info.publicUrl);
    log(`already healthy at ${info.publicUrl} -> no action`);
    return;
  }

  const runtime = readRuntimeState(info.workspaceId);
  if (info.tunnel?.running && info.publicUrl && !runtime) {
    // Tunnel object says running but /health failed; restarting the tunnel is
    // the only recovery that does not touch OAuth state.
    log("public url unreachable -> restarting tunnel through admin API");
  }
  const url = runtime ? await startTunnelViaAdmin(info.workspaceId, info.port, runtime.adminToken) : null;
  if (url) {
    log(`tunnel restored: ${url} (previous: ${String(info.publicUrl ?? "none")})`);
    verifyExpectedUrl(url);
  } else {
    log("could not restore tunnel via admin API; left the running bridge untouched");
  }
}

async function main() {
  log(`=== autostart (repo ${repoRoot}, node ${process.versions.node})`);
  const { workspaces, tunnel } = readConfig();
  if (workspaces.length === 0) {
    log("no workspaces configured -> exiting");
    return;
  }
  for (const workspace of workspaces) {
    try {
      await handleWorkspace(workspace, tunnel);
    } catch (error) {
      log(`error for ${workspace}: ${error.message}`);
    }
  }
  log("=== autostart done");
}

await main();
