---
id: core-design
title: 核心设计
created: 2026-05-10
updated: 2026-09-10
used_count: 2
summary: agent-wiki 的核心设计是 Skill 负责约束 agent 行为，Go CLI 负责约束知识库文件系统写入。
last_used: 2026-05-10
last_used_reason: 思考下一步优化方向时采用核心边界
---

# 核心设计

`agent-wiki` 的核心不是把 Markdown 知识库做厚，而是把 agent 操作知识的边界收窄：

- `SKILL.md` 约束 agent：什么时候该查知识、怎么查、什么时候能标记有用、哪些行为禁止。
- Go CLI 约束文件系统：所有新增、移动、删除、patch、索引刷新和校验都通过一个入口完成。
- Markdown 仍是源数据：知识保持可读、可版本化、可 diff，但 agent 不直接读写底层文件。
- `AGENT_CONTEXT.md` 是生成入口：它只提供目录、热点和最近更新，不承载真实知识正文。

这套设计的取舍是：不用数据库或 RAG 先行，而是先把“人和 agent 都能看懂的知识文件”变成一个受控工程资产。CLI 的价值不在功能多，而在把格式约束、路径安全、目录 meta、上下文刷新这些容易被 agent 写乱的细节集中处理。

因此，知识库本身应该保持薄：只记录项目级设计判断、长期约定和代码里看不出的背景。命令用法、字段格式和实现细节优先回到 `SKILL.md`、测试和 Go 代码中维护。

知识入口与附属资料分开：清单、案例等放在 `references/` 中，不独立注册上下文或统计有用次数。它的用途由引用它的知识决定，避免资料更新挤占决策入口。

维护引用资料时，先读 [资料维护示例清单](./references/reference-maintenance-example.md)，确认读取入口、链接和资料状态；不要把清单全文复制进知识摘要。维护者的完整设计说明由仓库 README 链接到 `docs/`，不作为 Skill 加载内容。
