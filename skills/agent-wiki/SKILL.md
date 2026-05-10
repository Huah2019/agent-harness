---
name: agent-wiki
description: agent知识库。当 agent 需要查阅项目知识、搜索历史经验、增量修改或校验知识条目时调用。所有知识库文件操作必须通过本 skill 的 Go CLI,不得直接读写知识库文件。
---

# agent-wiki — 知识库操作规范

本 skill 定义 LLM 操作知识库的**唯一**正确方式。核心原则是:

> agent 不直接操作知识库文件,只通过本 skill 内的 Go CLI 访问绑定目录。

底层仍是 Markdown 文件,但读取、修改、目录 meta 与上下文刷新都由 CLI 统一处理。skill 目录只保存使用协议和 CLI,不保存知识库数据。

## 1. 知识沉淀边界

知识库用于维护会影响 agent 后续判断和行动的项目记忆,不是把项目里的所有信息搬进 Markdown。目录结构可以按项目自然演进,不要把某一套分类写死;真正稳定的是判断标准。

适合沉淀的内容:

- 项目定位、边界和长期目标:例如这个仓库承担什么、不承担什么。
- 核心设计判断和取舍:尤其是代码或 README 里看不出原因的决定。
- 可复用工作流和验证路径:下次 agent 进来应该先看什么、改完跑什么、如何收尾。
- 常见坑、排查入口和禁止事项:能避免未来重复踩坑的信息。
- 演进队列和阶段性优先级:帮助 agent 知道项目接下来应该怎么持续变好。
- 已废弃方案和反例:防止后续工作又绕回已否定的方向。

不适合沉淀的内容:

- 可以直接从代码、测试、README 或命令输出稳定获得的普通实现细节。
- 一次性任务流水账、临时状态、无复用价值的聊天总结。
- 尚未验证的猜测,除非明确标注为假设和验证方式。
- 大段复制外部文档或日志;只记录项目相关结论、来源和下一步动作。
- 只为了“存下来”而写的目录或条目;每条知识都应该能改变下次 agent 的行为。

任务结束时,agent 应做一次轻量反思:本次是否产生了新的长期判断、常见坑、验证流程、演进方向或废弃方案。如果没有,不要强行更新知识库;如果有,必须通过本 skill 的 CLI 写入或修改,并运行 `check`。

## 2. 存储结构

知识库存储结构:

```
wiki/
├── .meta.yaml           # 根目录描述,供 map/context 动态扫描
├── AGENT_CONTEXT.md     # 根上下文:一级目录 + 有用反馈 Top 20 + 最近 Top 10
├── <category>/
│   ├── .meta.yaml       # 目录描述,供 map/context 动态扫描
│   ├── <topic>.md       # 单条原子知识
│   └── <subcategory>/
│       └── .meta.yaml
└── ...
```

**不变量**

- 一个 md 文件 = 一条原子知识,严禁多主题混写。
- 每个目录都**必须**有 `.meta.yaml`。
- 目录说明来自该目录 `.meta.yaml` 的 `summary`。
- 文件名使用 `kebab-case.md`,语义清晰,不要在文件名中塞日期或 ID。

## 3. 目录 meta 与知识 frontmatter

目录 `.meta.yaml`:

```yaml
id: <目录 slug>
title: <人类可读名称>
summary: <一句话目录说明,供 map/context 展示>
```

知识文件 frontmatter:

```markdown
---
id: <kebab-case 的 slug,在所属目录内唯一>
title: <人类可读标题>
created: YYYY-MM-DD
updated: YYYY-MM-DD
used_count: 0
last_used: YYYY-MM-DD # 可选,由 use 自动维护
last_used_reason: <最近一次有用反馈原因> # 可选,由 use 自动维护
context_mode: summary | digest | inline | hidden # 可选,预留给上下文展开策略
summary: <一句话摘要,≤ 120 字符,供 map/context 展示>
---

# <标题>

<正文>
```

要求:
- 目录 `summary` 是目录在 `map` / `AGENT_CONTEXT.md` 中展示的唯一权威来源。
- 知识 `summary` 是条目在 `map` / `AGENT_CONTEXT.md` 中展示的唯一权威来源。
- `id` 是知识的稳定身份,移动文件时不得改变。
- `used_count` / `last_used` / `last_used_reason` 记录在知识自身 frontmatter 中。
- 内容变更后 CLI 会刷新 `updated`。

## 4. CLI 入口

在 workspace 内使用本 skill 时,使用当前 workspace 中本 skill 自带的 CLI 包装脚本。它会自动绑定本 skill 自带的知识库,不要传知识库路径。

```bash
./.agents/skills/agent-wiki/bin/agent-wiki <command>
```

