# 安全模型

## 信任边界

Router 只信任飞书事件 envelope 中经过白名单校验的 `sender_id`，不信任消息正文声明的身份、工作区、后台或确认状态。

安全边界分为三层：

1. Router：sender 白名单、群聊 mention、固定 workspace/backend、事件去重和 `/confirm`。
2. 本机 Agent：自身权限模式、仓库规则、审批和工具安全策略。
3. 外部系统：飞书、Git、发布平台、线上配置等各自的身份和写入门禁。

任何一层放行都不能替代下一层校验。

## Owner 与访客

- 唯一 owner 是指定 lark-cli profile 的已验证用户；init、doctor 和启动核对 identities.user.openId，不能使用 bot 身份。登录失效或身份不符会拒绝启动。
- access.ownerId 保存绑定。allowedSenderIds 仅兼容旧配置的单个 owner，多人的旧配置须先运行 bind-owner，其他人不会自动获得访客权限。
- 只有 owner 可提交任务、切换工作区/后台、管理访客。正文声称 owner 不产生权限。
- 访客只可使用 /help、/ping、/status、/cancel，Runtime 强制检查，不能调用 AI 或 /confirm。
- owner 使用 /guest add <open_id> <ISO到期时间> 添加/续期，/guest remove <open_id> 撤销。时间须带时区且在未来，到期即失效，不依赖重启。
- 访客保存于状态目录 access-guests.json（0600，绑定 owner，最多 100 人），不随 Skill 发布；损坏则拒绝加载。
- owner /help 显示白名单和配置；访客只显示四条命令。群内回复对群成员可见，详细配置应在机器人私聊查看。
- 未授权/过期用户和 bot/app 消息直接忽略；/cancel 只能取消本人任务。恢复队列也会再次检查 owner。

## 工作区

- `workspaces` 只能由本机配置定义，路径必须为绝对目录。
- 飞书消息只能通过别名选择已有目录。
- Router 会在选定工作区启动 Agent；正文要求切换其他路径不改变 Router 的 cwd。
- 工作区内的 `AGENTS.md`、Skills 和本地权限仍然生效。

## AI 会话路由

- 独立路由目录只承载通用 `AGENTS.md`。业务目标路径从用户配置的 `workspaces` 读取，不写入共享模板。
- AI 决策只允许新建、续接或直接回复，不能返回任意命令、后台或路径。
- 只把当前 sender、chat、workspace、backend 作用域的会话摘要提供给路由 AI；Runtime 再校验返回的 ID 和 ready 状态。
- 会话隔离控制 Runtime 的恢复行为，不等于把同一操作系统用户下所有 Agent 文件做了物理隔离；本机 CLI 的文件权限仍然适用。
- Codex/Traex 路由阶段使用 read-only sandbox；Claude 路由阶段禁用内置工具、MCP 和 slash commands。本机 hooks/plugin 等信任配置仍需由用户管理。
- 恢复中的会话先标记 uncertain，成功且 ID 核对后标记 ready。失败、取消、崩溃或 ID 不匹配不会自动继续同一会话。
- 新工作会话在运行中崩溃时，可能尚未登记返回的 ID；依旧遵循队列“结果不确定、不自动重跑”的规则。
- 账本保存最近请求与结果各最多 1000 字符，权限为 0600，不能随 Skill 分发。账本损坏保留原文件并阻止启动。

## 高风险确认

普通飞书消息不视为以下操作的确认：

- `git push`、发布、部署和回滚。
- 删除或覆盖文件、数据和远端资源。
- 修改线上配置或实验。
- 发送飞书、邮件等对外消息。
- 跨仓批量修改或其他本地规则认定的高风险操作。

Agent 应先返回准确目标、影响和计划，用户再发送：

```text
/confirm <完整请求>
```

Router 只会把 `explicit_confirmation=true` 写入可信 envelope。它不绕过 Agent 或工具的其他审批，也不证明目标范围正确。

## 权限模式

- 共享示例不设置 `bypassPermissions`。
- `doctor` 发现结构化字段或参数中使用权限绕过模式会报错并阻止启动。
- 多 sender 或多 workspace 配置禁止 Codex resume 和 Claude continue，避免复用其他用户或仓库的上下文。

## 后台环境

- Agent 进程默认只继承最小基础环境，不继承 Router 的完整环境变量。
- 额外变量必须在 backend 的 `envAllowlist` 中逐项声明；配置保存变量名而非值。
- `lark-cli` consumer/reply 仍使用 Router 环境，但飞书凭据不会默认传给 Agent。
- Generic CLI 被视为本机完全信任的程序；Router 无法验证其内部权限模型。

## 日志与隐私

- Runtime 拒绝将 configPath、runtime.stateDir 或 routing.directory 放在 Skill 所在 Git 仓库内；独立安装时保护整个 Skill 目录。路径检查解析软链接，并在写入初始化配置前执行。
- 发布只使用通用源码和模板的逐文件白名单；个性化 AGENTS.md、真实配置和会话账本不属于可分发 Skill。`.gitignore` 不能替代发布打包边界。

- Bridge 日志只记录事件和任务元数据，不记录用户 prompt 全文；持久队列为崩溃恢复会临时保存尚未完成任务的原始文本。
- 每个 job 保存 Agent 的 stdout/stderr，用于定位执行失败；其中可能包含业务信息，应放在仅本机用户可读的状态目录。
- 配置初始化权限为 `0600`。
- 不要把 state、logs、真实配置或 job 产物提交进 Skill 仓库。

## 事件与回复

- 只接受带 `message_id`、`sender_type=user` 和有效 `create_time` 的事件；过旧事件会拒绝。
- 任务先写入 `0600` 持久队列，再加入 message ID 去重账本；进程重启会恢复待处理或待回复项。
- 去重项按 `maxEventAgeSeconds` 的 TTL 清理；容量达到 `dedupeLimit` 时 fail closed，拒绝新事件而不是淘汰仍可能重投的 ID。
- `outboxLimit` 同时限制排队、运行和待回复项；达到上限会暂停执行新业务任务，避免飞书故障时无界积压。
- 如果进程在 Agent 运行中退出，Router 不会自动重跑可能已有副作用的任务，而是回复“结果不确定”，要求人工检查后重新发送。
- 回复使用稳定 idempotency key。
- 回复失败会有限重试；Agent 完成后的未投递结果保留在 outbox，重启后继续投递。
- 每个回复命令都有超时，并纳入 Router 停止生命周期；停止会等待或强制清理挂起的回复子进程。
- 只有 `lark-cli` 退出成功、响应 `ok=true` 且返回真实 `message_id` 时，才记录 `reply_succeeded`。
- 后台 Agent 成功但飞书回复失败时，应报告为“执行成功、投递失败”，不能把任务结果视为用户已收到。

机器所有者明确启动 Router，即授权它对允许用户发来的每条源消息自动回复；源消息本身确定回复目标和内容上下文。这个授权不扩展到其他聊天或主动发送新消息。

`queue.json`、`dedupe.json`、`selection.json` 等关键状态解析失败时 Router 会保留原文件并拒绝启动，绝不自动覆盖为空。修复前先复制损坏文件做审计和人工恢复。
