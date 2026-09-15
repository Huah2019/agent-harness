# agent-harness

`agent-harness` 是一个本地 agent skill 承载仓库，包含 `agent-wiki`、
`feishu-agent-router` 及默认 Markdown 知识库。可分发的代码与模板放在
`skills/`，Router 的私人配置和运行数据放在仓库外。

## 目录结构

```text
.
├── .agents/skills -> ../skills
├── agent-wiki/default-wiki/
├── docs/
├── scripts/package-skill.py
├── scripts/skill-packages.json
└── skills/
    ├── agent-wiki/
    └── feishu-agent-router/
```

- `.agents/skills` 是一个相对软链接，指向仓库内的 `skills` 目录，方便
  Codex 按项目本地 skill 路径发现 skill。
- `skills/agent-wiki` 存放 `agent-wiki` 的 skill 说明、Go CLI 源码和已构建的
  CLI 二进制。
- `agent-wiki/default-wiki` 是本仓库自带的默认 Markdown 知识库。
- `skills/feishu-agent-router` 是飞书到本地 Agent 的 Runtime、通用路由规则和安装 Skill。

## Feishu Agent Router

其他项目通过软链接挂载 `skills/feishu-agent-router`，源码只在此仓库维护。
例如在另一个项目的 `.agents/skills/` 中执行：

```bash
ln -s /absolute/path/to/agent-harness/skills/feishu-agent-router feishu-agent-router
```

已有同名目录应先比对迁移，不能用 `ln -sf` 覆盖。软链接仅用于本地发现，发布包不包含软链接。

私人目录约定：

```text
~/.config/feishu-agent-router/config.json          # 用户、项目路径、后台配置
~/.local/share/feishu-agent-router/entry/AGENTS.md  # 实际使用的个性化路由规则
~/.local/state/feishu-agent-router/                # 会话、队列和日志
```

配置和状态支持 XDG 环境变量。初始化时用 `--router-dir` 指向上述仓库外入口；
`--workspace main=/absolute/path/to/project` 指定业务目录。
Runtime 在 init、doctor、start/run 校验真实配置、状态和路由目录不得位于 Skill
所在 Git 仓库内；通过软链接指入也会拒绝。业务目标目录可以是本仓库。
详情见 [配置说明](skills/feishu-agent-router/references/configuration.md)。

### 发布到 AgentBuddy

只上传发布包，不上传整个仓库或正在运行的路由目录：

```bash
# 迁移或改动后，先检查白名单文件（允许新文件尚未 git add）
python3 scripts/package-skill.py feishu-agent-router --check

# 审查改动并将发布源码纳入 Git 后，再生成包
python3 scripts/package-skill.py feishu-agent-router
```

包输出到 Git 忽略的 `dist/feishu-agent-router.skill`；命令不会上传。
已有同名包时拒绝覆盖，先将上一次包移到仓库外归档，再重新生成。

打包边界由 `scripts/skill-packages.json` 中的逐文件白名单决定：仅包含已被 Git
跟踪的指定文件，不递归复制目录、不收运行数据、测试产物或软链接。
新增 Runtime 依赖时需同步更新白名单。打包前扫描常见凭据、飞书真实标识与个人
home 路径；命中时只输出文件和行号，不回显敏感值。
扫描不能识别所有形式的秘密，发布前仍应审查这些文件；`.gitignore` 只是防误提交兜底，
不能替代发布白名单。

验证命令：

```bash
node --test skills/feishu-agent-router/scripts/tests/*.test.mjs
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

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
