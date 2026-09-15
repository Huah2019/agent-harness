# 配置说明

## 路径

配置路径按优先级选择：

1. 命令行 `--config <path>`。
2. 环境变量 `FEISHU_AGENT_ROUTER_CONFIG`。
3. `$XDG_CONFIG_HOME/feishu-agent-router/config.json`。
4. `~/.config/feishu-agent-router/config.json`。

状态和日志默认位于 `$XDG_STATE_HOME/feishu-agent-router`，未设置 XDG 时使用 `~/.local/state/feishu-agent-router`。可通过 `runtime.stateDir` 改成其他绝对路径。

真实配置、状态和实际路由入口必须放在 Skill 所在 Git 仓库外；独立安装时也不能放入 Skill 目录。Runtime 解析真实路径，拒绝通过软链接把这些私人目录指回分发目录。推荐 `routing.directory` 使用 `~/.local/share/feishu-agent-router/entry` 对应的绝对路径（可选其他仓库外目录）。该检查不会修改旧配置；遇到 `private_path_in_distribution` 时，将私人文件迁到仓库外并更新相应路径，再启动。

## 后台命令默认值与覆盖

Codex、Claude Code、Traex CLI 默认分别执行 `codex`、`claude`、`traex`，通过后台进程继承的 `PATH` 查找，不绑定安装目录。即使后台使用自定义别名，缺省命令也按 `type` 选择。

用户可通过初始化参数 `--backend-command <命令名或绝对路径>` 或 `backends.<name>.command` 显式覆盖，例如 Claude 的 `aiden` 包装。保留显式覆盖，不自动把命令名改写成探测到的绝对路径。

macOS LaunchAgent 保存安装服务时的 `PATH`；已有服务重复执行 `service-install` 不会改写 plist。新增 CLI 安装目录后，应核对 `service-status` 返回的私人 plist，备份后更新其 `EnvironmentVariables.PATH` 并重启服务，或按用户意图重新安装服务；不要仅执行 `service-install` 就宣称 PATH 已更新。找不到命令时，先检查后台 `PATH`，也可显式配置完整路径。

## 字段

| 字段 | 说明 |
|---|---|
| `version` | 当前固定为 `1` |
| `access.ownerId` | 唯一 owner 的 open_id，初始化从 CLI 用户身份验证取得 |
| `access.ownerLabel` | 展示名称；启动时尝试刷新企业邮箱账号和姓名，查询不可用时回退；不用于授权 |
| `allowedSenderIds` | 旧配置兼容字段，单个 ID 可作为待验证 owner；有 access.ownerId 时不再用于授权 |
| `defaultWorkspace` | 默认工作区别名，必须存在于 `workspaces` |
| `workspaces` | 别名到绝对目录的映射 |
| `activeBackend` | 默认后台名，必须存在于 `backends` |
| `backends` | 后台名到 adapter 配置的映射 |
| `routing.mode` | `direct`（缺省兼容旧配置）或 `agent`（AI 选择工作会话） |
| `routing.directory` | `agent` 模式的独立通用路由目录绝对路径，包含 AGENTS.md |
| `lark.command` | `lark-cli` 命令名或绝对路径 |
| `lark.profile` | 可选 profile，空字符串表示默认 profile |
| `group.requireMention` | 群聊是否必须包含 mention token |
| `group.mentionTokens` | 从正文识别和移除的机器人 mention 文本 |
| `group.mentionIds` | 从事件 `mentions[].id` 识别机器人的 open_id，群聊首选 |
| `reply.inThread` | 是否在线程中回复 |
| `reply.maxChars` | 飞书回复最大字符数，最小 500 |
| `reply.maxAttempts` | 单次回复最多尝试次数，默认 3 |
| `reply.commandTimeoutSeconds` | 单次 `lark-cli` 回复命令超时，默认 15 秒 |
| `reply.concurrency` | 同时运行的 `lark-cli` 回复子进程上限，默认 2 |
| `reply.pendingLimit` | 等待回复信号量的请求上限，默认 20；满时触发背压，不再创建子进程 |
| `safety.confirmPrefix` | 高风险请求显式确认前缀，默认 `/confirm`，不能关闭 |
| `runtime.queueLimit` | 排队中和运行中的任务上限 |
| `runtime.outboxLimit` | 全部未完成任务和待回复结果的硬上限，默认 100 |
| `runtime.maxIncomingChars` | 单条入站文本上限，默认 20000 字符 |
| `runtime.taskTimeoutSeconds` | 单任务超时，最小 30 秒 |
| `runtime.startupTimeoutSeconds` | 等待 event consumer ready 的最长秒数 |
| `runtime.maxEventAgeSeconds` | 拒绝超过该年龄的重投事件，默认 1 天 |
| `runtime.dedupeLimit` | TTL 去重账本的硬容量，默认 10000；满时停止接收，不淘汰仍受保护的 ID |
| `runtime.consumerStableResetSeconds` | consumer 连续稳定多久后才重置重启退避，默认 30 秒 |

