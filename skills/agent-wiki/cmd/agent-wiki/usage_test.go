package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DeRuina/timberjack"
)

func TestMain(m *testing.M) {
	// Existing command tests must not create production telemetry or spawn the
	// test executable as a worker. Integration tests run the actual CLI below.
	os.Setenv("AGENT_WIKI_LOG_DISABLED", "1")
	os.Exit(m.Run())
}

func TestUsageIntegration(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "agent-wiki")
	build := exec.Command("go", "build", "-o", binary, ".")
	if b, e := build.CombinedOutput(); e != nil {
		t.Fatalf("%s: %v", b, e)
	}
	root := copyWiki(t)
	logBase := t.TempDir()
	env := []string{}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "AGENT_WIKI_LOG_") {
			env = append(env, e)
		}
	}
	env = append(env, "AGENT_WIKI_LOG_DIR="+logBase)
	call := func(args ...string) (string, error) {
		c := exec.Command(binary, append([]string{"--root", root}, args...)...)
		c.Env = env
		b, e := c.CombinedOutput()
		return string(b), e
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b, e := call("use", "./examples/hello-world.md", "--reason", "integration"); e != nil {
				t.Errorf("%s: %v", b, e)
			}
		}()
	}
	wg.Wait()
	if _, e := call("run", "rg", "not-present-xyz", "./"); e == nil {
		t.Fatal("no-match exit changed")
	}
	out, e := call("logs", "--command", "use")
	if e != nil {
		t.Fatal(e)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 8 {
		t.Fatalf("events: %d %s", len(lines), out)
	}
	for i, line := range lines {
		var event usageEvent
		if e = json.Unmarshal([]byte(line), &event); e != nil {
			t.Fatal(e)
		}
		if len(event.Objects) != 1 || event.Objects[0].UsedAfter != i+1 || event.Objects[0].UsedBefore != i {
			t.Fatalf("bad event: %+v", event)
		}
	}
	out, e = call("logs", "--command", "run")
	if e != nil || !strings.Contains(out, `"outcome":"no_match"`) {
		t.Fatalf("%s %v", out, e)
	}
	// A broken log destination cannot break or add diagnostics to a command.
	blocked := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocked, []byte("x"), 0600)
	env = append(env, "AGENT_WIKI_LOG_DIR="+blocked)
	out, e = call("check")
	if e != nil || out != "检查通过\n" {
		t.Fatalf("logging changed output: %q %v", out, e)
	}
}

func TestUsageRetentionAndCompression(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "events.jsonl")
	old := filepath.Join(dir, "events-2020-01-01T00-00-00.000-size.jsonl")
	os.WriteFile(old, []byte("old\n"), 0600)
	// Open/close each time, as a short-lived CLI would. Close must finish gzip.
	for i := 0; i < 4; i++ {
		l := &timberjack.Logger{Filename: file, MaxSize: 1, MaxAge: 180, MaxBackups: 2, Compression: "gzip", FileMode: 0600}
		if _, err := l.Write(bytes.Repeat([]byte("x"), 700000)); err != nil {
			t.Fatal(err)
		}
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("expired archive retained")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.gz"))
	if len(files) != 2 {
		t.Fatalf("backups: %v", files)
	}
	for _, p := range files {
		f, _ := os.Open(p)
		g, e := gzip.NewReader(f)
		if e != nil {
			t.Fatal(e)
		}
		n, e := io.Copy(io.Discard, g)
		g.Close()
		f.Close()
		if e != nil || n != 700000 {
			t.Fatal(fmt.Sprint(n, e))
		}
	}
}
