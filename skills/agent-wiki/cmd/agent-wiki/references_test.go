package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReferenceLifecycleAndIsolation(t *testing.T) {
	root := copyWiki(t)
	ref := "./examples/references/asset-list.md"
	out, stderr, code := runCLIWithStdin(t, root, "# PrivateReferenceMarker\n\nasset contents\n", "ref", "add", ref, "--body-stdin")
	if code != 0 || !strings.Contains(out, "未被引用") {
		t.Fatalf("add: %s %s", out, stderr)
	}
	for _, args := range [][]string{{"context"}, {"map", "./"}} {
		out, stderr, code = runCLI(t, root, args...)
		if code != 0 || strings.Contains(out, "PrivateReferenceMarker") || strings.Contains(out, "references/") {
			t.Fatalf("isolation %v: %s %s", args, out, stderr)
		}
	}
	if _, _, code = runCLI(t, root, "use", ref, "--reason", "test"); code == 0 {
		t.Fatal("reference accepted use")
	}
	if _, _, code = runCLI(t, root, "map", "./examples/references"); code == 0 {
		t.Fatal("reference accepted map")
	}
	if _, _, code = runCLI(t, root, "run", "rg", "PrivateReferenceMarker", "./"); code == 0 {
		t.Fatal("default search leaked reference")
	}
	out, stderr, code = runCLI(t, root, "run", "rg", "PrivateReferenceMarker", "./examples/references")
	if code != 0 || !strings.Contains(out, "PrivateReferenceMarker") {
		t.Fatalf("explicit search: %s %s", out, stderr)
	}
	patch := "--- a/examples/references/asset-list.md\n+++ b/examples/references/asset-list.md\n@@ -3 +3 @@\n-asset contents\n+updated contents\n"
	if _, stderr, code = runCLIWithStdin(t, root, patch, "patch"); code != 0 {
		t.Fatal(stderr)
	}
	data, _ := os.ReadFile(filepath.Join(root, "examples/references/asset-list.md"))
	if strings.Contains(string(data), "updated:") || strings.Contains(string(data), "used_count") || !strings.Contains(string(data), "updated contents") {
		t.Fatalf("unexpected metadata: %s", data)
	}
	if _, err := os.Stat(filepath.Join(root, "examples/references/.meta.yaml")); !os.IsNotExist(err) {
		t.Fatal("reference directory acquired metadata")
	}
	if _, stderr, code = runCLI(t, root, "ref", "remove", ref); code != 0 {
		t.Fatal(stderr)
	}
}

func TestReferenceMoveRewritesInboundAndOutbound(t *testing.T) {
	root := copyWiki(t)
	entryPath := filepath.Join(root, "examples/hello-world.md")
	entry, _ := os.ReadFile(entryPath)
	entry = append(entry, []byte("\n[assets](./references/assets.md#part)\n[other][r]\n[r]: <./references/assets.md> \"title\"\n`[example](./references/assets.md)`\n```md\n[example](./references/assets.md)\n```\n")...)
	writeFile(t, entryPath, string(entry))
	writeFile(t, filepath.Join(root, "examples/references/assets.md"), "# Assets\n[owner](../hello-world.md)\n[self](./assets.md#part)\n")
	if err := cmdRef(root, []string{"remove", "./examples/references/assets.md"}); err == nil {
		t.Fatal("deleted referenced document")
	}
	if err := cmdRef(root, []string{"move", "./examples/references/assets.md", "./examples/references/nested/assets.md"}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(entryPath)
	for _, expected := range []string{"(./references/nested/assets.md#part)", "<./references/nested/assets.md>", "`[example](./references/assets.md)`", "```md\n[example](./references/assets.md)"} {
		if !strings.Contains(string(data), expected) {
			t.Fatalf("missing %q: %s", expected, data)
		}
	}
	data, _ = os.ReadFile(filepath.Join(root, "examples/references/nested/assets.md"))
	if !strings.Contains(string(data), "(../../hello-world.md)") || !strings.Contains(string(data), "(./assets.md#part)") {
		t.Fatalf("outbound: %s", data)
	}
	if err := cmdCheck(root); err != nil {
		t.Fatal(err)
	}
}

func TestReferenceCheckAndFailedPatchPreserveOriginal(t *testing.T) {
	root := copyWiki(t)
	path := filepath.Join(root, "examples/references/assets.md")
	writeFile(t, path, "# Assets\n")
	patch := "--- a/examples/references/assets.md\n+++ b/examples/references/assets.md\n@@ -1 +1,2 @@\n # Assets\n+[missing](./missing.md)\n"
	if _, _, code := runCLIWithStdin(t, root, patch, "patch"); code == 0 {
		t.Fatal("accepted broken reference")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "# Assets\n" {
		t.Fatalf("failed patch mutated file: %s", data)
	}
	writeFile(t, path, "---\nid: assets\ntitle: Assets\nupdated: 2026-09-10\nsummary: Bad\n---\n# Assets\n")
	if err := cmdCheck(root); err == nil {
		t.Fatal("accepted registered reference")
	}
}

func TestReferencePathAndCreateFailures(t *testing.T) {
	root := copyWiki(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "examples/references")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"./examples/references/new/assets.md", "./../references/assets.md", "./examples/assets.md"} {
		if _, _, err := resolveReferencePath(root, path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	root = copyWiki(t)
	if _, _, code := runCLIWithStdin(t, root, "# X\n[bad](../../../../outside.md)\n", "ref", "add", "./examples/references/assets.md", "--body-stdin"); code == 0 {
		t.Fatal("accepted escaping link")
	}
	if _, err := os.Stat(filepath.Join(root, "examples/references/assets.md")); !os.IsNotExist(err) {
		t.Fatal("failed creation left file")
	}
}
