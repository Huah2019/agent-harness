package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func isReferencePath(rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "references" {
			return true
		}
	}
	return false
}

func isReferenceRel(rel string) bool {
	return isReferencePath(rel) && isKebabMD(filepath.Base(rel)) && filepath.Base(rel) != "AGENT_CONTEXT.md"
}

// References have no registration, metadata or usage counters. Their incoming
// Markdown links are the only relationship to knowledge entries.
func cmdRef(root string, args []string) error {
	if len(args) < 2 {
		return errors.New("用法: ref <add|move|remove> ./category/references/document.md ...")
	}
	op := args[0]
	oldPath, oldRel, err := resolveReferencePath(root, args[1])
	if err != nil {
		return err
	}
	switch op {
	case "add":
		flags := flag.NewFlagSet("ref add", flag.ContinueOnError)
		bodyFile := flags.String("body-file", "", "正文文件")
		bodyStdin := flags.Bool("body-stdin", false, "从 stdin 读取正文")
		if err := flags.Parse(args[2:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || (*bodyFile == "") == !*bodyStdin {
			return errors.New("ref add 必须且只能指定 --body-file 或 --body-stdin")
		}
		if _, err := os.Lstat(oldPath); !os.IsNotExist(err) {
			return fmt.Errorf("引用目标已存在或不可访问:%s", oldRel)
		}
		var body []byte
		if *bodyStdin {
			body, err = io.ReadAll(os.Stdin)
		} else {
			body, err = os.ReadFile(*bodyFile)
		}
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(body)) == 0 || fmRe.Match(body) {
			return errors.New("引用文档需为非空普通 Markdown，不允许知识 frontmatter")
		}
		if err := commitReferenceChanges(root, map[string][]byte{oldRel: body}); err != nil {
			return err
		}
		fmt.Println("已创建引用文档:" + oldRel)
		return nil
	case "move", "remove":
		want := 2
		if op == "move" {
			want = 3
		}
		if len(args) != want {
			return errors.New("ref move 需要源和目标路径；ref remove 只需要源路径")
		}
		info, err := os.Lstat(oldPath)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("引用文档必须是普通文件")
		}
		docs, err := referenceDocuments(root)
		if err != nil {
			return err
		}
		newRel := ""
		if op == "move" {
			newPath, rel, err := resolveReferencePath(root, args[2])
			if err != nil {
				return err
			}
			if _, err := os.Lstat(newPath); !os.IsNotExist(err) {
				return fmt.Errorf("目标已存在或不可访问:%s", rel)
			}
			newRel = rel
		}
		changes := map[string][]byte{oldRel: nil}
		for source, data := range docs {
			destination := source
			if source == oldRel && op == "move" {
				destination = newRel
			}
			links := markdownLinks(data)
			text := string(data)
			for i := len(links) - 1; i >= 0; i-- {
				link := links[i]
				target, suffix, local, err := localLink(source, link.target)
				if err != nil {
					return err
				}
				if !local {
					continue
				}
				if op == "remove" {
					if target == oldRel && source != oldRel {
						return fmt.Errorf("引用文档仍被 %s 引用，请先处理链接", source)
					}
					continue
				}
				if target != oldRel && source != oldRel {
					continue
				}
				if target == oldRel {
					target = newRel
				}
				rel, err := filepath.Rel(filepath.Dir(destination), target)
				if err != nil {
					return err
				}
				rel = filepath.ToSlash(rel)
				if !strings.HasPrefix(rel, ".") {
					rel = "./" + rel
				}
				replacement := (&url.URL{Path: rel}).EscapedPath() + suffix
				text = text[:link.start] + replacement + text[link.end:]
			}
			if source == oldRel {
				if op == "move" {
					changes[newRel] = []byte(text)
				}
			} else if text != string(data) {
				changes[source] = []byte(text)
			}
		}
		if err := commitReferenceChanges(root, changes); err != nil {
			return err
		}
		fmt.Printf("引用文档 %s 完成:%s\n", op, oldRel)
		return nil
	default:
		return fmt.Errorf("未知 ref 子命令:%s", op)
	}
}

