# agent-harness

`agent-harness` 是一个本地 agent skill 承载仓库。当前仓库主要包含
`agent-wiki` skill、它的 Go CLI，以及一份默认 Markdown 知识库。

## 目录结构

```text
.
├── .agents/skills -> ../skills
├── agent-wiki/default-wiki/
├── docs/
└── skills/agent-wiki/
```

- `.agents/skills` 是一个相对软链接，指向仓库内的 `skills` 目录，方便
  Codex 按项目本地 skill 路径发现 skill。
- `skills/agent-wiki` 存放 `agent-wiki` 的 skill 说明、Go CLI 源码和已构建的
  CLI 二进制。
- `agent-wiki/default-wiki` 是本仓库自带的默认 Markdown 知识库。

## 基本用法

首次使用时，在仓库根目录复制配置模板，并按需修改 `wiki_root`。
`agent-wiki.yaml` 是本机配置，不纳入 Git；已有配置无需重复复制。

```bash
cp -n skills/agent-wiki/agent-wiki.example.yaml skills/agent-wiki/agent-wiki.yaml
```

然后在仓库根目录执行：

```bash
./.agents/skills/agent-wiki/bin/agent-wiki context
./.agents/skills/agent-wiki/bin/agent-wiki map
./.agents/skills/agent-wiki/bin/agent-wiki check
```

开发或调试 CLI 时：

```bash
cd skills/agent-wiki
go test ./...
go run ./cmd/agent-wiki context
```

## 注意事项

- 使用 skill 工作流时，不要直接编辑知识库文件；优先使用
  `skills/agent-wiki/SKILL.md` 中说明的 `agent-wiki` CLI 命令。
- 本仓库不依赖全局 Codex hook。其他项目如果要使用这个 skill，应通过自己的
  `.agents/skills` 暴露或链接它。

## 设计说明

[agent-wiki 整体设计](docs/agent-wiki-design.md) 是维护者的统一设计入口，覆盖目标、
架构、知识模型、上下文生成、有用反馈、引用资料、写入安全和维护闭环。
它不在 Skill 中注册，也不自动注入 Agent 上下文。

## 知识与引用文档

知识条目负责告诉 Agent **何时读取、如何使用**资料；清单、案例等详细资料放在
知识目录下的 `references/`，作为普通 Markdown 维护，不统计有用次数，不进入
启动上下文、榜单、知识地图或默认搜索。只有读到相关知识、需要资料时才沿链接读取。

- 默认库示例：[核心设计](agent-wiki/default-wiki/design/core-design.md) 引用
  [资料维护示例清单](agent-wiki/default-wiki/design/references/reference-maintenance-example.md)。
- Agent 日常命令和约束仍以 `skills/agent-wiki/SKILL.md` 为准。

显式指定默认库可避免本机配置绑定到其他项目：

```bash
./.agents/skills/agent-wiki/bin/agent-wiki --root ./agent-wiki/default-wiki map
./.agents/skills/agent-wiki/bin/agent-wiki --root ./agent-wiki/default-wiki run cat ./design/core-design.md
./.agents/skills/agent-wiki/bin/agent-wiki --root ./agent-wiki/default-wiki run cat ./design/references/reference-maintenance-example.md
./.agents/skills/agent-wiki/bin/agent-wiki --root ./agent-wiki/default-wiki check
```