不要使用裸命令 `agent-wiki`;当前 workspace 不保证它在 `PATH` 中。裸命令报 `command not found` 时,不要直接读取知识库文件,仍然使用上面的 repo-local 包装脚本。开发/调试 CLI 自身时,可在本 skill 目录运行:

```bash
go run ./cmd/agent-wiki <command>
```

只有调试或迁移数据时,才使用 CLI 的覆盖参数或环境变量切换知识库根目录。

支持的命令:

| 命令 | 作用 |
|---|---|
| `context` | 输出 `AGENT_CONTEXT.md`。 |
| `map [path] [--depth N]` | 输出轻量知识地图,默认只展开 1 层。 |
| `add <path> ...` | 新增知识条目,自动创建目录 meta、写 frontmatter、刷新 AGENT_CONTEXT。 |
| `use <path> --reason ...` | 标记某条知识在当前任务中实际有用,驱动热点排序。 |
| `move <old> <new> ...` | 移动知识条目,保留 `id` / `used_count`,刷新 AGENT_CONTEXT。 |
| `remove <path>` | 删除知识条目,自动清理空目录并刷新 AGENT_CONTEXT。 |
| `run <allowed-command> [args...]` | 在绑定目录内执行受控只读命令。 |
| `patch --patch-file <file>` | 应用 unified diff,并自动记录事件、刷新 AGENT_CONTEXT。 |
| `check` | 校验知识库不变量,不修改文件。 |

第一版 `run` 只允许 `rg`、`sed`、`cat`、`nl`、`ls`、`find`。CLI 不通过 shell 执行命令,并拒绝 shell 元字符、绝对路径、`..` 和非 `./` 开头路径。

## 5. LLM 必须遵循的工作流

### 5.1 查看入口上下文

```bash
./.agents/skills/agent-wiki/bin/agent-wiki context
```

不要直接 `cat` 知识库里的 `AGENT_CONTEXT.md`。

### 5.2 搜索和读取知识

先看知识地图:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki map
./.agents/skills/agent-wiki/bin/agent-wiki map ./general-engineering
```

`map` 默认 `--depth 1`,只展示目录结构和文件 `summary`,不展示 title/used 等噪声字段。它不写任何状态,用于让 agent 先理解知识空间,再决定读取哪条知识。

搜索:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki run rg "关键词" ./
```

读取单条知识:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki run sed -n 1,120p ./examples/hello-world.md
```

`cat` / `sed` / `nl` 读取知识条目不会写审计日志;读过不等于有用。只有 `use` 会更新知识的有用反馈计数。

当某条知识确实影响了你的判断、回答或代码改动时,在完成使用后标记有用:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki use ./examples/hello-world.md --reason "回答问题时实际采用"
```

`use` 会更新该知识文件 frontmatter 中的 `used_count` / `last_used` / `last_used_reason`。`AGENT_CONTEXT.md` 的热点区只扫描知识文件自身的 `used_count`,不要把“读过”当成“有用”。

### 5.3 移动知识

移动条目:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki move ./old/path.md ./new/path.md \
  --category-purpose "新建目录时的用途说明"
```

`move` 会:
- 保留知识文件内的 `id` / `used_count` / `last_used`。
- 为新目录补齐 `.meta.yaml`。
- 刷新根 `AGENT_CONTEXT.md`。

删除条目:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki remove ./old/path.md
```

`remove` 会:
- 只允许删除知识条目,不会删除 `AGENT_CONTEXT.md`。
- 删除条目后清理只剩 `.meta.yaml` 的空目录。
- 刷新根 `AGENT_CONTEXT.md`。

### 5.4 增量修改知识

新增知识:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki add ./category/topic.md \
  --title "标题" \
  --summary "一句话摘要" \
  --category-purpose "新建目录时的用途说明" \
  --body-stdin
```

`add` 只能创建不存在的知识条目;正文可通过 `--body-stdin` 或 `--body-file` 提供。首次创建一级分类时必须提供清晰的 `--category-purpose`。

agent 生成 unified diff 到临时 patch 文件,再交给 CLI:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki patch --patch-file /tmp/change.patch
```

`patch` 会:
- 校验 patch 目标必须是绑定目录内的知识条目。
- 拒绝修改 `.meta.yaml`、`AGENT_CONTEXT.md`。
- 应用 patch。
- 自动更新被改条目的 `updated`。
- 刷新根 `AGENT_CONTEXT.md`。

### 5.5 收尾校验

```bash
./.agents/skills/agent-wiki/bin/agent-wiki check
```

完成任何知识库操作后,必须运行 `check`。

## 6. 严禁项

- 不得直接读取、编辑、移动或删除知识库文件。
- 不得手工编辑 `AGENT_CONTEXT.md` 的生成内容。
- 不得通过 shell 拼接命令绕过 CLI 安全检查。
- 只有在调试 `agent-wiki` CLI 自身时,才允许直接查看底层文件。