func resolveReferencePath(root, raw string) (string, string, error) {
	abs, rel, err := resolveUserPath(root, raw)
	if err != nil {
		return "", "", err
	}
	if !isReferenceRel(rel) {
		return "", "", errors.New("引用文档必须位于 references/ 下，使用 kebab-case.md 文件名")
	}
	cur := root
	for _, part := range strings.Split(rel, "/") {
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return "", "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", "", errors.New("引用路径不允许符号链接")
		}
	}
	return abs, rel, nil
}

func referenceDocuments(root string) (map[string][]byte, error) {
	docs := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("不支持符号链接:%s", path)
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() || (!isKnowledgeRel(rel) && !isReferenceRel(rel)) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err == nil {
			docs[rel] = data
		}
		return err
	})
	return docs, err
}

type documentLink struct {
	start, end int
	target     string
}

// Recognize inline Markdown destinations and reference definitions. Code spans,
// fenced code and HTML comments are masked so examples are never rewritten.
var inlineLinkRE = regexp.MustCompile(`!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+))(?:\s+[^\n)]*)?\)`)
var definitionLinkRE = regexp.MustCompile(`(?m)^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))`)
var codeSpanRE = regexp.MustCompile("`+[^`\n]*`+")
var commentRE = regexp.MustCompile(`(?s)<!--.*?-->`)

func markdownLinks(data []byte) []documentLink {
	masked := append([]byte{}, data...)
	mask := func(start, end int) {
		for i := start; i < end; i++ {
			if masked[i] != '\n' {
				masked[i] = ' '
			}
		}
	}
	fence := byte(0)
	fenceLen := 0
	offset := 0
	for _, line := range strings.SplitAfter(string(data), "\n") {
		trim := strings.TrimLeft(line, " \t")
		n := 0
		if len(trim) > 0 && (trim[0] == '`' || trim[0] == '~') {
			for n < len(trim) && trim[n] == trim[0] {
				n++
			}
		}
		if fence != 0 {
			mask(offset, offset+len(line))
			if n >= fenceLen && trim[0] == fence && strings.TrimSpace(trim[n:]) == "" {
				fence = 0
			}
		} else if n >= 3 {
			fence, fenceLen = trim[0], n
			mask(offset, offset+len(line))
		} else if strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
			mask(offset, offset+len(line))
		}
		offset += len(line)
	}
	for _, re := range []*regexp.Regexp{commentRE, codeSpanRE} {
		for _, m := range re.FindAllIndex(masked, -1) {
			mask(m[0], m[1])
		}
	}
	var links []documentLink
	for _, re := range []*regexp.Regexp{inlineLinkRE, definitionLinkRE} {
		for _, m := range re.FindAllSubmatchIndex(masked, -1) {
			a, b := m[2], m[3]
			if a < 0 {
				a, b = m[4], m[5]
			}
			links = append(links, documentLink{a, b, string(data[a:b])})
		}
	}
	sort.Slice(links, func(i, j int) bool { return links[i].start < links[j].start })
	return links
}

func localLink(source, target string) (string, string, bool, error) {
	u, err := url.Parse(target)
	if err != nil {
		return "", "", false, fmt.Errorf("无效链接 %s: %w", source, err)
	}
	if u.IsAbs() || u.Host != "" || strings.HasPrefix(u.Path, "/") || u.Path == "" {
		return "", "", false, nil
	}
	rel := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(source), u.Path)))
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", "", false, fmt.Errorf("链接超出知识库:%s -> %s", source, target)
	}
	suffix := ""
	if i := strings.IndexAny(target, "?#"); i >= 0 {
		suffix = target[i:]
	}
	return rel, suffix, true, nil
}

