---
name: design-doc
description: 当任务需要把模糊或复杂需求推演成可直接驱动实现的高质量设计文档时使用。重点不是套固定模板，而是建立完整设计语义、消除实现阶段仍需自行决定的产品/架构问题，并用高信息密度的 Markdown 表达。
---

# design-doc — Implementation-Ready Design

本 skill 用于把需求、想法和讨论结果编译成可直接驱动 Coding Agent 实现的设计文档。

核心目标不是“写得全面”，而是：

> 用尽可能低的认知成本和上下文成本，表达实现所需的最小充分设计。

设计完成的判断标准不是章节齐全，而是：

> 一个新的实现 Agent 只拿到仓库和设计文档后，不再需要自行决定重要的产品行为、数据语义、协议、边界、失败语义、状态一致性或架构职责。

允许实现 Agent 决定普通代码组织、函数拆分、命名、局部重构和等价实现技巧；不允许它替设计文档补做重要设计决策。

完整原则见 `principles.md`，条件式完备性规则见 `obligations.md`。

## 1. 工作方式

不要收到需求后立即套模板写 Markdown。按以下顺序工作：

```text
Intent / Requirement
  ↓
建立 Design Map
  ↓
识别 Design Objects
  ↓
补齐对应 Design Obligations
  ↓
模拟正常、失败、边界与重复执行
  ↓
寻找 Implementation Decision Residue
  ↓
继续补设计，直到重大 residue 清零
  ↓
选择最合适的表达原语
  ↓
压缩并渲染 Markdown
  ↓
独立 Review
```

Markdown 是设计结果的序列化形式，不是设计过程本身。

## 2. 先建立 Design Map

先识别当前方案中实际存在的设计对象及其关系，不要预设目录。

常见对象包括但不限于：

```text
Concept
Capability
Component
Interface
Data Model
State
Workflow
External Dependency
Cache
Batch
Async
Concurrency
Retry
Time
Configuration
Persistence
Migration
Observability
Model / Agent
```

只识别真实存在的对象。没有数据库就不要生成数据库章节；没有缓存就不要生成缓存章节。

对每个对象回答三个基础问题：

```text
它是什么？
它与谁发生关系？
它承担什么语义或责任？
```

再根据 `obligations.md` 触发对应的条件式检查。

## 3. 设计推演

对主要执行路径进行具体模拟，而不是停留在抽象描述。

至少检查：

```text
Happy path
Failure path
Boundary / empty / invalid input
Partial failure（如果存在批量或多目标）
Duplicate / retry（如果可能重复执行）
Concurrency（如果存在共享状态或并发）
State change / resume（如果存在异步或持久状态）
```

每次看到 `A -> B` 都继续问：

```text
输入是什么？
输出是什么？
谁拥有转换责任？
B 失败怎么办？
重复执行怎么办？
边界值怎么办？
```

如果答案会改变对外行为、数据语义、兼容性、一致性或架构职责，就必须进入设计文档。

## 4. Implementation Decision Residue

完成一轮设计后，专门寻找实现阶段仍然残留的重要决策。

使用这个问题做 Review：

> List every important decision a coding agent would still have to make while implementing this document.

重点寻找：

```text
未定义的数据语义
未定义的 owner
未定义的失败行为
未定义的边界
未定义的状态变化
未定义的一致性要求
未定义的协议行为
未定义的兼容性行为
未定义的资源限制
依赖隐含聊天上下文才能理解的事实
```

存在重大 residue 时，设计未完成。

已知但暂未决定的问题必须显式标记为 Open Question / TBD；不能通过省略伪装成已完成设计。

## 5. 表达原语

设计完成后，再选择最合适的表达方式。优先使用以下原语：

| 信息类型 | 表达方式 |
| --- | --- |
| 概念是什么 | Definition |
| 边界接受和返回什么 | Contract |
| 必须始终成立或禁止的行为 | Rule / Invariant |
| 多步数据流或控制流 | Typed Pseudocode |
| 多条件离散分支 | Decision Table |
| 模块、状态或调用关系 | Diagram |
| 帮助快速建立直觉 | Example |
| 重要取舍或未决问题 | Decision / Open Question |

