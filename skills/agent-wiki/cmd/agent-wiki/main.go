package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var fmRe = regexp.MustCompile(`(?s)^---\s*\n(.*?)\n---\s*\n`)

const defaultWikiDirName = "wiki"

type frontmatter struct {
	ID         string
	Title      string
	Summary    string
	Updated    string
	UsedCount  int
	LastUsed   string
	LastUsedAt string
	LastReason string
}

type dirMeta struct {
	ID      string
	Title   string
	Summary string
}

type entry struct {
	Path string
	FM   frontmatter
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--internal-log-write" {
		if err := writeUsageLog(os.Args[2], os.Stdin); err != nil {
			os.Exit(1)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) (result error) {
	root, rest, err := parseRoot(args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("用法: agent-wiki --root <dir> <context|map|add|use|move|remove|run|patch|clean|check>")
	}
	// Serialize CLI operations across processes; lock files live outside the wiki.
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(os.TempDir(), fmt.Sprintf("agent-wiki-%x.lock", sha256.Sum256([]byte(canonical)))), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	if rest[0] == "logs" {
		return queryUsageLogs(canonical, rest[1:])
	}
	event := newUsageEvent(canonical, rest)
	defer func() { event.finish(canonical, result); recordUsageEvent(canonical, event) }()
	switch rest[0] {
	case "context":
		return cmdContext(root)
	case "map":
		return cmdMap(root, rest[1:])
	case "add":
		return cmdAdd(root, rest[1:])
	case "use":
		return cmdUse(root, rest[1:])
	case "move":
		return cmdMove(root, rest[1:])
	case "remove":
		return cmdRemove(root, rest[1:])
	case "run":
		return cmdRun(root, rest[1:])
	case "patch":
		return cmdPatch(root, rest[1:])
	case "clean":
		return cmdClean(root, rest[1:])
	case "check":
		return cmdCheck(root)
	default:
		return fmt.Errorf("未知命令:%s", rest[0])
	}
}

func parseRoot(args []string) (string, []string, error) {
	root := ""
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "--root" {
			if i+1 >= len(args) {
				return "", nil, errors.New("缺少 --root 参数值")
			}
			root = args[i+1]
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	if root == "" {
		root = os.Getenv("AGENT_WIKI_ROOT")
	}
	if root == "" {
		var err error
		root, err = defaultRoot()
		if err != nil {
			return "", nil, err
		}
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", nil, err
	}
	return abs, rest, nil
}

func defaultRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if ok {
		if root, ok := wikiRootFromSource(file); ok {
			return root, nil
		}
	}
	if exe, err := os.Executable(); err == nil {
		if root, ok := wikiRootFromExecutable(exe); ok {
			return root, nil
		}
	}
	return "", errors.New("无法定位 agent-wiki 根目录:请通过 skill 自带的 agent-wiki 命令运行,或传入 --root / 设置 AGENT_WIKI_ROOT")
}

func wikiRootFromSource(file string) (string, bool) {
	abs, err := filepath.Abs(file)
	if err != nil {
		return "", false
	}
	skillDir := filepath.Clean(filepath.Join(filepath.Dir(abs), "..", ".."))
	if root, ok := wikiRootFromSkillDir(skillDir); ok {
		return root, true
	}
	root := filepath.Join(skillDir, defaultWikiDirName)
	return root, isWikiRoot(root)
}

func wikiRootFromExecutable(exe string) (string, bool) {
	abs, err := filepath.Abs(exe)
	if err != nil {
		return "", false
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	skillDir := filepath.Dir(filepath.Dir(abs))
	if root, ok := wikiRootFromSkillDir(skillDir); ok {
		return root, true
	}
	root := filepath.Join(skillDir, defaultWikiDirName)
	return root, isWikiRoot(root)
}

func wikiRootFromSkillDir(skillDir string) (string, bool) {
	configPath := filepath.Join(skillDir, "agent-wiki.yaml")
	root, ok := readWikiRootConfig(configPath)
	if !ok {
		return "", false
	}
	if !filepath.IsAbs(root) {
		root = filepath.Join(skillDir, root)
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	if !isWikiRoot(abs) {
		return "", false
	}
	return abs, true
}

func readWikiRootConfig(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(key) != "wiki_root" {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		return val, val != ""
	}
	return "", false
}

func isWikiRoot(path string) bool {
	if _, err := os.Stat(filepath.Join(path, ".meta.yaml")); err != nil {
		return false
	}
	return true
}

func cmdContext(root string) error {
	if err := refreshContext(root); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(root, "AGENT_CONTEXT.md"))
	if err != nil {
		return err
	}
	fmt.Print(string(data))
	return nil
}

func cmdMap(root string, args []string) error {
	fs := flag.NewFlagSet("map", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	depth := fs.Int("depth", 1, "展开目录深度")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 1 {
		return errors.New("用法: agent-wiki map [./dir] [--depth N]")
	}
	start := root
	rel := "."
	if fs.NArg() == 1 {
		var err error
		start, rel, err = resolveUserPath(root, fs.Arg(0))
		if err != nil {
			return err
		}
		st, err := os.Stat(start)
		if err != nil {
			return err
		}
		if !st.IsDir() {
			return fmt.Errorf("map 只能查看目录:%s", rel)
		}
	}
	if *depth < 1 {
		return errors.New("map --depth 必须 >= 1")
	}
	fmt.Print(buildMap(root, start, rel, *depth))
	return nil
}

func cmdUse(root string, args []string) error {
	if len(args) == 0 {
		return errors.New("用法: agent-wiki use ./category/topic.md --reason ...")
	}
	pathArg := args[0]
	fs := flag.NewFlagSet("use", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	reason := fs.String("reason", "", "说明本条知识对当前任务的实际帮助")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("用法: agent-wiki use ./category/topic.md --reason ...")
	}
	if strings.TrimSpace(*reason) == "" {
		return errors.New("use 需要 --reason 说明实际用途")
	}
	_, rel, err := resolveUserPath(root, pathArg)
	if err != nil {
		return err
	}
	if !isKnowledgeRel(rel) {
		return fmt.Errorf("use 只能标记知识条目:%s", rel)
	}
	target := filepath.Join(root, rel)
	if _, err := os.Stat(target); err != nil {
		return err
	}
	if err := incrementUsefulCount(target, time.Now().Format("2006-01-02"), *reason); err != nil {
		return err
	}
	if err := refreshContext(root); err != nil {
		return err
	}
	fmt.Printf("已标记有用:%s\n", rel)
	return nil
}

func cmdMove(root string, args []string) error {
	if len(args) < 2 {
		return errors.New("用法: agent-wiki move ./old.md ./new.md --category-purpose ...")
	}
	oldArg, newArg := args[0], args[1]
	fs := flag.NewFlagSet("move", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	categoryPurpose := fs.String("category-purpose", "", "新建目录时写入 .meta.yaml 的用途说明")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("用法: agent-wiki move ./old.md ./new.md --category-purpose ...")
	}
	oldPath, oldRel, err := resolveUserPath(root, oldArg)
	if err != nil {
		return err
	}
	newPath, newRel, err := resolveUserPath(root, newArg)
	if err != nil {
		return err
	}
	if !isKnowledgeRel(oldRel) || !isKnowledgeRel(newRel) {
		return fmt.Errorf("move 只能移动知识条目:%s -> %s", oldRel, newRel)
	}
	if _, err := os.Stat(oldPath); err != nil {
		return err
	}
	if _, err := os.Stat(newPath); err == nil {
		return fmt.Errorf("目标知识条目已存在:%s", newRel)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		return err
	}
	if err := ensureMetasForPath(root, filepath.Dir(newPath), *categoryPurpose); err != nil {
		return err
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	if err := refreshContext(root); err != nil {
		return err
	}
	fmt.Printf("已移动:%s -> %s\n", oldRel, newRel)
	return nil
}

func cmdRemove(root string, args []string) error {
	if len(args) != 1 {
		return errors.New("用法: agent-wiki remove ./category/topic.md")
	}
	target, rel, err := resolveUserPath(root, args[0])
	if err != nil {
		return err
	}
	if !isKnowledgeRel(rel) {
		return fmt.Errorf("remove 只能删除知识条目:%s", rel)
	}
	if _, err := os.Stat(target); err != nil {
		return err
	}
	if err := os.Remove(target); err != nil {
		return err
	}
	if err := pruneEmptyDirs(root, filepath.Dir(target)); err != nil {
		return err
	}
	if err := refreshContext(root); err != nil {
		return err
	}
	fmt.Printf("已删除:%s\n", rel)
	return nil
}

func cmdAdd(root string, args []string) error {
	if len(args) > 0 && strings.HasPrefix(args[0], "./") {
		args = append(args[1:], args[0])
	}
	fs := flag.NewFlagSet("add", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	title := fs.String("title", "", "知识标题")
	summary := fs.String("summary", "", "一句话摘要")
	bodyStdin := fs.Bool("body-stdin", false, "从 stdin 读取正文")
	bodyFile := fs.String("body-file", "", "从文件读取正文")
	categoryPurpose := fs.String("category-purpose", "", "新建目录时写入 .meta.yaml 的用途说明")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("用法: agent-wiki add ./category/topic.md --title ... --summary ... --body-stdin")
	}
	if *title == "" || *summary == "" {
		return errors.New("add 需要 --title、--summary")
	}
	if (*bodyStdin && *bodyFile != "") || (!*bodyStdin && *bodyFile == "") {
		return errors.New("必须且只能使用 --body-stdin 或 --body-file")
	}
	target, rel, err := resolveUserPath(root, fs.Arg(0))
	if err != nil {
		return err
	}
	if !isKnowledgeRel(rel) {
		return fmt.Errorf("add 只能创建知识条目:%s", rel)
	}
	if _, err := os.Stat(target); err == nil {
		return fmt.Errorf("知识条目已存在:%s", rel)
	} else if !os.IsNotExist(err) {
		return err
	}
	var body []byte
	if *bodyStdin {
		body, err = os.ReadFile("/dev/stdin")
	} else {
		body, err = os.ReadFile(*bodyFile)
	}
	if err != nil {
		return err
	}
	bodyText := strings.TrimLeft(string(body), "\n")
	if strings.TrimSpace(bodyText) == "" {
		return errors.New("正文不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if err := ensureMetasForPath(root, filepath.Dir(target), *categoryPurpose); err != nil {
		return err
	}
	now := time.Now().Format("2006-01-02")
	id := strings.TrimSuffix(filepath.Base(rel), ".md")
	text := fmt.Sprintf("---\nid: %s\ntitle: %s\ncreated: %s\nupdated: %s\nused_count: 0\nsummary: %s\n---\n\n%s",
		id, *title, now, now, *summary, bodyText)
	if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
		return err
	}
	if err := refreshContext(root); err != nil {
		return err
	}
	fmt.Printf("已创建:%s\n", rel)
	return nil
}

func cmdRun(root string, args []string) error {
	if len(args) == 0 {
		return errors.New("用法: agent-wiki run <allowed-command> [args...]")
	}
	name := args[0]
	allowed := map[string]bool{
		"rg": true, "sed": true, "cat": true, "nl": true, "ls": true, "find": true,
	}
	if !allowed[name] {
		return fmt.Errorf("命令不在 allowlist 中:%s", name)
	}
	for _, arg := range args[1:] {
		if isShellMeta(arg) {
			return fmt.Errorf("禁止使用 shell 元字符:%s", arg)
		}
		if looksLikePath(arg) {
			if _, _, err := resolveUserPath(root, arg); err != nil {
				return err
			}
		}
	}
	commandArgs := append([]string{}, args[1:]...)
	if name == "rg" {
		commandArgs = append([]string{"--glob", "!*.orig", "--glob", "!*.rej"}, commandArgs...)
	}
	cmd := exec.Command(name, commandArgs...)
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

func cmdPatch(root string, args []string) error {
	if len(args) != 0 {
		return errors.New("用法: agent-wiki patch < unified.diff")
	}
	patchContent, err := readPatchContent(os.Stdin)
	if err != nil {
		return err
	}
	changed, err := validatePatchContent(root, patchContent)
	if err != nil {
		return err
	}
	// Apply in isolation: even a partially successful patch cannot touch live entries.
	stage, err := os.MkdirTemp("", "agent-wiki-patch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	originals := map[string][]byte{}
	modes := map[string]fs.FileMode{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, _ := filepath.Rel(root, path)
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("不支持知识库内的符号链接:%s", rel)
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(stage, rel), 0755)
		}
		if !strings.HasSuffix(rel, ".md") && d.Name() != ".meta.yaml" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		originals[rel], modes[rel] = data, info.Mode().Perm()
		return os.WriteFile(filepath.Join(stage, rel), data, info.Mode().Perm())
	})
	if err != nil {
		return err
	}
	cmd := exec.Command("patch", "--batch", "-p1")
	cmd.Dir = stage
	cmd.Stdin = bytes.NewReader(patchContent)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("patch 失败，知识库未修改:%v\n%s", err, out)
	}
	today := time.Now().Format("2006-01-02")
	for rel := range changed {
		if err := bumpUpdated(filepath.Join(stage, rel), today); err != nil {
			return err
		}
	}
	// Backups created by patch are confined to the temporary directory.
	if err := filepath.WalkDir(stage, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && isPatchResidue(d.Name()) {
			return os.Remove(path)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := refreshContext(stage); err != nil {
		return err
	}
	if err := cmdCheck(stage); err != nil {
		return err
	}
	// Detect edits made outside this CLI before committing.
	for rel, original := range originals {
		current, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil || !bytes.Equal(current, original) {
			return fmt.Errorf("文件已变化，取消提交:%s", rel)
		}
	}
	changed["AGENT_CONTEXT.md"] = true
	paths := make([]string, 0, len(changed))
	for rel := range changed {
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	var committed []string
	for _, rel := range paths {
		data, err := os.ReadFile(filepath.Join(stage, rel))
		if err == nil {
			err = atomicWrite(filepath.Join(root, rel), data, modes[rel])
		}
		if err != nil {
			for i := len(committed) - 1; i >= 0; i-- {
				restored := committed[i]
				err = errors.Join(err, atomicWrite(filepath.Join(root, restored), originals[restored], modes[restored]))
			}
			return fmt.Errorf("提交失败，已尝试回滚:%w", err)
		}
		committed = append(committed, rel)
	}

	fmt.Print(string(out))
	fmt.Println("已刷新索引和上下文")
	return nil
}

func readPatchContent(stdin io.Reader) ([]byte, error) {
	content, err := io.ReadAll(stdin)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(content)) == 0 {
		return nil, errors.New("缺少 patch 内容: 请通过 stdin 传入 unified diff")
	}
	return content, nil
}

func cmdCheck(root string) error {
	var problems []string
	ids := map[string]string{}
	if _, err := os.Stat(filepath.Join(root, ".meta.yaml")); err != nil {
		problems = append(problems, "缺少根 .meta.yaml")
	}
	if _, err := os.Stat(filepath.Join(root, "AGENT_CONTEXT.md")); err != nil {
		problems = append(problems, "缺少 AGENT_CONTEXT.md")
	}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if _, err := parseDirMeta(filepath.Join(path, ".meta.yaml")); err != nil {
				problems = append(problems, fmt.Sprintf("目录缺少 .meta.yaml:%s", rel))
			}
			return nil
		}
		if isPatchResidue(d.Name()) {
			problems = append(problems, "补丁残留:"+rel)
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".md") || d.Name() == "AGENT_CONTEXT.md" {
			return nil
		}
		if !isKebabMD(d.Name()) {
			problems = append(problems, fmt.Sprintf("文件名不是 kebab-case.md:%s", rel))
		}
		fm, err := parseFile(path)
		if err != nil {
			problems = append(problems, fmt.Sprintf("frontmatter 无效:%s", rel))
			return nil
		}
		if fm.ID == "" || fm.Title == "" || fm.Summary == "" || fm.Updated == "" {
			problems = append(problems, fmt.Sprintf("frontmatter 字段不完整:%s", rel))
		}
		if fm.ID != "" {
			if prev, ok := ids[fm.ID]; ok {
				problems = append(problems, fmt.Sprintf("重复 id:%s (%s, %s)", fm.ID, prev, rel))
			} else {
				ids[fm.ID] = rel
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(problems) > 0 {
		return fmt.Errorf("检查失败:\n- %s", strings.Join(problems, "\n- "))
	}
	fmt.Println("检查通过")
	return nil
}

func pruneEmptyDirs(root, start string) error {
	root = filepath.Clean(root)
	for dir := filepath.Clean(start); dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)); dir = filepath.Dir(dir) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		onlyMeta := true
		for _, entry := range entries {
			if entry.Name() != ".meta.yaml" {
				onlyMeta = false
				break
			}
		}
		if !onlyMeta {
			return nil
		}
		if err := os.Remove(filepath.Join(dir, ".meta.yaml")); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Remove(dir); err != nil {
			return err
		}
	}
	return nil
}

func isShellMeta(arg string) bool {
	switch arg {
	case ";", "&&", "||", "|", ">", ">>", "<":
		return true
	}
	return strings.Contains(arg, "$(") || strings.Contains(arg, "`")
}

func looksLikePath(arg string) bool {
	return strings.HasPrefix(arg, "./") || strings.HasPrefix(arg, "../") || strings.HasPrefix(arg, "/")
}

func resolveUserPath(root, raw string) (string, string, error) {
	if !strings.HasPrefix(raw, "./") {
		return "", "", fmt.Errorf("路径必须以 ./ 开头:%s", raw)
	}
	clean := filepath.Clean(raw)
	if clean == "." {
		return root, ".", nil
	}
	if strings.HasPrefix(clean, "..") {
		return "", "", fmt.Errorf("路径不能包含 ..:%s", raw)
	}
	abs := filepath.Join(root, strings.TrimPrefix(clean, "."+string(filepath.Separator)))
	absRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", err
	}
	parent := filepath.Dir(abs)
	if _, err := os.Stat(parent); err != nil {
		parent = root
	}
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", "", err
	}
	if realParent != absRoot && !strings.HasPrefix(realParent, absRoot+string(filepath.Separator)) {
		return "", "", fmt.Errorf("路径超出绑定目录:%s", raw)
	}
	rel, _ := filepath.Rel(root, abs)
	rel = filepath.ToSlash(rel)
	return abs, rel, nil
}