配置文件不保存飞书 app secret 或 access token，bot 身份由 `lark-cli` 的本机配置提供。

## AI 会话路由

用户的目录映射由配置文件决定；通用 AGENTS.md 不写维护者或用户的个人路径：

```json
{
  "routing": { "mode": "agent", "directory": "/absolute/path/to/router-entry" },
  "defaultWorkspace": "main",
  "workspaces": { "main": "/absolute/path/to/user-project" },
  "activeBackend": "traex",
  "backends": { "traex": { "type": "traex", "command": "traex", "mode": "new", "prefixArgs": [], "envAllowlist": [] } }
}
```

这是配置片段，仍需 sender、lark 等原有配置。`router-entry` 是独立入口；`user-project` 是用户真正想操作的目录。用户可换成本机任意已确认的绝对路径。

首次初始化增加 `--router-dir <绝对路径>`，会创建目录并复制 `assets/router-AGENTS.md`，已有 AGENTS.md 不覆盖。对已有配置，手工添加上述 `routing` 字段，并将模板复制到新路由目录。保持 sender、后台、stateDir 等现有字段；不要覆盖已有自定义规则。

运行链路：

1. 按 sender 的 `/workspace`、`/backend` 选择确定业务目录和后台。
2. 在路由目录新建一次短 Agent 调用，显式输入 AGENTS.md、本轮请求和当前作用域的会话目录。
3. AI 输出 `new + title`、`resume + sessionId` 或 `reply + text`。Runtime 严格校验 JSON；不接受模型指定路径、命令或后台。
4. Runtime 在配置的业务目录新建或恢复明确的工作会话，把原始请求与可信 envelope 传入，保留 `/confirm` 状态。
5. 将 CLI 返回的会话 ID、标题、最近请求和结果摘要记入 `stateDir/routing-sessions.json`，后续路由据此选会话。

路由 AI 每次从账本获取目录，不依赖“最近会话”或路由 Agent 自身的隐式历史。账本按 sender、chat、工作区别名及实际路径、后台名及配置隔离。同一用户在不同群聊不会共用工作会话；切换后台或修改目标路径后，不会恢复旧作用域的会话。只识别由此 Runtime 登记的会话，不自动接管桌面或旧仓库历史。

自然语言可以说“新建一个话题分析 X”“继续刚才的 X”。多个候选无法确定时，路由 Agent 应直接澄清。每个作用域最多 100 个会话，总计 1000；到限需本机归档账本，不静默删除。任务开始恢复前把会话标记 `uncertain`，成功完成后才改回 `ready`；失败或重启遗留的 uncertain 会话禁止自动续接，由本机检查处理。

AI 模式支持 Codex、Claude（含 Aiden 包装）、Traex；generic 无统一会话协议，暂只支持 direct。AI 模式 backend 保持 `mode=new` / `continue=false`，实际 resume 由 Runtime 用经过校验的 ID 动态构建。路由和工作阶段分别适用 `taskTimeoutSeconds`；`/cancel` 取消当前阶段并阻止后续工作阶段。

Codex/Traex 从 `--json` 的 `thread.started.thread_id` 登记会话。Claude 使用显式 `--session-id` 新建和 `--resume` 续接，并核对结果的 `session_id`。缺失会话 ID 不静默假装支持续接，回复会说明限制。

路由阶段 Codex/Traex 使用 `--sandbox read-only`；Claude 禁用内置工具、外部 MCP 和 slash commands。CLI 的本机配置、插件与权限仍需遵循其自身契约，路由提示词本身不是操作系统沙箱。

## 多工作区

```json
{
  "defaultWorkspace": "project-a",
  "workspaces": {
    "project-a": "/Users/example/Work/project-a",
    "project-b": "/Users/example/Work/project-b"
  }
}
```

飞书使用 `/workspace project-b` 切换。Router 不接受正文中的新路径，必须先由本机用户修改配置。

多允许用户时，每个 sender 分别保存 workspace/backend 选择；一个用户的切换不会改变另一个用户已经入队或后续任务的位置。`/cancel` 也只能取消发送者自己的当前任务。

## Codex

```json
{
  "type": "codex",
  "command": "codex",
  "prefixArgs": [],
  "envAllowlist": [],
  "mode": "new"
}
```

默认每条消息使用 `codex exec -C <workspace>` 新建执行。只有明确需要固定会话并确认不会跨用户、跨工作区污染时，才使用：

```json
{
  "type": "codex",
  "command": "codex",
  "mode": "resume",
  "sessionId": "fixed-session-id"
}
```

## Claude

直接使用 Claude CLI：

```json
{
  "type": "claude",
  "command": "claude",
  "prefixArgs": [],
  "continue": false,
  "outputFormat": "json"
}
```

通过 Aiden 包装：

```json
{
  "type": "claude",
  "command": "aiden",
  "prefixArgs": ["x", "claude"],
  "model": "your-model-name",
  "continue": false,
  "outputFormat": "json"
}
```

官方 `claude` 后台使用 `command: "claude"`，不要用 Aiden 包装替代。需要同时提供包装版时，使用独立后端别名，例如：

