package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, dst, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func copyWiki(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "wiki")
	writeFile(t, filepath.Join(root, ".meta.yaml"), "id: wiki\ntitle: wiki\nsummary: 测试知识根目录\n")
	writeFile(t, filepath.Join(root, "AGENT_CONTEXT.md"), "# Agent 上下文\n\n_以下生成区由 `agent-wiki` CLI 自动维护,请勿手工编辑。_\n\n<!-- BEGIN: top-level -->\n<!-- END: top-level -->\n\n<!-- BEGIN: hot -->\n<!-- END: hot -->\n\n<!-- BEGIN: recent -->\n<!-- END: recent -->\n")
	writeFile(t, filepath.Join(root, "examples", ".meta.yaml"), "id: examples\ntitle: examples\nsummary: 兼作模板使用的样例知识条目。\n")
	writeFile(t, filepath.Join(root, "examples", "hello-world.md"), `---
id: hello-world
title: Hello World — 样例知识条目
created: 2026-05-10
updated: 2026-05-10
used_count: 0
summary: 演示规范 frontmatter 与正文结构的最小示例。
---

# Hello World — 样例知识条目

本文件演示规范的知识条目格式,落地实际知识时请直接覆盖正文。

## 适用场景

- 新增知识条目前确认 frontmatter 格式。
- 调试 agent-wiki CLI 的 map/context 展示。
`)
	return root
}

func TestSkillLocalConfigCanPointToExternalWiki(t *testing.T) {
	wikiRoot := copyWiki(t)
	skillDir := t.TempDir()
	config := "version: 1\nwiki_root: " + wikiRoot + "\n"
	if err := os.WriteFile(filepath.Join(skillDir, "agent-wiki.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	root, ok := wikiRootFromSkillDir(skillDir)

	if !ok {
		t.Fatal("expected skill-local config to resolve wiki root")
	}
	if root != wikiRoot {
		t.Fatalf("unexpected root: got %s want %s", root, wikiRoot)
	}
}

func TestSkillLocalConfigResolvesRelativeWikiRoot(t *testing.T) {
	skillDir := t.TempDir()
	wikiRoot := filepath.Join(skillDir, "knowledge")
	writeFile(t, filepath.Join(wikiRoot, ".meta.yaml"), "id: wiki\ntitle: wiki\nsummary: 测试知识根目录\n")
	config := "version: 1\nwiki_root: ./knowledge\n"
	if err := os.WriteFile(filepath.Join(skillDir, "agent-wiki.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	root, ok := wikiRootFromSkillDir(skillDir)

	if !ok {
		t.Fatal("expected relative skill-local config to resolve wiki root")
	}
	if root != wikiRoot {
		t.Fatalf("unexpected root: got %s want %s", root, wikiRoot)
	}
}

func runCLI(t *testing.T, root string, args ...string) (string, string, int) {
	t.Helper()
	fullArgs := append([]string{"run", ".", "--root", root}, args...)
	cmd := exec.Command("go", fullArgs...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), "", 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return "", string(out), exit.ExitCode()
	}
	t.Fatal(err)
	return "", "", 1
}

func runCLIWithStdin(t *testing.T, root, stdin string, args ...string) (string, string, int) {
	t.Helper()
	fullArgs := append([]string{"run", ".", "--root", root}, args...)
	cmd := exec.Command("go", fullArgs...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), "", 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return "", string(out), exit.ExitCode()
	}
	t.Fatal(err)
	return "", "", 1
}

func TestContextPrintsAgentContext(t *testing.T) {
	root := copyWiki(t)

	stdout, stderr, code := runCLI(t, root, "context")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "# Agent 上下文") || !strings.Contains(stdout, "样例知识条目") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
}

func TestContextRefreshesBeforePrinting(t *testing.T) {
	root := copyWiki(t)
	entry := `---
id: context-refresh
title: Context Refresh
created: 2026-05-10
updated: 2026-05-11
summary: 验证 context 命令会先刷新再输出。
---

# Context Refresh

Fresh entry.
`
	if err := os.WriteFile(filepath.Join(root, "examples", "context-refresh.md"), []byte(entry), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := runCLI(t, root, "context")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "Context Refresh") {
		t.Fatalf("context was not refreshed before printing: %s", stdout)
	}
}

func TestRunSedIsBoundToRoot(t *testing.T) {
	root := copyWiki(t)

	stdout, stderr, code := runCLI(t, root, "run", "sed", "-n", "1,8p", "./examples/hello-world.md")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "title: Hello World — 样例知识条目") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
}