func checkReferences(root string) error {
	docs, err := referenceDocuments(root)
	if err != nil {
		return err
	}
	incoming := map[string]int{}
	var problems []string
	for source, data := range docs {
		for _, link := range markdownLinks(data) {
			target, _, local, err := localLink(source, link.target)
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			if !local {
				continue
			}
			if !isKnowledgeRel(target) && !isReferenceRel(target) {
				continue
			}
			if _, ok := docs[target]; !ok {
				problems = append(problems, fmt.Sprintf("引用不存在:%s -> %s", source, target))
				continue
			}
			if source != target {
				incoming[target]++
			}
		}
	}
	sort.Strings(problems)
	if len(problems) > 0 {
		return fmt.Errorf("引用检查失败:\n- %s", strings.Join(problems, "\n- "))
	}
	var orphans []string
	for rel := range docs {
		if isReferenceRel(rel) && incoming[rel] == 0 {
			orphans = append(orphans, rel)
		}
	}
	sort.Strings(orphans)
	for _, rel := range orphans {
		fmt.Fprintln(os.Stderr, "警告:未被引用的文档:"+rel)
	}
	return nil
}

// Validate in an isolated copy, then commit with rollback on write errors.
// run() holds the root lock; compare originals to detect non-CLI edits as well.
func commitReferenceChanges(root string, changes map[string][]byte) error {
	stage, err := os.MkdirTemp("", "agent-wiki-ref-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	originals := map[string][]byte{}
	modes := map[string]fs.FileMode{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("知识库不允许符号链接")
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(stage, rel), 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		originals[filepath.ToSlash(rel)], modes[filepath.ToSlash(rel)] = data, info.Mode().Perm()
		return os.WriteFile(filepath.Join(stage, rel), data, info.Mode().Perm())
	})
	if err != nil {
		return err
	}
	for rel, data := range changes {
		path := filepath.Join(stage, rel)
		if data == nil {
			err = os.Remove(path)
		} else {
			err = os.MkdirAll(filepath.Dir(path), 0755)
			if err == nil {
				err = os.WriteFile(path, data, 0644)
			}
			if err == nil && isKnowledgeRel(rel) {
				err = bumpUpdated(path, time.Now().Format("2006-01-02"))
			}
		}
		if err != nil {
			return err
		}
	}
	if err := refreshContext(stage); err != nil {
		return err
	}
	if err := cmdCheck(stage); err != nil {
		return err
	}
	context, err := os.ReadFile(filepath.Join(stage, "AGENT_CONTEXT.md"))
	if err != nil {
		return err
	}
	if !bytes.Equal(context, originals["AGENT_CONTEXT.md"]) {
		changes["AGENT_CONTEXT.md"] = context
	}
	var paths []string
	for rel := range changes {
		current, err := os.ReadFile(filepath.Join(root, rel))
		original, existed := originals[rel]
		if (existed && (err != nil || !bytes.Equal(current, original))) || (!existed && !os.IsNotExist(err)) {
			return fmt.Errorf("文件已变化，取消提交:%s", rel)
		}
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	var committed []string
	for _, rel := range paths {
		path := filepath.Join(root, rel)
		if changes[rel] == nil {
			err = os.Remove(path)
		} else {
			var data []byte
			data, err = os.ReadFile(filepath.Join(stage, rel))
			if err == nil {
				err = os.MkdirAll(filepath.Dir(path), 0755)
			}
			mode := modes[rel]
			if mode == 0 {
				mode = 0644
			}
			if err == nil {
				err = atomicWrite(path, data, mode)
			}
		}
		if err != nil {
			for i := len(committed) - 1; i >= 0; i-- {
				r := committed[i]
				if data, ok := originals[r]; ok {
					err = errors.Join(err, atomicWrite(filepath.Join(root, r), data, modes[r]))
				} else {
					err = errors.Join(err, os.Remove(filepath.Join(root, r)))
				}
			}
			return fmt.Errorf("提交失败，已尝试回滚:%w", err)
		}
		committed = append(committed, rel)
	}
	return nil
}