func isKnowledgeRel(rel string) bool {
	base := filepath.Base(rel)
	return strings.HasSuffix(rel, ".md") && base != "AGENT_CONTEXT.md"
}

func ensureMetasForPath(root, dir, categoryPurpose string) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil {
		return err
	}
	if rel == "." {
		return nil
	}
	cur := root
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for _, part := range parts {
		cur = filepath.Join(cur, part)
		metaPath := filepath.Join(cur, ".meta.yaml")
		if _, err := os.Stat(metaPath); os.IsNotExist(err) {
			summary := "待补充用途说明"
			if categoryPurpose != "" {
				summary = categoryPurpose
			}
			if err := writeDirMeta(metaPath, part, part, summary); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	return nil
}

func writeDirMeta(path, id, title, summary string) error {
	text := fmt.Sprintf("id: %s\ntitle: %s\nsummary: %s\n", id, title, summary)
	return os.WriteFile(path, []byte(text), 0o644)
}

func isKebabMD(name string) bool {
	if !strings.HasSuffix(name, ".md") {
		return false
	}
	stem := strings.TrimSuffix(name, ".md")
	ok, _ := regexp.MatchString(`^[a-z0-9]+(-[a-z0-9]+)*$`, stem)
	return ok
}

func validatePatchContent(root string, content []byte) (map[string]bool, error) {
	changed := map[string]bool{}
	oldPath := ""
	scanner := bufio.NewScanner(bytes.NewReader(content))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "--- ") {
			oldPath = strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(line, "--- ")), "a/")
			continue
		}
		if !strings.HasPrefix(line, "+++ ") {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(line, "+++ "))
		if path == "/dev/null" {
			return nil, errors.New("patch 不支持删除条目，请使用 remove")
		}
		if strings.HasPrefix(path, "b/") {
			path = path[2:]
		}
		if strings.HasPrefix(path, "a/") {
			path = path[2:]
		}
		_, rel, err := resolveUserPath(root, "./"+path)
		if err != nil {
			return nil, err
		}
		if oldPath != rel {
			return nil, fmt.Errorf("patch 仅支持同路径修改已有条目:%s", rel)
		}
		if info, err := os.Lstat(filepath.Join(root, rel)); err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("patch 目标不是已有普通文件:%s", rel)
		}
		if !isKnowledgeRel(rel) {
			return nil, fmt.Errorf("patch 只能修改知识条目:%s", rel)
		}
		changed[rel] = true
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(changed) == 0 {
		return nil, errors.New("patch 中没有可修改的知识条目")
	}
	return changed, nil
}

