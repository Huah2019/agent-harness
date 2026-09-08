# Agent 上下文

_以下生成区由 `agent-wiki` CLI 自动维护,请勿手工编辑。_

<!-- BEGIN: top-level -->
## 一级目录
- [design/](./design/.meta.yaml) — 只记录当前项目不容易从代码和 Skill 说明直接看出的核心设计判断。
- [evolution/](./evolution/.meta.yaml) — 记录项目接下来如何持续演进的方向和优先级。
- [pitfalls/](./pitfalls/.meta.yaml) — 记录项目内常见坑、排查入口和需要避免的误区。
- [runbooks/](./runbooks/.meta.yaml) — 记录项目内可复用的操作流程和验证路径。
<!-- END: top-level -->

<!-- BEGIN: hot -->
## 热点 — 有用反馈 Top 20
1. [核心设计](./design/core-design.md) — agent-wiki 的核心设计是 Skill 负责约束 agent 行为，Go CLI 负责约束知识库文件系统写入。 · 2 次有用
2. [当前演进队列](./evolution/current-roadmap.md) — 记录 agent-harness 让项目知识库持续驱动 agent 改进的近期演进方向。 · 2 次有用
3. [项目工作闭环](./runbooks/development-loop.md) — 说明 agent 在 agent-harness 中如何读取知识、执行改动、验证并沉淀经验。 · 2 次有用
4. [agent-wiki 边界与常见误区](./pitfalls/agent-wiki-boundaries.md) — 记录 agent-wiki 使用时最容易破坏项目知识库一致性的边界和误区。 · 1 次有用
<!-- END: hot -->

<!-- BEGIN: recent -->
## 最近 — 按 `updated` 排序 Top 10
1. [软链 skill 的 wiki_root 解析](./pitfalls/symlinked-skill-wiki-root.md) — 软链安装 agent-wiki skill 时,相对 wiki_root 会按真实 skill 目录解析,容易指到不存在的知识库。 · 更新于 2026-06-10
2. [核心设计](./design/core-design.md) — agent-wiki 的核心设计是 Skill 负责约束 agent 行为，Go CLI 负责约束知识库文件系统写入。 · 更新于 2026-05-10
3. [当前演进队列](./evolution/current-roadmap.md) — 记录 agent-harness 让项目知识库持续驱动 agent 改进的近期演进方向。 · 更新于 2026-05-10
4. [agent-wiki 边界与常见误区](./pitfalls/agent-wiki-boundaries.md) — 记录 agent-wiki 使用时最容易破坏项目知识库一致性的边界和误区。 · 更新于 2026-05-10
5. [项目工作闭环](./runbooks/development-loop.md) — 说明 agent 在 agent-harness 中如何读取知识、执行改动、验证并沉淀经验。 · 更新于 2026-05-10
<!-- END: recent -->

<!-- BEGIN: recent-useful -->
## 最近反馈有用 Top 10
1. [核心设计](./design/core-design.md) · 最近有用 2026-05-10
2. [当前演进队列](./evolution/current-roadmap.md) · 最近有用 2026-05-10
3. [agent-wiki 边界与常见误区](./pitfalls/agent-wiki-boundaries.md) · 最近有用 2026-05-10
4. [项目工作闭环](./runbooks/development-loop.md) · 最近有用 2026-05-10
<!-- END: recent-useful -->
