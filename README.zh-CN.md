# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

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

**更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，
无需任何操作；也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

1. 安装 Codex Skill：把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT。仅此而已。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  只读 MCP           │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  只读
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，共 8 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

## 隧道：Quick 与 Named

支持两种 Cloudflare 隧道。**默认是 Quick Tunnel，老用户升级后行为完全不变。**

| | Quick Tunnel（默认） | Named Tunnel |
| --- | --- | --- |
| 前置条件 | 无 | Cloudflare 账号 + 域名 + 隧道凭据/token |
| 公网地址 | `https://<随机>.trycloudflare.com`，**每次启动都会变** | `https://<你的域名>`，**固定不变** |
| ChatGPT 连接器 | 地址一变就必须更新 Server URL | 配置一次，以后不用再动 |
| 适合 | 初次体验、临时会话 | 长期使用的连接器 |

### Named Tunnel 配置

优先级：环境变量 → 工作区 `.c2c.json` 的 `tunnel` 段 → 默认值。

| 变量 | 含义 |
| --- | --- |
| `C2C_TUNNEL_MODE` | `quick`（默认）或 `named` |
| `C2C_TUNNEL_TOKEN_FILE` | 存放 token 的文件路径 —— MODE A（**推荐**） |
| `C2C_TUNNEL_TOKEN` | 直接写 token —— MODE A（临时会话/兼容） |
| `C2C_TUNNEL_HOSTNAME` | 固定域名，例如 `c2c.example.com`（两种模式都要） |
| `C2C_TUNNEL_NAME` | 隧道名 —— MODE B（本地托管） |
| `C2C_TUNNEL_CONFIG` | cloudflared `config.yml` 路径（仅 MODE B 需要） |
| `C2C_TUNNEL_FALLBACK_QUICK` | 设为 `1` 才允许回退到 Quick Tunnel（默认**不回退**） |
| `C2C_CLOUDFLARED_PROTOCOL` | `auto`（默认）、`quic` 或 `http2` |
| `C2C_TUNNEL_TOKEN_IN_ARGV` | 旧版兼容：改用 `--token` 传参而不用环境变量（默认关闭） |

两种 Named 模式，二选一，不要混用。

**MODE A · 远端托管（token）**——本机不需要 `config.yml`：

```bash
export C2C_TUNNEL_MODE=named
export C2C_TUNNEL_HOSTNAME=c2c.example.com

# 推荐：把 token 存进文件，只做一次。token 不会进入 shell 历史、注册表或命令行。
node <checkout>/dist/cli/index.js tunnel-token import   # 粘贴 token 后回车
setx C2C_TUNNEL_TOKEN_FILE "%C2C_STATE_DIR%\secrets\cloudflare-tunnel.token"

# 临时会话 / 兼容模式（长期固定隧道不要把真实 token 写进 Windows 用户变量）：
#   export C2C_TUNNEL_TOKEN=<你的隧道 token>

c2c restart -w <工作区> --tunnel
```

在 Cloudflare 控制台里把该隧道的 **Published application** 配成：

```
c2c.example.com  ->  http://127.0.0.1:48765
```

**MODE B · 本地托管（隧道名 + config.yml）**：

```bash
export C2C_TUNNEL_MODE=named
export C2C_TUNNEL_NAME=my-tunnel
export C2C_TUNNEL_CONFIG=C:\Users\<你>\.cloudflared\config.yml
export C2C_TUNNEL_HOSTNAME=c2c.example.com
c2c restart -w <工作区> --tunnel
```

`config.yml` 负责路由：

```yaml
tunnel: my-tunnel
credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: c2c.example.com
    service: http://127.0.0.1:48765
  - service: http_status:404
```

Bridge 只在启动时读取模式，改完 `C2C_TUNNEL_*` 后需要重启 Bridge。

**该用哪个 token 输入？**

| | `C2C_TUNNEL_TOKEN_FILE` | `C2C_TUNNEL_TOKEN` |
| --- | --- | --- |
| 适用 | Windows 开机自动启动、长期固定隧道 | 临时会话、兼容模式 |
| 存放 | `C2C_STATE_DIR` 下的文件 | 环境变量 |
| 重启后 | 保留（磁盘文件） | 只有写进注册表才保留——真实 token 不建议这么做 |
| 是否进入 shell 历史 / 命令行 | 不会 | 不会进命令行，但 `setx` 会写进 `HKCU\Environment` |

