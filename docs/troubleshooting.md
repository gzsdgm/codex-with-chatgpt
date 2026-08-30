# Troubleshooting

First move, always:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

### Tunnel URL unreachable / ChatGPT says the connector is broken
Quick Tunnel URLs change whenever the tunnel restarts.

1. `c2c doctor` — restarts the tunnel and prints the current URL.
2. Update the connector's Server URL in ChatGPT settings (the Skill does this
   automatically via Computer Use).
3. Re-authorize with a fresh pairing code: `c2c pair`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Reconnect the connector in ChatGPT (it will run OAuth
again) and enter a fresh pairing code.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### Named Tunnel 模式起不来（NEED_NAMED_TUNNEL_CONFIG）
Named 有两种模式，**二选一**，`c2c doctor` 会逐条列出缺什么。

MODE A · 远端托管（token）——本机不需要 config.yml：

```
C2C_TUNNEL_MODE=named
C2C_TUNNEL_HOSTNAME=c2c.example.com          # 固定域名
C2C_TUNNEL_TOKEN_FILE=%C2C_STATE_DIR%\secrets\cloudflare-tunnel.token   # 推荐
# 或（临时会话/兼容）：C2C_TUNNEL_TOKEN=<token>
```

长期固定隧道、尤其是配合 Windows 开机自动启动时，**用 `C2C_TUNNEL_TOKEN_FILE`**，
不要用 `setx C2C_TUNNEL_TOKEN <真实token>`——后者会把明文 token 长期写进
`HKCU\Environment`。生成 token 文件：

```
node <checkout>/dist/cli/index.js tunnel-token import
```

从 stdin 粘贴（不进命令行、不进 shell 历史、不写日志），原子写入后收紧 ACL。
默认路径：`%C2C_STATE_DIR%\secrets\cloudflare-tunnel.token`。
`c2c tunnel-token path` 可以查看该路径。

另外要在 Cloudflare 控制台把该隧道的 Published application 配成
`c2c.example.com -> http://127.0.0.1:48765`。
如果你看到的是"缺少 C2C_TUNNEL_CONFIG"，说明当前没有 token，被当成 MODE B 校验了。

MODE B · 本地托管（隧道名 + config.yml）：

```
C2C_TUNNEL_MODE=named
C2C_TUNNEL_HOSTNAME=c2c.example.com
C2C_TUNNEL_NAME=my-tunnel
C2C_TUNNEL_CONFIG=C:\Users\<你>\.cloudflared\config.yml
```

config.yml 需要 `tunnel` / `credentials-file` / `ingress` 三段，ingress 里把
`c2c.example.com` 指向 `http://127.0.0.1:48765`。Named 模式默认**不会**回退到 Quick Tunnel，
所以你不会看到连接器地址突然变成一个随机 trycloudflare.com 地址；
如果你接受地址变化，才设 `C2C_TUNNEL_FALLBACK_QUICK=1`。

改完 `C2C_TUNNEL_*` 必须重启 Bridge（`c2c restart -w <workspace> --tunnel`），
模式只在进程启动时读取。

### Windows：每次重启都像没装过
三个常见原因，都不是安装损坏：

1. 没有任何登录启动项 → Bridge 和隧道根本没起来。
   把 `scripts/c2c-autostart.vbs`（或它的快捷方式）放进 `shell:startup`，
   工作区写在 `scripts/c2c-autostart.json`。
2. 状态目录上下文不一致 → Codex（MSIX 包）里的 `%LOCALAPPDATA%` 与
   普通终端解析到的路径不同，后者会看到一个空目录，于是判定"没授权"。
   用 `setx C2C_STATE_DIR "<物理路径>"` 固定一次。
3. Quick Tunnel 地址每次启动都会变 → 连接器地址失效，需要更新 URL 并重新配对。
   这是产品固有行为，不是安装问题；想彻底解决就改用 Named Tunnel 固定域名。

### cloudflared 反复退出（日志出现 198.18.x.x）
`198.18.0.0/15` 是 Clash 等代理的 fake-IP 段，会打断 QUIC 传输。
改 cloudflared 的传输协议，不要动代理配置：

```
setx C2C_CLOUDFLARED_PROTOCOL http2
c2c restart -w <workspace> --tunnel
```

`--protocol` 不在 `cloudflared tunnel --help` 里（隐藏选项）。c2c 用真实语法探测：
`cloudflared tunnel --protocol http2 run __c2c_capability_probe__`（不可能存在的隧道名，
不会建立连接），cloudflared 接受才加参数，位置紧跟 `tunnel`。
不支持的旧版本会自动保持默认传输协议。

自检：

```
cloudflared tunnel --protocol http2 run __c2c_capability_probe__
```

看到 `flag provided but not defined` 说明该版本不支持；
看到凭据/隧道解析错误说明参数已被接受。

### token 会不会出现在命令行里
不会。

- token-file 模式：只把**路径**通过子进程环境变量 `TUNNEL_TOKEN_FILE` 传给 cloudflared，
  c2c 不读取文件内容，token 只存在于 cloudflared 自己的进程里。
- inline token 模式：`C2C_TUNNEL_TOKEN` 映射为 `TUNNEL_TOKEN`，同样只走子进程环境。

两种情况下 argv 都只有 `tunnel --no-autoupdate run`，Windows 进程列表看不到 token；
`process.env` 也未被修改。日志、runtime JSON、state 与异常信息同样做了脱敏。
只有显式设置 `C2C_TUNNEL_TOKEN_IN_ARGV=1` 才会退回 `--token <value>`（旧版兼容，默认关闭，
且不影响 token-file 模式）。

### doctor 报告 token 文件权限过宽
`c2c doctor` 会输出：

```
Token 文件（TOKEN_FILE_EXISTS=true TOKEN_FILE_ACL_SECURE=false（ACL too permissive (readable by Everyone)））
```

处理：

1. 不要删除该文件（删除会丢掉凭据，c2c 也绝不会自动删除它）。
2. 手动收紧：`icacls "<path>" /inheritance:r /grant:r "%USERNAME%:(R)" "*S-1-5-18:(R)" "*S-1-5-32-544:(R)"`
3. 或重新导入一次：`node <checkout>/dist/cli/index.js tunnel-token import`
   （原子覆盖写入并重新设置 ACL）。

允许的主体：当前用户、SYSTEM、Administrators。
不允许：Everyone / Users / Authenticated Users。doctor 只报状态，不打印文件内容。

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
