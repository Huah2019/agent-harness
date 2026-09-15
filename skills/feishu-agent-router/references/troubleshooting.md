# 故障排查

## 先跑四个命令

```bash
node "$SKILL_ROOT/scripts/router.mjs" doctor
node "$SKILL_ROOT/scripts/router.mjs" status --json
node "$SKILL_ROOT/scripts/router.mjs" logs
node "$SKILL_ROOT/scripts/router.mjs" print-config
```

`print-config` 默认会脱敏 sender open_id。

## Router 启动失败

检查顺序：

1. 配置 JSON 是否可解析。
2. 默认 workspace 和 active backend 是否存在。
3. `lark-cli`、后台 CLI 是否在 `PATH` 或配置为有效绝对路径。
4. 是否已有身份可验证的 Router lock；不能只凭 PID 判断。
5. daemon stderr 是否存在 Node 异常。

`start` 会在 `doctor` 有 `FAIL` 时拒绝启动。不要直接绕过检查运行 `bridge.mjs`。

## Router 在运行但收不到消息

查看 `status.consumer`：

- `ready`：事件消费者已经报告 ready，继续检查 sender、消息类型和 mention。
- `starting`：短暂等待后再查；持续不变时看 daemon stderr。
- `restarting`：`lark-cli event consume` 反复退出，通常是 bot 配置、权限、网络或命令版本问题。
- `stop_blocked`：consumer 在 stdin EOF 和 SIGTERM 后仍未退出；Router 为避免孤儿订阅没有使用 SIGKILL。

`status.lastConsumerError` 会保留结构化的 `type`、`subtype`、`missingScopes` 和 `hint`。权限错误按这些字段处理，不要用错误文案做正则判断；bot 缺 scope 时去开发者后台开通，不要执行用户 `auth login`。

Bridge 日志中的 `event_ignored.reason`：

| reason | 含义 |
|---|---|
| `sender_not_allowed` | sender 不在白名单 |
| `sender_not_user` | sender_type 不是 user，通常是 bot/app 消息 |
| `unsupported_message_type` | 不是 text/post |
| `empty_text` | 没有提取到可执行文本 |
| `duplicate_event` | 飞书重投，已去重 |
| `dedupe_capacity_full` | TTL 去重账本达到硬上限；Router fail closed，等待过期或由机器所有者评估后提高容量 |
| `invalid_create_time` / `stale_event` | 事件缺少有效时间或超过允许重投窗口 |
| `message_too_large` | 入站文本超过 `runtime.maxIncomingChars` |
| `group_mention_missing` | 群聊缺少配置的 mention token |

先用允许用户私聊 `/ping`，把群聊 mention 问题与 bot 事件问题分开。

## 收到消息但 Agent 没运行

1. `/status` 检查是否有长任务占用和队列长度。
2. 查看 `assistant_start` 后是否出现 spawn error。
3. 检查当前 `/backend`、`/workspace`。
4. 查看 job 目录下的 `stderr.log`。
5. 检查单任务是否触发 `assistant_timeout`。

Router 串行执行任务；忙时排队属于预期行为。

任务队列和待回复结果保存在 state 目录的 `queue.json`。`status.replyPending>0` 表示 Agent 已有结果但飞书投递仍在重试；重启后会立即继续投递。若日志出现“执行结果不确定”，表示上次进程在 Agent 运行中退出，Router 为避免重复副作用没有自动重跑。

`status.outboxBackpressure=true` 时，全部未完成项已达到 `runtime.outboxLimit`，Router 会停止执行新业务任务，优先恢复飞书投递。不要直接删除 queue；先恢复 bot 回复权限/网络，让 outbox 排空。

若 `doctor` 报 `runtime_*_corrupt`，关键账本已损坏。Router 会保留原文件并拒绝启动：先复制损坏文件和同目录 job 日志，人工恢复合法 JSON 或在明确接受丢失去重/任务记录后移走该单个文件，不能批量清空 state。

## Agent 成功但飞书没有回复

查 Bridge 日志：

- `reply_succeeded` 且包含 `replyMessageId`：Router 已拿到真实飞书消息 ID。
- `reply_failed reason=invalid_json`：`lark-cli` 输出不是预期 JSON。
- `reply_failed reason=lark_not_ok`：OpenAPI 或 shortcut 返回失败。
- `reply_failed reason=missing_message_id`：命令退出成功但没有可验证的持久化消息结果。
- `reply_failed reason=exit_code_-2`：单次 `lark-cli` 回复超过 `reply.commandTimeoutSeconds`，进程树已进入终止流程。

不要只看后台 job 的 `last-message.md` 或 stdout；它们只能证明 Agent 产出了文本。

## 工作区或后台不正确

```text
/workspace list
/workspace <alias>
/backend list
/backend <name>
```

选择按 sender 保存在本机 state 目录，只影响该 sender 后续入队的任务；已入队任务使用接收时快照。修改配置删除当前 alias/backend 后，重启时会回退到默认值。

## 安全确认没有生效

- 普通消息 envelope 中 `explicit_confirmation=false`。
- 只有消息以配置的 `/confirm ` 开头且后面有完整请求，才会置为 `true`。
- `/confirm` 空请求会直接返回用法提示，不会启动 Agent。
- 本机 Agent 仍可能因为权限、仓库规则或目标不清拒绝操作，这是正确行为。

## 停止受阻

`consumer=stop_blocked` 表示 event consumer 在 stdin EOF 和 SIGTERM 后仍未退出。先运行 `lark-cli event status --json --fail-on-orphan`，再按结构化提示使用 `lark-cli event stop` 解除消费者；consumer 随后退出时 Bridge 会自动释放 PID/lock 并结束。不要对真实 consumer 使用 `kill -9`。
