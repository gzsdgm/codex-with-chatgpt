# Codex with ChatGPT

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus a read-only MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **read-only** MCP connection to your current
workspace.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/XiaoDuoYa/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/XiaoDuoYa/codex-with-chatgpt into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only step that may need you: logging into ChatGPT (and nothing else).

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  read-only MCP      │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 8 read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

## Tunnels: Quick vs Named

Two Cloudflare tunnel modes are supported. **Quick Tunnel is the default and is
unchanged for existing installations.**

| | Quick Tunnel (default) | Named Tunnel |
| --- | --- | --- |
| Setup | none | Cloudflare account + domain + tunnel credentials/token |
| Public URL | `https://<random>.trycloudflare.com` — changes on every start | `https://<your-hostname>` — fixed |
| ChatGPT Connector | Server URL must be updated whenever the URL changes | configure once, never touch again |
| Best for | first try, throwaway sessions | long-lived connectors |

### Named Tunnel configuration

Resolution order: environment variables → the optional `tunnel` block of the
workspace's `.c2c.json` → defaults.

| Variable | Meaning |
| --- | --- |
| `C2C_TUNNEL_MODE` | `quick` (default) or `named` |
| `C2C_TUNNEL_TOKEN_FILE` | path to a file holding the token — MODE A, **recommended** |
| `C2C_TUNNEL_TOKEN` | inline Cloudflare tunnel token — MODE A, transient/compat |
| `C2C_TUNNEL_HOSTNAME` | fixed hostname, e.g. `c2c.example.com` (both modes) |
| `C2C_TUNNEL_NAME` | tunnel name — MODE B, locally-managed |
| `C2C_TUNNEL_CONFIG` | path to a cloudflared `config.yml` (MODE B only) |
| `C2C_TUNNEL_FALLBACK_QUICK` | `1` to allow falling back to a Quick Tunnel (default: **no fallback**) |
| `C2C_CLOUDFLARED_PROTOCOL` | `auto` (default), `quic` or `http2` |
| `C2C_TUNNEL_TOKEN_IN_ARGV` | legacy: pass the token as `--token` instead of via env (default: off) |

Two named-tunnel flavours are supported. Pick one — do not mix them.

**MODE A · remotely-managed (token)** — no `config.yml` on this machine:

```bash
export C2C_TUNNEL_MODE=named
export C2C_TUNNEL_HOSTNAME=c2c.example.com

# Recommended: store the token in a file, once. The token never touches the
# shell history, the registry or the process command line.
node <checkout>/dist/cli/index.js tunnel-token import   # paste the token, press Enter
setx C2C_TUNNEL_TOKEN_FILE "%C2C_STATE_DIR%\secrets\cloudflare-tunnel.token"

# Transient / compatibility alternative (do NOT put this in a persistent
# Windows user variable for a long-lived tunnel):
#   export C2C_TUNNEL_TOKEN=<your tunnel token>

c2c restart -w <workspace> --tunnel
```

In the Cloudflare dashboard, configure the tunnel's **Published application**:

```
c2c.example.com  ->  http://127.0.0.1:48765
```

**MODE B · locally-managed (name + config.yml)**:

```bash
export C2C_TUNNEL_MODE=named
export C2C_TUNNEL_NAME=my-tunnel
export C2C_TUNNEL_CONFIG=C:\Users\<you>\.cloudflared\config.yml
export C2C_TUNNEL_HOSTNAME=c2c.example.com
c2c restart -w <workspace> --tunnel
```

`config.yml` carries the routing:

```yaml
tunnel: my-tunnel
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: c2c.example.com
    service: http://127.0.0.1:48765
  - service: http_status:404
```

The bridge reads the mode at startup, so restart it after changing any
`C2C_TUNNEL_*` variable.

**Which token input should I use?**

| | `C2C_TUNNEL_TOKEN_FILE` | `C2C_TUNNEL_TOKEN` |
| --- | --- | --- |
| Use for | Windows logon autostart, long-lived fixed tunnels | transient sessions, compatibility |
| Stored in | a file inside `C2C_STATE_DIR` | an environment variable |
| Survives reboot | yes (file on disk) | only if persisted in the registry — avoid for real tokens |
| Token in shell history / argv | never | never in argv, but `setx` writes it to `HKCU\Environment` |