func bumpUpdated(path, date string) error {
	return updateFrontmatterFields(path, map[string]string{"updated": date})
}

func incrementUsefulCount(path, date, reason string) error {
	fm, err := parseFile(path)
	if err != nil {
		return err
	}
	return updateFrontmatterFields(path, map[string]string{
		"used_count":       strconv.Itoa(fm.UsedCount + 1),
		"last_used":        date,
		"last_used_at":     time.Now().UTC().Format(time.RFC3339Nano),
		"last_used_reason": sanitizeFrontmatterValue(reason),
	})
}

func sanitizeFrontmatterValue(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func updateFrontmatterFields(path string, fields map[string]string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := string(data)
	m := fmRe.FindStringSubmatchIndex(text)
	if m == nil {
		return fmt.Errorf("frontmatter 无效:%s", path)
	}
	fm := text[m[2]:m[3]]
	lines := strings.Split(fm, "\n")
	seen := map[string]bool{}
	for i, line := range lines {
		key, _, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if val, ok := fields[key]; ok {
			lines[i] = key + ": " + val
			seen[key] = true
		}
	}
	for _, key := range orderedFrontmatterKeys(fields) {
		val := fields[key]
		if !seen[key] {
			lines = append(lines, key+": "+val)
		}
	}
	newText := text[:m[2]] + strings.Join(lines, "\n") + text[m[3]:]
	return os.WriteFile(path, []byte(newText), 0o644)
}

func orderedFrontmatterKeys(fields map[string]string) []string {
	preferred := []string{"id", "title", "created", "updated", "used_count", "last_used", "last_used_at", "last_used_reason", "context_mode", "summary"}
	var keys []string
	seen := map[string]bool{}
	for _, key := range preferred {
		if _, ok := fields[key]; ok {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	var extras []string
	for key := range fields {
		if !seen[key] {
			extras = append(extras, key)
		}
	}
	sort.Strings(extras)
	keys = append(keys, extras...)
	return keys
}

func parseFile(path string) (frontmatter, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return frontmatter{}, err
	}
	m := fmRe.FindStringSubmatch(string(data))
	if m == nil {
		return frontmatter{}, errors.New("missing frontmatter")
	}
	fm := frontmatter{}
	for _, line := range strings.Split(m[1], "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		switch strings.TrimSpace(key) {
		case "id":
			fm.ID = val
		case "title":
			fm.Title = val
		case "summary":
			fm.Summary = val
		case "updated":
			fm.Updated = val
		case "used_count":
			n, err := strconv.Atoi(val)
			if err == nil {
				fm.UsedCount = n
			}
		case "last_used":
			fm.LastUsed = val
		case "last_used_at":
			fm.LastUsedAt = val
		case "last_used_reason":
			fm.LastReason = val
		}
	}
	return fm, nil
}

func parseDirMeta(path string) (dirMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return dirMeta{}, err
	}
	meta := dirMeta{}
	for _, line := range strings.Split(string(data), "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		switch strings.TrimSpace(key) {
		case "id":
			meta.ID = val
		case "title":
			meta.Title = val
		case "summary":
			meta.Summary = val
		}
	}
	if meta.ID == "" || meta.Title == "" || meta.Summary == "" {
		return dirMeta{}, fmt.Errorf("目录 meta 字段不完整:%s", path)
	}
	return meta, nil
}

