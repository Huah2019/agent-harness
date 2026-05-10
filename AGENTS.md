# Agent 工作准则

本仓库是本地 agent skill 与项目知识库的承载仓库。agent 在这里工作的目标不是只完成单次改动,还要让项目知识库持续变成更好的工作记忆。

## 项目边界

- `README.md` 面向人说明项目定位、目录结构和基本用法。
- `skills/agent-wiki/SKILL.md` 约束 agent 如何查阅、写入和校验知识库。
- `skills/agent-wiki/cmd/agent-wiki` 是约束知识库文件系统写入的 Go CLI。
- `agent-wiki/default-wiki` 保存项目知识,只记录会影响未来 agent 判断和行动的项目记忆。
- 不要把知识库当成 README 扩展、任务流水账或代码实现副本。

## 上下文使用

知识库帮助 agent 定位背景和长期判断,但当前代码、测试和用户最新要求始终是执行依据。

## 自进化闭环

每次任务收尾前都要做一次轻量反思:

- 本次是否形成了新的长期设计判断?
- 是否发现了未来会重复踩的坑?
- 是否沉淀出稳定的验证路径或操作流程?
- 是否改变了项目演进优先级?
- 是否证明某个旧方案应该废弃或降级?

如果答案都是“否”,不要为了记录而更新知识库。如果答案有“是”,把它写成一条小而准的知识:一个文件只讲一个主题,说明结论、适用场景和后续行动。

## 知识库写入规则

agent 不直接编辑、移动或删除知识库文件。知识库变更必须通过 `agent-wiki` CLI:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki add ./category/topic.md ...
./.agents/skills/agent-wiki/bin/agent-wiki move ./old.md ./new.md ...
./.agents/skills/agent-wiki/bin/agent-wiki remove ./category/topic.md
./.agents/skills/agent-wiki/bin/agent-wiki patch --patch-file /tmp/change.patch
```

`AGENT_CONTEXT.md` 是生成文件,不要手工编辑。目录结构可以按项目自然演进,不要为了整齐固定分类;稳定约束来自 `SKILL.md` 中的知识沉淀边界。

当某条知识实际影响了判断、回答或代码改动时,使用 `use` 标记有用:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki use ./category/topic.md --reason "说明实际用途"
```

读过不等于有用。只有确实改变了工作判断时才标记。

## 应沉淀什么

优先沉淀这些信息:

- 项目定位、边界、长期目标。
- 核心设计判断和取舍原因。
- 可复用工作流、验证路径和挂载方式。
- 常见坑、排查入口和禁止事项。
- 演进队列、阶段性优先级和暂不做的方向。
- 已废弃方案和反例。

不要沉淀这些信息:

- 可以直接从代码、测试、README 或命令输出稳定获得的普通细节。
- 一次性任务流水账、临时状态、无复用价值的聊天总结。
- 未验证猜测,除非明确标注假设和验证方式。
- 大段复制的外部文档或日志。

## 改动与验证

修改普通项目文件时遵循现有代码和文档风格。修改知识库时必须跑:

```bash
./.agents/skills/agent-wiki/bin/agent-wiki check
```

修改 Go CLI 时在 `skills/agent-wiki` 下跑:

```bash
go test ./...
```

收尾回答要说明改了什么、验证了什么、是否有未处理风险。不要声称完成未经验证的事情。
