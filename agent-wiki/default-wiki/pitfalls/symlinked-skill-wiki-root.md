---
id: symlinked-skill-wiki-root
title: 软链 skill 的 wiki_root 解析
created: 2026-06-10
updated: 2026-06-10
used_count: 0
summary: 软链安装 agent-wiki skill 时,相对 wiki_root 会按真实 skill 目录解析,容易指到不存在的知识库。
---

# 软链 skill 的 wiki_root 解析

当项目通过软链安装 `agent-wiki` skill 时,CLI 会对可执行文件路径执行 symlink 解析,再从真实 skill 目录读取 `agent-wiki.yaml` 并解析 `wiki_root`。

因此 `agent-wiki.yaml` 里的相对路径不是按当前项目目录或软链目录解析,而是按真实 skill 目录解析。比如 `/Users/bytedance/Work/jianying/.agents/skills/agent-wiki` 软链到 `/Users/bytedance/Work/agent-harness/skills/agent-wiki` 时,`../../agent-wiki/dev-wiki` 会落到 `/Users/bytedance/Work/agent-harness/agent-wiki/dev-wiki`,而不是 `/Users/bytedance/Work/agent-wiki/dev-wiki`。

排查方式:

1. 从目标项目目录直接运行 `./.agents/skills/agent-wiki/bin/agent-wiki map --depth 1` 复现。
2. 检查 `skills/agent-wiki/agent-wiki.yaml` 的 `wiki_root`。
3. 用 `Path(skillDir) / wiki_root` 或等价命令确认 `.meta.yaml` 和 `AGENT_CONTEXT.md` 是否存在。

修复方式优先使用目标机器上的绝对 `wiki_root`,或改成从真实 skill 目录出发能解析到有效知识库的相对路径。修复后必须从实际消费项目目录重跑 `agent-wiki map --depth 1` 和 `agent-wiki check`。
