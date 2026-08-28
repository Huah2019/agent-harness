# design-doc Eval

本目录用于验证 design-doc 方法是否真的提高了实现质量，而不是只让文档看起来更专业。

## 1. 核心实验：Blind Implementation Test

每个 case 至少准备：

```text
case/
├── input.md          # 原始需求、必要上下文和仓库状态
├── baseline.md       # 不使用 design-doc 方法生成的设计（可选）
├── design.md         # 使用 design-doc 生成的设计
└── result.md         # 实现与 review 结果
```

生成设计和实现必须使用不同 session。

实现 Agent 只获得：

```text
repository
+ design.md
+ 用户明确要求的实现目标
```

不要把生成设计时的聊天历史一起提供给实现 Agent。

目的：检测文档是否真正 self-contained，而不是依赖 Writer 自己记得隐含上下文。

## 2. 评价指标

### 2.1 Implementation Decision Residue

记录实现 Agent 仍然自行决定的重要事项。

高价值记录包括：

```text
产品行为
数据语义
接口协议
失败语义
ownership
一致性
兼容性
重试 / 幂等
资源边界
安全边界
```

普通变量命名、函数拆分、文件组织和等价实现技巧不计入 residue。

目标：重大 residue 趋近于 0。

### 2.2 Clarification Count

实现过程中，因为设计信息不足而必须询问的问题数量。

区分：

```text
blocking clarification
non-blocking preference
```

只重点统计 blocking clarification。

### 2.3 Design Deviation

实现是否出现与文档语义不一致的行为。

记录：

```text
遗漏
错误解释
偷偷增加行为
偷偷选择 fallback
边界处理不一致
```

### 2.4 Rework

首次实现后，因为设计缺口而需要返工的次数和范围。

区分：

```text
design-caused rework
implementation bug
```

### 2.5 Human Review Findings

人类 review 设计或实现后发现的设计级缺口数量。

### 2.6 Document Cost

至少记录：

```text
文档 token / 字数
关键语义是否需要跨章节跳转
明显重复段落
无信息背景或讨论历史
```

目标不是最短，而是在 implementation correctness 基本不下降的前提下降低上下文与理解成本。

## 3. 建议的结果格式

```markdown
# Eval Result

## Case
<name>

## Outcome
- build/test: pass | fail
- implementation completed: yes | no

## Decision Residue
1. ...

## Clarifications
1. ...

## Design Deviations
1. ...

## Rework
1. ...

## Human Review Findings
1. ...

## Document Cost
- words/tokens: ...
- notable navigation jumps: ...
- obvious redundant sections: ...

## Skill Changes Suggested
1. ...
```

## 4. Case 选择

不要只测试同一种后端服务。优先覆盖不同设计对象：

```text
简单 API
带 cache 的服务
batch processing
async callback / resumable workflow
数据库 schema / migration
Agent tool / skill routing
多模态 / model pipeline
已有系统上的兼容改造
```

每个真实 case 都应尽量来自本来就要做的工程需求，避免为了 benchmark 人工构造过于干净的问题。

## 5. 迭代规则

只有出现可复现的 failure pattern 时，才优先增加新的 design obligation 或 writing rule。

例如多次出现：

```text
migration 没写 rollback
batch 没写 partial failure
retry 没写 idempotency
model output 没写 malformed handling
```

再把对应规则加入 `obligations.md`。

不要因为“看起来可能有用”无限扩张规则集。

设计方法的演进循环：

```text
real case
  ↓
blind implementation
  ↓
find recurring design failure
  ↓
change skill / obligation
  ↓
re-evaluate
```

## 6. 当前阶段

v0 阶段先使用 LLM 执行 writer / reviewer，不实现静态 linter。

当积累足够 case 后，再根据稳定模式决定是否需要：

```text
LLM-based design lint
structured review output
Design IR
static analyzer
```

不要提前工程化尚未验证稳定的设计类型和规则。
