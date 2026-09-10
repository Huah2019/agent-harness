# Conditional Design Obligations

本文件定义 design-doc 的条件式完备性检查。规则不是模板章节，而是：**方案中一旦出现某类设计对象，就必须回答相应问题。**

## 1. Universal

所有设计都检查：

- 关键术语是否定义且前后一致；
- 重要行为是否有明确 owner；
- 输入、输出和状态转换是否语义明确；
- 失败是否有可观察语义；
- 是否存在只靠聊天上下文才能理解的前提；
- 是否存在两种合理实现，但会造成不同外部行为；
- 未决定事项是否显式列出。

## 2. Interface / API / CLI

如果存在公开或跨模块接口，必须明确：

```text
Input shape
Required / optional fields
Output shape
Validation
Error semantics
Unknown / unsupported fields
Compatibility expectations
At least one representative example
```

特别检查：

- 缺参数怎么办；
- 多传参数怎么办；
- 非法范围是否拒绝还是归一化；
- 空结果与失败是否可区分；
- 是否存在 silent fallback；
- version / backward compatibility 是否重要。

## 3. Data Model

如果定义数据模型，必须明确：

```text
Fields and semantics
Identity
Ownership
Invariants
Lifecycle
Nullable / optional semantics
Default values when meaningful
Mutation rules
```

如果持久化，还要继续触发 Persistence / Migration obligations。

## 4. Time / Range

如果出现时间、范围、offset、duration 或坐标系，必须明确：

```text
Coordinate system
Unit
Precision
Range validity
Inclusive / exclusive semantics when relevant
Conversion owner
Out-of-range behavior
```

如果存在多套时间轴，必须说明转换发生在哪一层，不能让模型或调用方自行猜算。

## 5. Batch / Multi-target

如果一次请求包含多个目标，必须明确：

```text
Atomic or independent
Ordering
Duplicate target behavior
Partial failure
Per-item error representation
Whole-request failure conditions
Retry granularity
Concurrency limit
Whole-request resource budget
```

特别检查：

- 某一项失败是否丢整批；
- 输出是否保持输入顺序；
- 重试是否重放已成功项；
- 不同 target 是否共享上下文或证据。

## 6. Cache

如果存在缓存，必须明确：

```text
Cached value
Cache scope
Cache key / hit condition
Invalidation
Write condition
Failure / partial result policy
Concurrent miss behavior
Consistency expectation
```

特别检查：

- 配置、模型、协议或数据版本变化是否命中旧缓存；
- 失败结果是否缓存；
- 并发 miss 是否重复计算；
- 缓存只是性能优化，还是改变外部语义。

## 7. Async / Callback / Interruptible Execution

如果执行可中断、跨回调恢复或依赖异步外部动作，必须明确：

```text
Persisted state
Step / state machine
Interruption points
Resume semantics
Duplicate callback handling
Idempotency
Timeout
Cancellation when supported
Failure after partial progress
```

特别检查：

- 进程内对象丢失后能否恢复；
- 重复回调会不会重复产生副作用；
- 回调顺序是否可信；
- 哪些状态必须持久化。

## 8. Retry

如果存在 retry，必须明确：

```text
Retryable conditions
Retry scope
Attempt limit / bounded retry
Backoff if relevant
Idempotency requirement
Duplicate side-effect prevention
Final failure behavior
```

禁止只写“失败后重试”。

## 9. Concurrency

如果存在并发或共享资源，必须明确：

```text
Concurrency unit
Limit
Shared state
Synchronization / singleflight / lock semantics when relevant
Ordering requirement
Fairness or starvation only when relevant
Resource isolation
```

特别检查一种请求是否可能占满全部执行槽，以及不同重任务是否需要独立并发池。

## 10. External Dependency

如果调用客户端、服务、数据库、模型或其他外部依赖，必须明确：

```text
Required capability
Unavailable behavior
Timeout
Malformed response behavior
Retryability
Version/config dependency
Trust boundary
```