**How the token is passed to cloudflared.** Only the *path* is handed over,
through the child process environment variable `TUNNEL_TOKEN_FILE`
(official cloudflared option). c2c never reads the file's contents, so the token
exists only inside cloudflared's own process. With `C2C_TUNNEL_TOKEN`, c2c maps
it to cloudflared's `TUNNEL_TOKEN` instead. Never set both — cloudflared lets
`--token` override `--token-file`, so c2c passes exactly one of them.

Neither value may live in `.c2c.json` (that file is inside the workspace and is
routinely shown to ChatGPT). `process.env` is never modified — only the spawned
cloudflared receives the variable. For old cloudflared builds that ignore the
environment variables, `C2C_TUNNEL_TOKEN_IN_ARGV=1` falls back to
`--token <value>`; it is off by default and only affects `C2C_TUNNEL_TOKEN`,
never the token file.

**Token file safety.** `c2c tunnel-token import` reads the token from stdin
(so it never enters argv or shell history), writes it atomically, and restricts
the file to the owning user, SYSTEM and Administrators. If hardening fails the
file is kept, never deleted. `c2c doctor` reports
`TOKEN_FILE_EXISTS` / `TOKEN_FILE_ACL_SECURE` and prints nothing but the status.
`c2c status` reports the non-sensitive auth mode:
`token-file` / `token-env` / `local-config`.

Named mode **never** falls back to a random URL: if the tunnel cannot start,
`c2c doctor` reports the exact reason and the Connector URL stays untouched.
Set `C2C_TUNNEL_FALLBACK_QUICK=1` only if you accept a changing URL.

Secrets: the tunnel token is read from the environment only — never from
`.c2c.json`, which lives in the workspace and is routinely shown to ChatGPT —
and it is redacted from every log line.

### Windows notes

- **State directory.** OAuth tokens, sessions and logs live in
  `%LOCALAPPDATA%\codex-with-chatgpt`. Codex runs as an MSIX package, so the
  same directory is physically stored under
  `%LOCALAPPDATA%\Packages\OpenAI.Codex_<id>\LocalCache\Local\codex-with-chatgpt`.
  Pin it once so Codex, your terminal and the logon script all agree:

  ```bat
  setx C2C_STATE_DIR "C:\Users\<you>\AppData\Local\Packages\OpenAI.Codex_<id>\LocalCache\Local\codex-with-chatgpt"
  ```

- **Auto-start after logon.** `scripts/c2c-autostart.vbs` restores the bridge
  and tunnel in the background (hidden, no console window, idempotent: a
  healthy instance is never started twice). Put it — or a shortcut to it — in
  `shell:startup` and list the workspaces in `scripts/c2c-autostart.json`.

- **Proxies that break QUIC** (e.g. Clash fake-IP ranges, `198.18.x.x`):
  set `C2C_CLOUDFLARED_PROTOCOL=http2`.

`--protocol` is a hidden `cloudflared tunnel` option: it does not appear in
`cloudflared tunnel --help`. c2c therefore probes the real syntax
(`cloudflared tunnel --protocol <value> run __c2c_capability_probe__`, a tunnel
name that cannot exist, so no connection is opened) and only adds the flag when
cloudflared accepts it. The flag is placed right after `tunnel`, which is the
official syntax:

```
cloudflared tunnel --protocol http2 --no-autoupdate run          # MODE A (token via env)
cloudflared tunnel --protocol http2 --url http://127.0.0.1:48765 --no-autoupdate   # Quick
```

If your build rejects the flag, c2c silently keeps the default transport.

## Security model (short version)

- **Read-only by construction**: write/delete/shell/commit tools simply do not
  exist on the server. No prompt injection can enable them.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: 76 tests (path security, OAuth, pairing, MCP e2e)

c2c setup           # bridge + tunnel + pairing code, all in one
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        8 read-only tools, stateless Streamable HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Status & disclaimer

V1. Verified end-to-end: bridge, OAuth + pairing, public tunnel, ChatGPT
connector setup, zero-touch first-run experience.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)
