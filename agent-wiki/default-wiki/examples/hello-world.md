---
id: hello-world
title: Hello World — 样例知识条目
tags: [example, template]
created: 2026-05-10
updated: 2026-05-10
used_count: 0
summary: 演示规范 frontmatter 与正文结构的最小示例。
---

# Hello World — 样例知识条目

本文件演示规范的知识条目格式,落地实际知识时请直接覆盖正文。

## 适用场景

- 新建一个分类时拿来当模板复制粘贴。
- 作为 `agent-wiki check` / `agent-wiki context` 的冒烟测试目标。

## 注意事项

- `summary`(≤ 120 字符)会被原样写进 `map` 与 AGENT_CONTEXT.md。
- 每次修改后由 `agent-wiki` CLI 同步更新 `updated`,并用它生成"最近"榜。