func collectEntries(root string) ([]entry, error) {
	var entries []entry
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			return nil
		}
		if !isKnowledgeRel(rel) {
			return nil
		}
		fm, err := parseFile(path)
		if err != nil {
			return err
		}
		entries = append(entries, entry{Path: rel, FM: fm})
		return nil
	})
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, err
}

func buildMap(root, dir, rel string, depth int) string {
	label := "wiki/"
	if rel != "." {
		label = filepath.ToSlash(rel) + "/"
	}
	var b strings.Builder
	b.WriteString(label)
	if rel != "." {
		if summary := dirSummary(dir); summary != "" {
			b.WriteString(" — " + summary)
		}
	}
	b.WriteString("\n")
	writeMapChildren(&b, root, dir, depth, "")
	return b.String()
}

func writeMapChildren(b *strings.Builder, root, dir string, depth int, indent string) {
	if depth <= 0 {
		return
	}
	children, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var dirs []fs.DirEntry
	var files []fs.DirEntry
	for _, child := range children {
		name := child.Name()
		if name == ".meta.yaml" || name == "AGENT_CONTEXT.md" {
			continue
		}
		if child.IsDir() {
			if _, err := os.Stat(filepath.Join(dir, name, ".meta.yaml")); err == nil {
				dirs = append(dirs, child)
			}
			continue
		}
		if strings.HasSuffix(name, ".md") {
			files = append(files, child)
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name() < dirs[j].Name() })
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for _, child := range dirs {
		childDir := filepath.Join(dir, child.Name())
		b.WriteString(indent + "- " + child.Name() + "/")
		if summary := dirSummary(childDir); summary != "" {
			b.WriteString(" — " + summary)
		}
		b.WriteString("\n")
		writeMapChildren(b, root, childDir, depth-1, indent+"  ")
	}
	for _, child := range files {
		fm, err := parseFile(filepath.Join(dir, child.Name()))
		if err != nil {
			continue
		}
		b.WriteString(indent + "- " + child.Name())
		if fm.Summary != "" {
			b.WriteString(" — " + fm.Summary)
		}
		b.WriteString("\n")
	}
}