```json
{
  "backends": {
    "claude": { "type": "claude", "command": "claude", "prefixArgs": [], "continue": false, "outputFormat": "json" },
    "adien_claude": { "type": "claude", "command": "aiden", "prefixArgs": ["x", "claude"], "continue": false, "outputFormat": "json" },
    "adien_codex": { "type": "codex", "command": "aiden", "prefixArgs": ["x", "codex"], "mode": "new" }
  }
}
```

这里的 `adien_*` 是可选择的后台别名，实际包装命令仍是 `aiden`；按 `type` 使用对应 CLI 协议。包装版的模型配置独立保存，不复制给官方后台。

共享配置默认不设置 `permissionMode`。Router 会拒绝带 `bypassPermissions` 或等价危险参数的配置；确需宽松模式时只能脱离远程 Router 在本机直接运行并单独评估风险。

Router 会拒绝 `permissionMode` 或参数中的权限绕过模式。多 sender 或多 workspace 配置同时拒绝 Claude `continue=true` 和 Codex `mode=resume`，避免跨用户、跨仓库复用上下文。

## 后台环境变量

后台 Agent 不继承 Router 的完整环境，只保留 `PATH`、`HOME`、locale、临时目录和 XDG 等最小基础变量。确需 API key 等变量时，由机器所有者在对应 backend 中按变量名显式声明：

```json
{
  "envAllowlist": ["OPENAI_API_KEY"]
}
```

配置只保存变量名，不保存值。`doctor` 会展示透传的变量名，并对疑似 secret/token 的名称给出警告。优先使用 CLI 自身的本机认证文件，不要把飞书凭据透传给后台。

## Traex CLI

`traex-cli` 使用本机 `traex` 可执行文件，可通过 `--backend-command` 指定其他安装路径：

```json
{
  "type": "traex",
  "command": "traex",
  "prefixArgs": [],
  "envAllowlist": [],
  "mode": "new"
}
```

调用 `traex exec -C <workspace> -c 'permission_mode="custom"' -c 'approval_policy="never"' -c 'sandbox_mode="workspace-write"' --output-last-message <file> -`，prompt 通过 stdin 传入。恢复时使用 `traex exec resume ... <sessionId> -` 和明确的子进程 cwd。支持可选 `model`；`permissionMode` 缺省、`default` 或 `custom` 均映射到上述非交互受限策略，`plan` 使用只读模式。Traex exec 不支持交互式 default/auto；不要仅凭 --help 显示该值就直接传入。权限请求无法交互批准时返回失败，不添加绕过参数。

接入前检查实际安装的 `traex exec --help` 与 `traex exec resume --help`；不同发行版本可能不兼容。命令存在和帮助参数通过不代表模型登录有效或业务执行成功。

直连模式的固定 `mode=resume` / `sessionId` 与 Codex 一样只适用于单 sender、单 workspace。AI 模式保持 `mode=new`，会话由 Runtime 管理。

## Generic CLI

适用于从 stdin 读取 prompt、从 stdout 返回结果的 CLI：

```json
{
  "type": "generic",
  "command": "/absolute/path/to/agent-cli",
  "prefixArgs": ["run"],
  "envAllowlist": [],
  "args": ["--format", "text"],
  "outputMode": "text"
}
```

`outputMode` 可选：

- `text`：把 stdout 作为最终回复。
- `json-result`：解析 stdout JSON 的 `result` 或 `content` 字段。

所有命令和参数都来自本机静态配置，不从飞书消息动态拼接。

## 配置变更后的验证

```bash
node "$SKILL_ROOT/scripts/router.mjs" doctor
node "$SKILL_ROOT/scripts/router.mjs" stop
node "$SKILL_ROOT/scripts/router.mjs" start
node "$SKILL_ROOT/scripts/router.mjs" status
```

然后在飞书执行 `/ping`。若新增 backend 或 workspace，再分别执行 `/backend list`、`/workspace list` 并切换验证。

## Owner、访客与自动启动

access.ownerId 由 init 从飞书 CLI 已验证用户取得。allowedSenderIds 仅兼容旧配置，不再授予多人执行权限。旧配置运行 bind-owner 保留业务配置并绑定 CLI 本人，不能通过远程消息更换 owner。

访客仅由 owner 在飞书使用 /guest add <open_id> <ISO到期时间> 添加/续期，/guest remove <open_id> 撤销。到期时间必须带时区且在未来。访客仅有 /help、/ping、/status、/cancel 权限。记录保存在 runtime.stateDir/access-guests.json，启动检查 owner 绑定，每条消息检查有效期。

macOS init 默认安装并启动用户 LaunchAgent；--no-autostart 仅创建配置。service-install 为已有配置安装，service-status 查看状态。同名其他配置不会被覆盖。stop 同时禁用自动启动，start 重新启用。重启后须登录 macOS 用户、网络可用、CLI 用户登录有效；不是未登录时启动，也无法在睡眠中处理消息。其他系统暂未内置自动启动安装器。
