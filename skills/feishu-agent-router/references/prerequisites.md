# 飞书与本机前置条件

## 本机

- Node.js 18 或更高版本。
- macOS 或 Linux（含 WSL）。原生 Windows 暂不支持，因为 Runtime 不能保证取消/超时时完整终止 Agent 子进程树，`doctor` 会阻止启动。
- `lark-cli` 1.0.84 或更高版本，且已完成应用配置。该最低版本用于保证 ready marker、stdin 生命周期、结构化错误和 reply message ID 契约。
- 至少一个可从 stdin 读取 prompt 的后台：Codex、Claude 或 Generic CLI。
- 预配置工作区存在，且当前本机用户有权访问。

Router 不安装或保管飞书 app secret。首次配置 `lark-cli` 应按其认证流程完成，禁止把 secret 打印到终端输出或写进 Skill 目录。

## 飞书应用

应用需要：

1. 启用机器人能力。
2. 在开发者后台订阅事件 `im.message.receive_v1`。
3. 开通接收消息所需 scope。以本机以下命令返回的 `scopes` 为准：

   ```bash
   lark-cli event schema im.message.receive_v1 --json
   ```

   当前 schema 的基础只读 scope 为 `im:message.p2p_msg:readonly`。群聊等额外模式如返回 `missing_scopes`，按错误提供的最小 scope 在开发者后台开通。

4. 开通 bot 回复所需 `im:message:send_as_bot`。
5. 需要群聊时，把 bot 加入目标群，并配置 `group.mentionIds` 或 `group.mentionTokens`。

Bot 使用 tenant access token，不需要也不应该执行用户 `auth login`。缺少 bot scope 时，使用错误中的 `console_url` 进入开发者后台处理。

## Open ID

`allowedSenderIds` 使用用户 `ou_...` open_id，不使用用户名、user_id、union_id 或群 ID。Router 从 `im.message.receive_v1` 的 `sender_id` 获取该值。

Router 同时要求事件 `sender_type=user`，并拒绝 bot/app sender。bot 自己的 open_id 不能同时出现在 `allowedSenderIds` 和 `group.mentionIds`。

群聊建议把 bot 自己的 open_id 配置到 `group.mentionIds`，Router 会匹配事件的 `mentions[].id`；文本 `mentionTokens` 只用于兼容或兜底。

## 启动前检查

```bash
node "$SKILL_ROOT/scripts/router.mjs" doctor
lark-cli event status --json --fail-on-orphan
```

如果 event bus 存在孤儿或冲突订阅，先按 `lark-cli event status` 的结构化提示处理。停止消费者优先使用 SIGTERM、关闭 stdin 或 `lark-cli event stop`；不要 `kill -9`，否则可能跳过服务端取消订阅。

## 端到端验收

1. `router start` 必须等到 consumer 状态为 `ready` 才返回成功。
2. 允许用户私聊 bot 发送 `/ping`。
3. 用户看到 `pong`。
4. Bridge 日志出现带 `replyMessageId` 的 `reply_succeeded`。

四项缺一不可。进程存在、事件 ready、后台有输出都不能单独证明用户收到结果。