**token 怎么传给 cloudflared**：只传**路径**，走 cloudflared 官方子进程环境变量
`TUNNEL_TOKEN_FILE`；c2c 从不读取文件内容，token 只存在于 cloudflared 自己的进程里。
用 `C2C_TUNNEL_TOKEN` 时则映射为 `TUNNEL_TOKEN`。两者不要同时设置——cloudflared 的
`--token` 会覆盖 `--token-file`，所以 c2c 只会传其中一个。

两者都不允许写进 `.c2c.json`（该文件在工作区里，会经常展示给 ChatGPT）。`process.env`
不会被修改，只有被 spawn 的 cloudflared 拿得到。旧版 cloudflared 若忽略环境变量，
可设 `C2C_TUNNEL_TOKEN_IN_ARGV=1` 退回 `--token <value>`；默认关闭，且只影响
`C2C_TUNNEL_TOKEN`，不影响 token 文件。

**token 文件安全**：`c2c tunnel-token import` 从 stdin 读取（不进命令行、不进 shell 历史），
原子写入后再收紧 ACL 到「当前用户 / SYSTEM / Administrators 可读」。加固失败也**不会删除**
该文件。`c2c doctor` 只报告 `TOKEN_FILE_EXISTS` / `TOKEN_FILE_ACL_SECURE`，不打印内容；
`c2c status` 报告非敏感的认证模式：`token-file` / `token-env` / `local-config`。

Named 模式**绝不**静默回退成随机地址：隧道起不来时 `c2c doctor` 会给出明确原因，
连接器地址保持不变。只有在你接受地址会变的情况下才设 `C2C_TUNNEL_FALLBACK_QUICK=1`。

凭据安全：token 只从环境变量读取，绝不从 `.c2c.json` 读取（该文件在工作区里，
会经常展示给 ChatGPT），并且所有日志都会对它做脱敏。

### Windows 注意事项

- **状态目录**：OAuth token、会话与日志都在 `%LOCALAPPDATA%\codex-with-chatgpt`。
  Codex 以 MSIX 包形式运行，该目录的物理位置是
  `%LOCALAPPDATA%\Packages\OpenAI.Codex_<id>\LocalCache\Local\codex-with-chatgpt`。
  建议固定一次，让 Codex、终端和登录脚本看到同一个目录：

  ```bat
  setx C2C_STATE_DIR "C:\Users\<你>\AppData\Local\Packages\OpenAI.Codex_<id>\LocalCache\Local\codex-with-chatgpt"
  ```

- **登录后自动启动**：`scripts/c2c-autostart.vbs` 会在后台恢复 Bridge 与隧道
  （无窗口、幂等：已有健康实例不会重复启动）。把它或它的快捷方式放进
  `shell:startup`，并在 `scripts/c2c-autostart.json` 里列出工作区。

- **代理会打断 QUIC**（例如 Clash 的 fake-IP 段 `198.18.x.x`）时，设置
  `C2C_CLOUDFLARED_PROTOCOL=http2`。

`--protocol` 是 `cloudflared tunnel` 的隐藏选项，`cloudflared tunnel --help` 里看不到。
因此 c2c 用真实语法探测：`cloudflared tunnel --protocol <值> run __c2c_capability_probe__`
（一个不可能存在的隧道名，cloudflared 在解析凭据阶段就退出，不会建立任何连接），
只有 cloudflared 接受该参数时才加。参数位置遵循官方语法，紧跟在 `tunnel` 之后：

```
cloudflared tunnel --protocol http2 --no-autoupdate run          # MODE A（token 走环境变量）
cloudflared tunnel --protocol http2 --url http://127.0.0.1:48765 --no-autoupdate   # Quick
```

若你的版本不接受该参数，c2c 会保持默认传输协议。

## 安全模型（简版）

- **从构造上只读**：服务端根本不存在写文件/删除/Shell/提交类工具，任何提示
  注入都无法启用它们。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：76 个测试（路径安全、OAuth、配对、MCP 端到端）

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        8 个只读工具、无状态 Streamable HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 状态与声明

V1。已端到端验证：Bridge、OAuth + 配对、公网隧道、ChatGPT 连接器配置、
零操作首次配置体验。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