func dirSummary(dir string) string {
	meta, err := parseDirMeta(filepath.Join(dir, ".meta.yaml"))
	if err != nil {
		return ""
	}
	return meta.Summary
}

func refreshContext(root string) error {
	entries, err := collectEntries(root)
	if err != nil {
		return err
	}
	text := ensureContext(root)
	text = replaceRegion(text, "top-level", buildTopLevel(root))
	text = replaceRegion(text, "hot", buildHot(root, entries))
	text = replaceRegion(text, "recent", buildRecent(entries))
	text = replaceRegion(text, "recent-useful", buildRecentUseful(entries))
	return os.WriteFile(filepath.Join(root, "AGENT_CONTEXT.md"), []byte(text), 0o644)
}

func ensureContext(root string) string {
	path := filepath.Join(root, "AGENT_CONTEXT.md")
	data, err := os.ReadFile(path)
	if err == nil {
		return string(data)
	}
	return "# Agent 上下文\n\n_以下生成区由 `agent-wiki` CLI 自动维护,请勿手工编辑。_\n\n<!-- BEGIN: top-level -->\n<!-- END: top-level -->\n\n<!-- BEGIN: hot -->\n<!-- END: hot -->\n\n<!-- BEGIN: recent -->\n<!-- END: recent -->\n"
}

