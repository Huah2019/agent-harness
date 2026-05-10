---
id: agent-wiki-boundaries
title: agent-wiki 边界与常见误区
created: 2026-05-10
updated: 2026-05-10
used_count: 1
summary: 记录 agent-wiki 使用时最容易破坏项目知识库一致性的边界和误区。
last_used: 2026-05-10
last_used_reason: 排除直接做重型检索和绕过 CLI 的方向
---

# agent-wiki 边界与常见误区

`agent-wiki` 的价值在于让 Markdown 知识保持可读、可 diff,同时把 agent 的写入行为收束到 CLI。破坏这个边界会让知识库重新变成散乱文件夹。

## 必须保持的边界

- agent 不直接编辑知识库文件;新增、移动、删除和增量修改都走 CLI。
- `AGENT_CONTEXT.md` 是生成入口,不能手工维护。
- `SKILL.md` 约束 agent 行为,Go CLI 约束文件系统写入,Markdown 知识只记录项目记忆。
- README 面向人说明项目和基本用法;知识库记录会影响未来 agent 判断的背景、取舍和工作流。

## 常见误区

- 把知识库当成 README 扩展,复制大量普通用法和实现细节。
- 把一次性任务总结写成长期知识,导致未来 agent 被噪声误导。
- 为了整齐而固定目录结构,反而让后续项目知识必须迁就分类。
- 读过一条知识就标记有用;只有它实际影响判断、回答或改动时才用 `use`。
- 在不知道当前 wiki root 的情况下操作裸 `agent-wiki` 命令;本项目应使用 `./.agents/skills/agent-wiki/bin/agent-wiki`。

## 排查入口

- 知识地图异常:先运行 `agent-wiki map --depth 2` 和 `agent-wiki check`。
- 入口上下文异常:运行 `agent-wiki context`,确认是否自动刷新。
- skill 未被发现:检查项目 `.agents/skills` 是否暴露了包含 `SKILL.md` 的 skill 目录。