不要假设依赖一定成功或一定返回合法数据。

## 11. Model / LLM / VLM

如果系统调用模型，必须明确：

```text
Evidence / input organization
Prompt or PE ownership
Model/config versioning when behavior or cache depends on it
Output contract
Validation / normalization
Hallucination boundary
Unavailable evidence behavior
Token/frame/resource budget
```

特别检查：

- 模型缺少证据时能否猜；
- 输出越界或 malformed 怎么办；
- 多目标是否混入同一次模型上下文；
- 模型配置变化如何影响缓存和可复现性。

## 12. State Machine / Workflow

如果对象有明确状态或多阶段生命周期，必须明确：

```text
States
Initial state
Allowed transitions
Transition owner
Invalid transition behavior
Terminal states
Failure / recovery transitions
```

复杂状态优先使用 state diagram 或 transition table，不用长篇散文描述。

## 13. Persistence

如果数据跨进程或长期保存，必须明确：

```text
What is persisted
Source of truth
Write timing
Read timing
Consistency
Corruption / partial write behavior when relevant
Retention / cleanup when relevant
```

数据 schema 会演进时继续触发 Migration obligations。

## 14. Migration / Compatibility

如果已有数据、协议或客户端需要演进，必须明确：

```text
Old state
New state
Compatibility window
Read old / write new policy
Rollback
Failure during migration
Version detection
Removal condition
```

禁止只写“兼容旧版本”而不说明谁兼容、兼容多久、怎么判定。

## 15. Configuration

如果行为由配置控制，必须明确：

```text
Config owner
Defaults
Allowed range / enum
Dynamic or restart-required
Invalid config behavior
Which semantics may change
```

关键产品语义不要无意间变成任意配置项。

## 16. Resource Limits

如果存在帧数、token、并发、时间、内存、批量大小等资源约束，必须明确：

```text
Limit
Scope: per item / per request / global
Default
Exceeded behavior: reject / degrade / split
Who chooses automatic value
Whether silent degradation is allowed
```

## 17. Security / Visibility / Trust Boundary

如果存在内部 ID、URL、敏感数据、权限或用户隔离，必须明确：

```text
Visible to caller
Internal only
Identity mapping
Authorization boundary
Cross-user isolation
Logging restrictions
Error-message redaction
```

## 18. Observability

如果方案需要线上运行和调优，必须明确至少哪些维度可观测：

```text
Success / failure
Latency
Critical dependency latency
Resource usage
Cache hit when relevant
Retry / timeout
Error code
Key dimensions for debugging
Sensitive data that MUST NOT be logged
```

不要为了“可观测性完整”罗列所有可能指标，只保留能支持定位问题和评估方案的信号。

## 19. Agent / Tool Routing

如果设计涉及 Agent 选择工具、Skill 或多步调用，必须明确：

```text
When to use
When not to use
Choice between similar capabilities
Required prerequisite context
Result semantics
Whether result is evidence or action
Multi-step composition
State/context reuse validity
Failure fallback boundary
```

特别检查：

- 是否存在两个等价入口导致随机选择；
- Agent 是否可能把粗粒度结果直接当最终操作边界；
- 草稿或状态变化后旧证据是否仍有效；
- 缺上下文时是先获取 ID/结构，还是猜测。

## 20. Review Algorithm

完成设计后，逐个 Design Object 执行：

```text
1. Identify object type(s).
2. Apply all matching obligations.
3. Mark every unanswered item.
4. Decide whether the answer affects observable behavior, architecture, data semantics, consistency, compatibility, or safety.
5. If yes, resolve it or mark it explicitly open.
6. Simulate at least one normal and one failure execution path.
7. Search again for implementation decisions not captured by the document.
```

同一对象可以触发多类义务，例如一个异步批量模型接口同时触发：

```text
Interface
Batch
Async
Retry
External Dependency
Model
Resource Limits
Observability
```

不要因为已有一个章节提到它，就认为其他义务自动满足。
