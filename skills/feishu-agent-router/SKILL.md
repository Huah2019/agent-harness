---
name: feishu-agent-router
description: >-
  安装、配置、启动、停止和排查飞书机器人到本地 Agent CLI 的消息路由，支持 Codex、Claude、Aiden、traex-cli（traex）及通用 stdin/stdout CLI。可通过通用路由目录 AGENTS.md 让 AI 选择新建或续接会话，目标工作目录由配置指定。用户提到手机远程调用本机 Agent、AI 会话路由、配置工作目录或 sender open_id、切换 workspace/backend、Router 收不到消息或回消息失败时，应使用本 Skill。不要用于普通飞书消息发送、云文档编辑或直接处理被路由的业务请求。
---

# Feishu Agent Router

把允许的飞书用户消息安全地转发给本机 Agent CLI。Skill 负责安装、配置和诊断；`scripts/` 中的 Runtime 负责持续监听、串行执行和回复。

支持两种执行模式：旧配置默认直连工作目录；`routing.mode=agent` 启用“通用路由目录 → AI 选会话 → 用户指定工作目录”。路由目录只放通用规则，个人路径只保存在用户配置中。会话路由配置先读 `references/configuration.md` 的“AI 会话路由”。

## 先确定路径

开始时解析：

- `SKILL_ROOT`：本文件所在目录，用于定位 `scripts/`、`references/` 和 `assets/`。
- `CONFIG_PATH`：用户显式指定的配置；否则运行以下命令读取默认位置：

```bash
node "$SKILL_ROOT/scripts/router.mjs" help
```

所有命令都使用实际绝对路径替换 `$SKILL_ROOT`。不要假设 Skill 安装在固定用户目录。

Skill 可以通过软链接挂载，修改源码时以链接目标为准。真实配置、状态和个性化路由目录必须放在 Skill 所在 Git 仓库外（独立安装时放在 Skill 目录外）；Runtime 会解析软链接并拒绝仓库内的私人数据路径。推荐实际路由入口为 `~/.local/share/feishu-agent-router/entry`，通过 `--router-dir` 指定。分发的 `assets/router-AGENTS.md` 只保留通用模板。

## 适用边界

使用本 Skill：

- 首次把飞书机器人连接到本机 Codex、Claude 或其他 Agent CLI。
- 添加允许用户、工作区别名、后台 CLI，或调整群聊 mention 策略。
- 启动、停止、查看状态和日志。
- 排查收不到消息、任务没有运行、工作区错误或回复失败。

不使用本 Skill：

- 只想发送一条普通飞书消息、编辑文档或管理群聊。
- 用户已经通过 Router 发来一个业务问题；业务问题应由当前工作区的 Agent 和 Skills 处理。
- 创建飞书应用、审批开放平台权限或保管 app secret。Router 复用已配置的 `lark-cli` bot 身份。

## 必要输入

首次初始化前确认：

1. lark-cli 当前 profile 已完成用户登录；`init` 用 `auth status --json --verify` 自动绑定 CLI 本人为唯一 owner。
2. 至少一个工作区别名和绝对路径，例如 `main=/path/to/project`。
3. 默认后台：`codex`、`claude` 或 `traex`，以及对应命令是否在 `PATH`。traex-cli 在本机的可执行文件通常是 `traex`，以实际 `--help` 为准。
   默认直接使用命令名 `codex`、`claude`、`traex`，通过后台进程的 `PATH` 查找。不要把 `which` / `command -v` 的结果或桌面 App 内置可执行文件路径写成默认配置。只有用户显式配置时，才用 `--backend-command` 或 `backends.<name>.command` 覆盖。
4. 使用非默认 `lark-cli` profile 时的 profile 名称。
5. 需要群聊时，事件正文里可识别的机器人 mention 文本。
6. 需要 AI 会话路由时，确认一个独立路由目录；业务目标仍使用上述用户指定工作区。不要把维护者个人路径、项目名或旧仓库的硬编码路由复制到模板。

不要把 app secret、token、cookie 写进 Skill 或 Router 配置。工作区缺失时向用户询问，不能猜测；owner 必须从 CLI 验证取得，不能使用 bot 身份。

如果用户还没有完成飞书应用、事件或 bot 权限配置，先读 `references/prerequisites.md`。Bot 身份缺权限时应按错误里的 `missing_scopes` 和 `console_url` 引导开发者后台开通，不能对 bot 执行用户 `auth login`。

## 核心工作流

### 1. 只读检查

先查看当前状态；配置不存在时再进入初始化：

```bash
node "$SKILL_ROOT/scripts/router.mjs" status --json
node "$SKILL_ROOT/scripts/router.mjs" doctor --json
```

`status` 因未运行返回非零不等于故障。配置不存在也属于首次安装的正常分支。

### 2. 初始化

配置结构或非默认后台需要调整时，先读 `references/configuration.md`。

```bash
node "$SKILL_ROOT/scripts/router.mjs" init \
  --workspace 'main=/absolute/path/to/project' \
  --backend codex
```

`--sender-id` 是可选身份断言，只能匹配 CLI 本人。可重复传 `--workspace`、`--bot-open-id` 和 `--mention-token`。群聊优先使用事件 `mentions` 中的 bot open_id。已有配置默认拒绝覆盖；只有用户明确同意覆盖时才能增加 `--force`。

macOS 首次 `init` 默认执行 doctor、安装并启动 LaunchAgent；后续登录自动恢复，异常退出会重启。仅生成配置或非 macOS 使用 `--no-autostart`。安装或启动失败须明确报告，不能视为接通。系统重启后须登录该用户，睡眠期间不能处理消息。代码安装位置须保持稳定。