自由散文是兜底表达，不是默认表达。

详细表达规则见 `principles.md`。

## 6. 自然伪代码

优先使用接近自然代码、但不绑定具体编程语言的 typed pseudocode。

推荐记法：

```text
变量名<返回类型或返回内容> = 能力(输入)
```

示例：

```text
frames[{time_s, image}]
  = get_frames(target_id, effective_range, fps ?? auto)

asr[{start_s, end_s, text}]?
  = load_asr(target_id)

matched_ranges[{start_s, end_s, description}]
  = VLM[model, prompt](query, frames, asr?)

ranges[{start_s, end_s, description}]
  = validate_and_merge_ranges(matched_ranges, limit=effective_range)
```

规则：

- 左侧写出本步骤真正产生的语义内容，不要只写 `result`、`data`、`process_result`。
- 伪代码只表达有意义的数据流、控制流、状态变化和责任边界，不展开语言级样板代码。
- 如果一句自然语言需要连续描述“先 A，再 B，再 C”，优先改成伪代码或 sequence。

## 7. Zero-Jump Principle

设计文档优先保证信息局部性，不机械追求 DRY。

理解一个局部设计的核心行为，不应要求读者跳到多个远处章节才能补齐语义。

不要写：

```text
错误处理见 §5.2。
```

优先写：

```text
单 target 失败不影响其他 target；批量结果返回 partial_success，并在失败 item 内携带 error。
完整错误码见 §5.2。
```

引用只适合补充细节、完整枚举、背景材料或极低频信息，不能承担当前段落的核心语义。

允许压缩重复：重复的是语义结论，不重复完整推理过程。

## 8. 文档组织

不要强制所有设计使用同一目录。

顶层结构可以根据问题自然形成。必要时可使用以下松散骨架：

```text
Context / Goal
Global Semantics
Design
Cross-cutting Concerns
Open Questions
Implementation Boundary
```

但只保留对当前方案有价值的部分。

局部结构由对象类型决定。例如：

```text
Capability
  Purpose
  Contract
  Procedure
  Rules
  Example

Data Model
  Definition
  Schema
  Invariants
  Lifecycle
  Ownership

Protocol
  Grammar / Contract
  Validation
  Errors
  Examples

Async Runtime
  State
  Transitions
  Procedure
  Failure / Resume Rules
```

这些不是模板要求，而是常见的自然组织方式。

## 9. Compression Pass

逻辑闭合后专门做一次压缩，不要边想边过度追求短。

删除：

```text
设计讨论历史
重复结论
无信息连接句
已经由表格或伪代码完整表达的散文复述
“为了完整”而增加的背景介绍
实现者可直接从代码稳定获得的普通细节
```

保留：

```text
定义
语义
边界
数据流
失败行为
状态与一致性
关键资源约束
重要取舍理由
未决问题
```

原则：

> Design Doc 是设计过程结束后的最小充分表示，不是设计过程的会议纪要。

## 10. Review

写完后以“第一次看到该方案的新 Agent”视角重新检查。

不要问“文档是否清晰完整”，而问：

```text
实现时哪里还必须猜？
哪里依赖作者脑中的隐含知识？
哪里只有示例，没有规范？
哪里只写成功路径？
哪里出现状态、缓存、批量、异步等机制，却没有完成相应义务？
哪里存在两种合理实现，而它们会产生不同外部行为？
```

Review 只指出设计缺口和矛盾，不为了篇幅增加无价值章节。

## 11. 不要做的事情

- 不采用固定的 Spec -> Plan -> Tasks 文档流水线来替代详细设计。
- 不为了形式完整生成没有实际内容的章节。
- 不把示例当作唯一规范来源。
- 不用论文式长篇背景和论证替代直接定义。
- 不为了形式化而引入比自然伪代码更难读的数学符号。
- 不机械消除所有重复，导致理解一个局部设计必须频繁跳转。
- 不把尚未决定的问题偷偷留给实现 Agent。
- 不在设计文档中展开普通代码实现细节，除非该细节本身影响语义或架构。
