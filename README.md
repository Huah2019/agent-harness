# agent-harness

`agent-harness` 是一个本地 agent skill 承载仓库。当前仓库主要包含
`agent-wiki` skill、它的 Go CLI，以及一份默认 Markdown 知识库。

## 目录结构

```text
.
├── .agents/skills -> ../skills
├── agent-wiki/default-wiki/
└── skills/agent-wiki/
```

- `.agents/skills` 是一个相对软链接，指向仓库内的 `skills` 目录，方便
  Codex 按项目本地 skill 路径发现 skill。
- `skills/agent-wiki` 存放 `agent-wiki` 的 skill 说明、Go CLI 源码和已构建的
  CLI 二进制。
- `agent-wiki/default-wiki` 是本仓库自带的默认 Markdown 知识库。

## 基本用法

在仓库根目录执行：

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