func replaceRegion(text, region, body string) string {
	begin := "<!-- BEGIN: " + region + " -->"
	end := "<!-- END: " + region + " -->"
	block := begin + "\n" + body + "\n" + end
	start := strings.Index(text, begin)
	stop := strings.Index(text, end)
	if start >= 0 && stop >= start {
		return text[:start] + block + text[stop+len(end):]
	}
	return strings.TrimRight(text, "\n") + "\n\n" + block + "\n"
}

func buildTopLevel(root string) string {
	var lines []string
	children, err := os.ReadDir(root)
	if err != nil {
		return "## 一级目录\n- _(知识根目录不可读)_"
	}
	for _, child := range children {
		if !child.IsDir() {
			continue
		}
		meta, err := parseDirMeta(filepath.Join(root, child.Name(), ".meta.yaml"))
		if err != nil {
			continue
		}
		lines = append(lines, fmt.Sprintf("- [%s/](./%s/.meta.yaml) — %s", child.Name(), child.Name(), meta.Summary))
	}
	sort.Strings(lines)
	if len(lines) == 0 {
		lines = append(lines, "- _(暂无子目录)_")
	}
	return "## 一级目录\n" + strings.Join(lines, "\n")
}

func buildHot(root string, entries []entry) string {
	type hot struct {
		entry entry
		n     int
	}
	var hots []hot
	for _, e := range entries {
		if e.FM.UsedCount > 0 {
			hots = append(hots, hot{entry: e, n: e.FM.UsedCount})
		}
	}
	sort.Slice(hots, func(i, j int) bool {
		if hots[i].n == hots[j].n {
			return hots[i].entry.Path < hots[j].entry.Path
		}
		return hots[i].n > hots[j].n
	})
	var b strings.Builder
	b.WriteString("## 热点 — 有用反馈 Top 20\n")
	if len(hots) == 0 {
		b.WriteString("_(暂无有用反馈)_")
		return b.String()
	}
	for i, h := range hots {
		if i >= 20 {
			break
		}
		e := h.entry
		b.WriteString(fmt.Sprintf("%d. [%s](./%s) — %s · %d 次有用\n", i+1, e.FM.Title, e.Path, e.FM.Summary, h.n))
	}
	return strings.TrimRight(b.String(), "\n")
}

