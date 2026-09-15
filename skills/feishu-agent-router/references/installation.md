# 首次安装与环境引导

本指南供 Codex、Claude Code 等 Agent 在用户要求“安装并接通”时执行。先检查已有环境，只补缺项；用户只询问用法时，提供指引即可。Skill 包含 Router 程序和通用模板，不包含 Node.js、飞书 CLI、模型 CLI 或登录凭据。

## 1. 检查依赖

先解析本 Skill 的真实目录为 `SKILL_ROOT`。所有示例中的路径、profile 和后台名必须替换为用户实际选择，不能直接执行占位符。

```bash
uname -s
node --version
npm --version
lark-cli --version
```

命令不存在时先处理对应依赖，不要继续执行依赖它的 Router 命令。

| 依赖 | 要求与处理 |
| --- | --- |
| 系统 | macOS 或 Linux（含 WSL）；原生 Windows 暂不支持 Router。WSL 内安装全部依赖并使用 WSL 路径。 |
| Node.js | Runtime 最低 18；新安装选择官方当前受支持的 LTS。优先复用用户已有版本管理器，安装见 [Node.js 下载](https://nodejs.org/en/download)。 |
| npm | 用于下面的 CLI 安装；如果已有 CLI 可用，无须为了 Router 重装。 |
| lark-cli | 至少 1.0.84；还需要完成应用配置、用户登录和 bot 权限。 |
| 模型 CLI | 只安装用户选择的一个后台，并完成该后台的登录或模型服务配置。 |

已获得安装授权且 npm 可用时，缺少飞书 CLI 可执行：

```bash
npm install -g @larksuite/cli@latest
lark-cli --version
lark-cli --help
```

使用现有 registry；只有用户的组织网络确实需要时，才为单次命令设置内网 registry，不修改全局配置。权限错误时先检查 npm 安装目录和已有版本管理器，不直接改用 sudo。安装后仍找不到命令，检查 npm 的 bin 目录是否在当前进程的 PATH。

## 2. 准备一个模型后台

不要因为当前助手是 Codex，就假定本机已安装可供子进程调用的 `codex`。

| 用户选择 | 检查 | 缺失时 |
| --- | --- | --- |
| Codex | `codex --version`、`codex exec --help` | `npm install -g @openai/codex@latest`，按 `codex login --help` 完成登录。安装参考 [官方仓库](https://github.com/openai/codex)。 |
| Claude Code | `claude --version`、`claude --help` | 按 [官方安装指南](https://code.claude.com/docs/en/setup) 安装并登录；可执行命令为 `claude`。 |
| Traex CLI | `traex --version`、`traex --help`、`traex exec --help` | 使用用户组织提供的 traex-cli 安装渠道；没有可核实的安装说明时询问渠道，不猜 npm 包名。 |

默认配置保留命令名 `codex`、`claude`、`traex`，通过 PATH 查找。仅用户明确指定时才覆盖命令路径。Aiden 包装后台和官方后台分别配置，参见 [configuration.md](configuration.md)。AI 会话路由还需要所选 CLI 支持结构化输出和恢复会话；按该文档的后台适配要求检查。

模型 CLI 的登录、额度或网络与飞书登录互相独立。只用 `--help` 和 `--version` 不能证明模型调用成功；接通后还需验证一条真实任务。

## 3. 配置飞书身份与权限

先读 [prerequisites.md](prerequisites.md)。有可用的 `lark-cli` / `lark-shared` Skill 时，按其配置和认证流程操作；没有时先查询当前 CLI 帮助：

```bash
lark-cli config --help
lark-cli config init --help
lark-cli auth login --help
lark-cli auth status --json --verify
```

非默认 profile 的所有飞书命令统一加 `--profile <name>`，Router 初始化时传 `--lark-profile <name>`。先检查并复用已有应用，不能为了安装 Router 替换用户已有配置。

- **尚无应用配置**：用飞书 CLI 的 `config init` 流程引导。需要用户打开链接、扫码或进入开发者后台时，立即展示 CLI 返回的操作入口。创建应用和审批权限由该流程及用户完成；不要索取聊天里的 app secret，也不要把凭据写到 Router 或 Skill 目录。
- **尚无用户登录**：按 CLI 当前帮助完成用户授权，只申请身份验证所需权限或错误明确要求的最小权限，不默认申请全部权限。先展示授权链接再等待用户操作；不要在用户看不到链接时阻塞等待。完成后重新运行 `auth status --json --verify`。
- **用户与 bot 身份不同**：已验证的用户身份用于绑定唯一 owner；bot 身份负责收消息和回复。用户登录成功不等于 bot 权限齐全。bot 缺权限按 `missing_scopes` 和 `console_url` 引导开通，不能通过用户 `auth login` 修复 bot 权限。
- **名称查询失败**：不要仅为显示 owner 名称强制增加通讯录权限。owner 绑定以验证后的身份为准。

不要读取或输出本机认证缓存、token、cookie、secret。授权链接只交给用户完成当前授权，不收入文档或发布包。若流程仍等待用户操作，明确报告待完成步骤，不能宣称配置成功。

## 4. 确定目录并初始化

只询问尚未提供的必要输入：目标工作目录的绝对路径、所选后台、可选 profile，以及是否启用 AI 会话路由。工作目录不能猜测。

用 `node "$SKILL_ROOT/scripts/router.mjs" help` 确认当前参数与默认配置位置。真实配置、状态和路由入口必须在 Skill 所在 Git 仓库之外；不要把用户路径或身份填入分发用示例。先检查 `status --json`；已有配置按 [configuration.md](configuration.md) 做最小调整，不用 `init --force` 覆盖。

首次接通并启用 AI 会话路由的示例：

```bash
node "$SKILL_ROOT/scripts/router.mjs" init \
  --workspace 'main=/absolute/path/to/project' \
  --backend codex \
  --router-dir '/absolute/path/to/private-router-entry'
```

路由入口生成通用 `AGENTS.md`，实际业务在 `--workspace` 指定目录执行。无需 AI 路由时省略 `--router-dir`。非默认飞书身份增加 `--lark-profile '<name>'`。

macOS 默认初始化会检查环境、安装并启动用户 LaunchAgent。只生成配置时加 `--no-autostart`；Linux/WSL 必须加该参数，之后 doctor 通过再 `start`。Linux/WSL 尚无内置自动启动安装器，如用户需要，应另外按该系统的服务管理方式配置，不能承诺已自动启动。

macOS 自动启动依赖用户登录、网络和有效 CLI 登录；电脑睡眠期间不能处理消息。服务记录安装时的 Node 路径与 PATH，应先把依赖装好再安装服务。终端能运行而服务找不到命令时，检查服务环境；重复 `service-install` 不会改写已有 plist 的 PATH，详见 [configuration.md](configuration.md)。

## 5. 验证并交付

```bash
node "$SKILL_ROOT/scripts/router.mjs" doctor
node "$SKILL_ROOT/scripts/router.mjs" status --json
node "$SKILL_ROOT/scripts/router.mjs" logs
```

修复所有 FAIL，说明 WARN 的具体影响。如果配置使用非默认位置，所有 Router 命令都传同一 `--config`。尚未启动且用户已要求接通时执行 `start`；macOS 自动启动状态用 `service-status` 查看。

请 owner 在机器人私聊完成：

1. `/help`：核对 owner、白名单和实际目录配置。默认没有访客；访客必须由 owner 添加并指定到期时间。
2. `/ping`：收到 `pong`，同时核对日志里带 `replyMessageId` 的 `reply_succeeded`。
3. 一条无副作用的普通任务：验证模型后台可用；启用 AI 路由时，再追问一轮并核对是否续接同一会话。

结果分别说明依赖检查、身份与配置、本地服务、飞书回环、模型任务是否成功。没有真实回环就写“待用户验证”，不能用进程 ready 代替。

用户可以这样开始：

> 请用 feishu-agent-router 安装并接通飞书到本机 Codex。先检查并补齐缺少的环境，引导我完成授权；目标工作目录是我指定的绝对路径，启用 AI 会话路由和系统支持的自动启动，最后验证 /ping 和两轮会话。

Agent 可以检查环境、安装缺失的软件、生成配置和诊断；用户仍需完成登录、权限审批及缺失的目录选择。具体故障继续读 [troubleshooting.md](troubleshooting.md)。
