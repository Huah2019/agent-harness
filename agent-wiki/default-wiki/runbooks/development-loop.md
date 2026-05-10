---
id: development-loop
title: 项目工作闭环
created: 2026-05-10
updated: 2026-05-10
used_count: 2
summary: 说明 agent 在 agent-harness 中如何读取知识、执行改动、验证并沉淀经验。
last_used: 2026-05-10
last_used_reason: 确认优化方向应服务项目工作闭环
---

# 项目工作闭环

agent 在本项目工作时,应把知识库当作项目工作记忆,而不是替代代码阅读的资料库。

## 进入项目

1. 先运行 `./.agents/skills/agent-wiki/bin/agent-wiki context`,了解热点和最近知识。
2. 再用 `map`、`run rg` 或 `run sed` 读取与任务相关的条目。
3. 同时阅读代码、README、测试和当前 git 状态,以当前仓库内容为准。

## 执行改动

- 修改知识库时,必须通过 `agent-wiki add`、`move`、`remove` 或 `patch`。
- 修改 skill、Go CLI、README、测试等普通项目文件时,按仓库常规方式编辑,并保持知识库中的长期判断与实际行为一致。
- 不把代码里能直接看出的实现细节复制进知识库;只沉淀会影响后续 agent 决策的信息。

## 验证收尾

1. 涉及知识库变更时运行 `./.agents/skills/agent-wiki/bin/agent-wiki check`。
2. 涉及 CLI 代码时在 `skills/agent-wiki` 下运行 `go test ./...`。
3. 收尾前反思本次任务是否产生新的长期判断、常见坑、验证路径、演进方向或废弃方案。
4. 如果某条知识实际影响了判断或改动,用 `agent-wiki use <path> --reason ...` 标记有用。

## 写回原则

知识写回要小而准:一条知识只讲一个主题,正文说明结论、适用场景和后续行动。不要为了记录聊天而更新知识库。