func buildRecent(entries []entry) string {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].FM.Updated == entries[j].FM.Updated {
			return entries[i].Path < entries[j].Path
		}
		return entries[i].FM.Updated > entries[j].FM.Updated
	})
	var b strings.Builder
	b.WriteString("## 最近 — 按 `updated` 排序 Top 10\n")
	if len(entries) == 0 {
		b.WriteString("_(没有具备合法 `updated` 字段的条目)_")
		return b.String()
	}
	for i, e := range entries {
		if i >= 10 {
			break
		}
		b.WriteString(fmt.Sprintf("%d. [%s](./%s) — %s · 更新于 %s\n", i+1, e.FM.Title, e.Path, e.FM.Summary, e.FM.Updated))
	}
	return strings.TrimRight(b.String(), "\n")
}

func atomicWrite(path string, data []byte, mode fs.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".agent-wiki-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func isPatchResidue(name string) bool {
	return strings.HasSuffix(name, ".orig") || strings.HasSuffix(name, ".rej")
}

// clean archives residues outside the wiki before removing them; rejected edits remain recoverable.
func cmdClean(root string, args []string) error {
	if len(args) != 0 {
		return errors.New("用法: agent-wiki clean (将补丁残留移到外部恢复目录)")
	}
	var paths []string
	if err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && isPatchResidue(d.Name()) {
			paths = append(paths, path)
		}
		return nil
	}); err != nil {
		return err
	}
	if len(paths) == 0 {
		fmt.Println("无补丁残留")
		return nil
	}
	backup, err := os.MkdirTemp("", "agent-wiki-recovery-")
	if err != nil {
		return err
	}
	fmt.Println("恢复目录:" + backup)
	// Finish all backups before removing any original.
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("不是普通残留文件:%s", path)
		}
		rel, _ := filepath.Rel(root, path)
		dst := filepath.Join(backup, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := atomicWrite(dst, data, 0600); err != nil {
			return err
		}
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	fmt.Printf("已归档并清理 %d 个补丁残留\n", len(paths))
	return nil
}