func TestUsefulFeedbackDrivesHotContext(t *testing.T) {
	root := copyWiki(t)

	_, stderr, code := runCLI(t, root, "run", "sed", "-n", "1,8p", "./examples/hello-world.md")
	if code != 0 {
		t.Fatalf("read failed: code=%d stderr=%s", code, stderr)
	}
	stdout, stderr, code := runCLI(t, root, "context")
	if code != 0 {
		t.Fatalf("context failed: code=%d stderr=%s", code, stderr)
	}
	if strings.Contains(stdout, "Hello World — 样例知识条目") && strings.Contains(stdout, "次阅读") {
		t.Fatalf("read-only access should not drive hot context: %s", stdout)
	}

	stdout, stderr, code = runCLI(t, root, "use", "./examples/hello-world.md", "--reason", "回答问题时实际采用")
	if code != 0 {
		t.Fatalf("use failed: code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
	stdout, stderr, code = runCLI(t, root, "context")
	if code != 0 {
		t.Fatalf("context failed: code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "Hello World — 样例知识条目") || !strings.Contains(stdout, "1 次有用") {
		t.Fatalf("useful feedback should drive hot context: %s", stdout)
	}
	entry, _ := os.ReadFile(filepath.Join(root, "examples", "hello-world.md"))
	if !strings.Contains(string(entry), "used_count: 1") ||
		!strings.Contains(string(entry), "last_used: ") ||
		!strings.Contains(string(entry), "last_used_reason: 回答问题时实际采用") {
		t.Fatalf("use should update entry frontmatter: %s", entry)
	}
}

func TestMoveKeepsKnowledgeIdentityAndUsefulCount(t *testing.T) {
	root := copyWiki(t)

	_, stderr, code := runCLI(t, root, "use", "./examples/hello-world.md", "--reason", "回答问题时实际采用")
	if code != 0 {
		t.Fatalf("use failed: code=%d stderr=%s", code, stderr)
	}
	stdout, stderr, code := runCLI(t, root, "move", "./examples/hello-world.md", "./guides/hello-world.md", "--category-purpose", "可复用指南")
	if code != 0 {
		t.Fatalf("move failed: code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}

	moved, err := os.ReadFile(filepath.Join(root, "guides", "hello-world.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(moved), "id: hello-world") || !strings.Contains(string(moved), "used_count: 1") {
		t.Fatalf("move should keep id and useful count: %s", moved)
	}
	if _, err := os.Stat(filepath.Join(root, "examples", "hello-world.md")); !os.IsNotExist(err) {
		t.Fatalf("old path should be gone, err=%v", err)
	}
	context, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if !strings.Contains(string(context), "./guides/hello-world.md") || strings.Contains(string(context), "./examples/hello-world.md") {
		t.Fatalf("context should use moved path: %s", context)
	}
	meta, _ := os.ReadFile(filepath.Join(root, "guides", ".meta.yaml"))
	if !strings.Contains(string(meta), "summary: 可复用指南") {
		t.Fatalf("move should create directory meta: %s", meta)
	}
}

func TestRemoveDeletesKnowledgeRefreshesContextAndPrunesEmptyDirs(t *testing.T) {
	root := copyWiki(t)
	if err := os.MkdirAll(filepath.Join(root, "general-engineering"), 0o755); err != nil {
		t.Fatal(err)
	}
	meta := "id: general-engineering\ntitle: general-engineering\nsummary: 通用工程知识\n"
	if err := os.WriteFile(filepath.Join(root, "general-engineering", ".meta.yaml"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := `---
id: service-idl-overpass
title: Service IDL Overpass
created: 2026-05-10
updated: 2026-05-10
used_count: 0
summary: 说明服务 IDL 与 Overpass 的职责边界。
---

# Service IDL Overpass

Body.
`
	if err := os.WriteFile(filepath.Join(root, "general-engineering", "service-idl-overpass.md"), []byte(entry), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := refreshContext(root); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := runCLI(t, root, "remove", "./general-engineering/service-idl-overpass.md")

	if code != 0 {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(root, "general-engineering", "service-idl-overpass.md")); !os.IsNotExist(err) {
		t.Fatalf("removed knowledge should be gone, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "general-engineering")); !os.IsNotExist(err) {
		t.Fatalf("empty category should be pruned, err=%v", err)
	}
	context, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if strings.Contains(string(context), "service-idl-overpass") || strings.Contains(string(context), "general-engineering") {
		t.Fatalf("context should be refreshed after remove: %s", context)
	}
	if !strings.Contains(stdout, "已删除:general-engineering/service-idl-overpass.md") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
}

func TestMapDefaultsToOneLevelKnowledgeMap(t *testing.T) {
	root := copyWiki(t)

	stdout, stderr, code := runCLI(t, root, "map")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "wiki/") || !strings.Contains(stdout, "examples/ — 兼作模板使用的样例知识条目。") {
		t.Fatalf("map should show first-level directory summaries: %s", stdout)
	}
	if strings.Contains(stdout, "hello-world.md") {
		t.Fatalf("default map depth should not include nested files: %s", stdout)
	}
}

func TestMapDirectoryShowsSimpleFileSummaries(t *testing.T) {
	root := copyWiki(t)

	stdout, stderr, code := runCLI(t, root, "map", "./examples")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "examples/") || !strings.Contains(stdout, "hello-world.md — 演示规范 frontmatter 与正文结构的最小示例。") {
		t.Fatalf("map should show simple file summaries: %s", stdout)
	}
	if strings.Contains(stdout, "title:") || strings.Contains(stdout, "created:") || strings.Contains(stdout, "Hello World — 样例知识条目") {
		t.Fatalf("map should avoid noisy metadata: %s", stdout)
	}
}

func TestRunRejectsDangerousShellTokensAndParentPaths(t *testing.T) {
	root := copyWiki(t)

	_, shellErr, shellCode := runCLI(t, root, "run", "sed", "-n", "1,3p", "./examples/hello-world.md", ";", "pwd")
	_, parentErr, parentCode := runCLI(t, root, "run", "cat", "../wiki/examples/hello-world.md")

	if shellCode == 0 || !strings.Contains(shellErr, "禁止使用 shell 元字符") {
		t.Fatalf("unexpected shell rejection: code=%d err=%s", shellCode, shellErr)
	}
	if parentCode == 0 || !strings.Contains(parentErr, "路径必须以 ./ 开头") {
		t.Fatalf("unexpected parent rejection: code=%d err=%s", parentCode, parentErr)
	}
}

func TestPatchReadsUnifiedDiffFromStdin(t *testing.T) {
	root := copyWiki(t)
	patch := `--- a/examples/hello-world.md
+++ b/examples/hello-world.md
@@ -4,13 +4,13 @@
 created: 2026-05-10
 updated: 2026-05-10
 used_count: 0
-summary: 演示规范 frontmatter 与正文结构的最小示例。
+summary: 展示 agent-wiki stdin patch 能力的最小演示条目。
 ---
 
 # Hello World — 样例知识条目
 
-本文件演示规范的知识条目格式,落地实际知识时请直接覆盖正文。
+本文件演示规范的知识条目格式，也用于验证 CLI 受控 patch 能力。
 
 ## 适用场景
 
`
	patch = strings.Replace(patch, "++++ b/", "+++ b/", 1)

	_, stderr, code := runCLIWithStdin(t, root, patch, "patch")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	entry, _ := os.ReadFile(filepath.Join(root, "examples", "hello-world.md"))
	context, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if !strings.Contains(string(entry), "CLI 受控 patch 能力") {
		t.Fatalf("entry not patched: %s", entry)
	}
	if !strings.Contains(string(context), "stdin patch 能力") {
		t.Fatalf("context not refreshed: %s", context)
	}
}

func TestPatchRejectsArguments(t *testing.T) {
	root := copyWiki(t)

	_, stderr, code := runCLI(t, root, "patch", "--patch-file", "change.patch")

	if code == 0 || !strings.Contains(stderr, "用法: agent-wiki patch < unified.diff") {
		t.Fatalf("unexpected result: code=%d stderr=%s", code, stderr)
	}
}

func TestAddCreatesEntryIndexesContextAndRecordsCreate(t *testing.T) {
	root := copyWiki(t)
	body := "# 服务开发速查\n\n源头在 IDL，Overpass 只负责生成，服务仓库只拉依赖和写实现。\n"
	fullArgs := []string{
		"run", ".", "--root", root,
		"add", "./rd-workflow/service-dev.md",
		"--title", "服务开发速查",
		"--summary", "说明 IDL、Overpass 与服务仓库之间的最小开发流程。",
		"--body-stdin",
		"--category-purpose", "剪映后端研发流程知识",
	}
	cmd := exec.Command("go", fullArgs...)
	cmd.Stdin = strings.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("add failed: %v\n%s", err, out)
	}

	entry, _ := os.ReadFile(filepath.Join(root, "rd-workflow", "service-dev.md"))
	categoryMeta, _ := os.ReadFile(filepath.Join(root, "rd-workflow", ".meta.yaml"))
	context, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if !strings.Contains(string(entry), "title: 服务开发速查") {
		t.Fatalf("entry missing frontmatter: %s", entry)
	}
	if strings.Contains(string(entry), "tags:") {
		t.Fatalf("entry should not include tags frontmatter: %s", entry)
	}
	if !strings.Contains(string(categoryMeta), "summary: 剪映后端研发流程知识") {
		t.Fatalf("category meta missing purpose: %s", categoryMeta)
	}
	if !strings.Contains(string(context), "服务开发速查") {
		t.Fatalf("context missing entry: %s", context)
	}
}

func TestCheckReportsValidWiki(t *testing.T) {
	root := copyWiki(t)

	stdout, stderr, code := runCLI(t, root, "check")

	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, "检查通过") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
}

func TestFailedPatchLeavesWikiUnchanged(t *testing.T) {
	root := copyWiki(t)
	path := filepath.Join(root, "examples/hello-world.md")
	before, _ := os.ReadFile(path)
	contextBefore, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	patch := "--- a/examples/hello-world.md\n+++ b/examples/hello-world.md\n@@ -6 +6 @@\n-used_count: 0\n+used_count: 99\n@@ -15 +15 @@\n-does not exist\n+replacement\n"
	_, stderr, code := runCLIWithStdin(t, root, patch, "patch")
	if code == 0 {
		t.Fatal("expected failed patch")
	}
	after, _ := os.ReadFile(path)
	contextAfter, _ := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if string(before) != string(after) || string(contextBefore) != string(contextAfter) {
		t.Fatalf("failed patch changed wiki: %s", stderr)
	}
	if err := cmdCheck(root); err != nil {
		t.Fatal(err)
	}
}

func TestRecentUsefulOrdersExactTimeAndLegacyDates(t *testing.T) {
	entries := []entry{
		{Path: "old.md", FM: frontmatter{Title: "old", UsedCount: 99, LastUsed: "2026-09-07"}},
		{Path: "early.md", FM: frontmatter{Title: "early", UsedCount: 1, LastUsedAt: "2026-09-08T10:00:00Z"}},
		{Path: "late.md", FM: frontmatter{Title: "late", UsedCount: 1, LastUsedAt: "2026-09-08T19:00:00+08:00"}},
		{Path: "invalid.md", FM: frontmatter{Title: "invalid", UsedCount: 1, LastUsed: "invalid"}},
	}
	result := buildRecentUseful(entries)
	if strings.Index(result, "[late]") > strings.Index(result, "[early]") || strings.Index(result, "[early]") > strings.Index(result, "[old]") || strings.Contains(result, "[invalid]") {
		t.Fatal(result)
	}
	path := filepath.Join(copyWiki(t), "examples/hello-world.md")
	if err := incrementUsefulCount(path, "2026-09-08", "test"); err != nil {
		t.Fatal(err)
	}
	fm, err := parseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339Nano, fm.LastUsedAt); err != nil {
		t.Fatal(err)
	}
	if fm.Updated != "2026-05-10" || fm.UsedCount != 1 {
		t.Fatalf("unexpected feedback metadata: %+v", fm)
	}
}

func TestCheckAndSearchHandleResidues(t *testing.T) {
	root := copyWiki(t)
	writeFile(t, filepath.Join(root, "examples/hello-world.md.rej.orig"), "unique-residue-marker")
	if err := cmdCheck(root); err == nil || !strings.Contains(err.Error(), "补丁残留") {
		t.Fatalf("unexpected check: %v", err)
	}
	stdout, _, _ := runCLI(t, root, "run", "rg", "unique-residue-marker", "./")
	if strings.Contains(stdout, "unique-residue-marker") {
		t.Fatal(stdout)
	}
	output, stderr, code := runCLI(t, root, "clean")
	if code != 0 {
		t.Fatal(stderr)
	}
	var backup string
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "恢复目录:") {
			backup = strings.TrimPrefix(line, "恢复目录:")
		}
	}
	if backup == "" {
		t.Fatal(output)
	}
	defer os.RemoveAll(backup)
	data, err := os.ReadFile(filepath.Join(backup, "examples/hello-world.md.rej.orig"))
	if err != nil || string(data) != "unique-residue-marker" {
		t.Fatalf("missing backup: %v", err)
	}
	if err := cmdCheck(root); err != nil {
		t.Fatal(err)
	}
}

func TestPatchRejectsMismatchedOldPath(t *testing.T) {
	root := copyWiki(t)
	_, err := validatePatchContent(root, []byte("--- a/../../outside.md\n+++ b/examples/hello-world.md\n"))
	if err == nil {
		t.Fatal("unsafe old path accepted")
	}
}