旧配置用 `bind-owner` 验证并绑定 owner，保留工作区与后台；再用 `service-install` 安装自动启动。旧白名单的其他用户不会自动获得权限。

启用 AI 会话路由时，在上述 init 命令中增加 `--router-dir '/absolute/path/to/router-entry'`。Runtime 会从 `assets/router-AGENTS.md` 生成该目录的 `AGENTS.md`，已有文件保留。目标目录仍由 `--workspace` 指定。`--backend traex` 选择 TRAE CLI。旧配置迁移只添加 `routing` 字段并将通用模板复制到尚不存在的 AGENTS.md，不要用 `init --force` 重置整份配置。

初始化后必须运行：

```bash
node "$SKILL_ROOT/scripts/router.mjs" doctor
```

修复所有 `FAIL` 再启动。`WARN` 要解释影响，不能静默忽略 `unsafe_permission_mode`。

### 3. 启动和真实验证

启动会创建本机常驻进程并开始消费、回复飞书消息。用户已明确要求“安装并启动/接通”可视为授权；否则先说明影响并确认。

```bash
node "$SKILL_ROOT/scripts/router.mjs" start
node "$SKILL_ROOT/scripts/router.mjs" status
```

命令成功只证明本地进程存在。必须让允许用户在飞书向机器人发送 `/ping`，并看到 `pong`；日志还必须出现带 `replyMessageId` 的 `reply_succeeded`，才算端到端接通。

AI 会话路由还需真实发送一个新话题、一个独立话题和对第一个话题的追问，核对 `route_selected` 与 `routing-sessions.json` 的 ID，证明续接了正确会话。模拟 CLI 测试、仅生成 AGENTS.md 或 `/ping` 成功均不证明模型会话路由已跑通。

### 4. 使用方式

飞书控制命令：

访客只能调用 `/help`、`/ping`、`/status`、`/cancel`；访客 `/help` 仅显示这四项，不能发起任务。owner 使用 `/guest add <open_id> <ISO到期时间>` 添加或续期、`/guest remove <open_id>` 撤销。到期时间必须带时区且在未来，例如 `2030-01-01T18:00:00+08:00`。陌生人和过期访客的消息直接忽略。owner 的 `/help` 还显示唯一 owner、访客白名单及到期时间。

`/help` 显示当前后台、模型配置、工作区别名及实际目录、路由目录、配置文件、状态与日志路径、超时和队列上限，并列出可用后台和工作目录。只展示明确选择的配置字段，不输出凭据、环境变量值或后台参数。普通接收、排队和 `/status` 提示仅显示任务状态与数量。

```text
/help
/status
/cancel
/backend list
/backend <name>
/workspace list
/workspace <alias>
/confirm <完整高风险请求>
```

消息只能选择配置中已有的 workspace alias 和 backend。不要通过正文接受任意本地路径或任意 shell 命令作为后台配置。

### 5. 诊断

遇到问题时读取 `references/troubleshooting.md`，按以下顺序定位：

1. `doctor` 的配置、目录和命令检查。
2. `status` 中 Router、consumer、backend、workspace 和队列状态。
3. `logs` 返回的 bridge/daemon 路径。
4. 飞书 `/ping` 的真实回环。
5. 具体 job 目录中的 stdout/stderr。

不要用“进程在运行”代替飞书回复成功，也不要把后台 Agent 成功误判为飞书回复成功。

### 6. 停止

停止会中断当前任务并停止消费新消息，执行前确认用户意图：

```bash
node "$SKILL_ROOT/scripts/router.mjs" stop
```

`stop` 会禁用已安装的登录自动启动并卸载当前服务，避免 KeepAlive 立刻拉起；`start` 重新启用。`service-status` 查看安装与加载状态。自动启动目前内置支持 macOS，需网络与 CLI 用户登录有效。

普通停止超时后，说明仍存活的已验证 Router 实例，并检查 `lark-cli event status`。无法验证 lock/instance/进程命令时不能仅凭 PID 发信号。不要用 `SIGKILL` 强杀事件消费者，否则可能跳过取消订阅并留下服务端孤儿订阅。

## 配置变更规则

- 修改 sender、workspace、backend 或安全选项前读 `references/configuration.md`。
- 涉及权限、`/confirm`、日志和远程写操作时读 `references/security-model.md`。
- 多 sender 的 workspace/backend 选择按 sender 隔离；`/cancel` 只能取消本人任务。多 sender 或多 workspace 配置禁止 Codex resume 和 Claude continue。
- AI 路由模式由 Runtime 按 sender、chat、workspace 和 backend 登记明确会话 ID；不要手工配置固定 resume/continue，也不要从全机历史导入其他会话。旧直连模式的固定会话限制仍然生效。
- 后台默认只继承最小基础环境；需要额外变量时用 `envAllowlist` 逐项声明，并检查 `doctor` 只展示的变量名。
- 保留用户已有配置，只做请求范围内的最小修改。
- 修改后重新运行 `doctor`；影响事件消费或 backend 的变更需要重启并重新 `/ping`。
- 共享示例只能使用占位符和脱敏路径。

## 结果输出

执行类任务返回：

```markdown
## 已完成
- 配置位置、运行状态、当前 backend/workspace

## 验证结果
- doctor 结果
- 飞书 /ping 是否完成真实回环

## 使用方式
- 常用飞书命令

## 风险与限制
- 未验证项、日志路径、停止方式
```

诊断类任务返回“结论、关键证据、失败层级、建议动作”，区分 Router、本地 Agent 和飞书回复三个阶段。