func buildRecentUseful(entries []entry) string {
	type useful struct {
		entry   entry
		at      time.Time
		display string
	}
	var recent []useful
	for _, e := range entries {
		if e.FM.UsedCount <= 0 {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, e.FM.LastUsedAt)
		display := e.FM.LastUsedAt
		if err != nil {
			at, err = time.Parse("2006-01-02", e.FM.LastUsed)
			display = e.FM.LastUsed
		}
		if err == nil {
			recent = append(recent, useful{e, at, display})
		}
	}
	sort.Slice(recent, func(i, j int) bool {
		if recent[i].at.Equal(recent[j].at) {
			return recent[i].entry.Path < recent[j].entry.Path
		}
		return recent[i].at.After(recent[j].at)
	})
	var b strings.Builder
	b.WriteString("## 最近反馈有用 Top 10\n")
	if len(recent) == 0 {
		b.WriteString("_(暂无有用反馈时间)_")
	}
	for i, item := range recent {
		if i >= 10 {
			break
		}
		// Existing lists already carry summaries; keep this additional entry point compact.
		fmt.Fprintf(&b, "%d. [%s](./%s) · 最近有用 %s\n", i+1, item.entry.FM.Title, item.entry.Path, item.display)
	}
	return strings.TrimRight(b.String(), "\n")
}
