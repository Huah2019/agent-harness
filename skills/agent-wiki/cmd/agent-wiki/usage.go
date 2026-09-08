package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/DeRuina/timberjack"
)

type usageObject struct {
	Path       string `json:"path"`
	ID         string `json:"id,omitempty"`
	Before     string `json:"before_sha256,omitempty"`
	After      string `json:"after_sha256,omitempty"`
	UsedBefore int    `json:"used_before"`
	UsedAfter  int    `json:"used_after"`
}
type usageEvent struct {
	Schema     int           `json:"schema"`
	ID         string        `json:"event_id"`
	Time       time.Time     `json:"time"`
	Command    string        `json:"command"`
	Args       []string      `json:"args,omitempty"`
	Outcome    string        `json:"outcome"`
	DurationMS int64         `json:"duration_ms"`
	Error      string        `json:"error,omitempty"`
	Objects    []usageObject `json:"objects,omitempty"`
	Truncated  bool          `json:"truncated,omitempty"`
}

func clipped(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}

// Capture only explicit files; a recursive search is not a read of every hit.
// Patch snapshots are compared after execution, so unchanged files are omitted.
func newUsageEvent(root string, args []string) usageEvent {
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	e := usageEvent{Schema: 1, ID: hex.EncodeToString(id), Time: time.Now().UTC(), Command: args[0]}
	skip := false
	for _, a := range args[1:] {
		if skip {
			skip = false
			e.Args = append(e.Args, "[omitted]")
			continue
		}
		if a == "--body" {
			skip = true
		}
		if strings.HasPrefix(a, "--body=") {
			a = "--body=[omitted]"
		}
		// Body arguments are content, not usage metadata.
		if len(e.Args) >= 16 {
			e.Truncated = true
			break
		}
		e.Args = append(e.Args, clipped(a, 256))
		if len(a) > 256 {
			e.Truncated = true
		}
	}
	paths := []string{}
	if args[0] == "patch" {
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			if isKnowledgeRel(rel) {
				if len(paths) >= 128 {
					e.Truncated = true
					return filepath.SkipAll
				}
				paths = append(paths, "./"+filepath.ToSlash(rel))
			}
			return nil
		})
	} else {
		paths = args[1:]
	}
	seen := map[string]bool{}
	for _, a := range paths {
		if !strings.HasPrefix(a, "./") {
			continue
		}
		abs, rel, err := resolveUserPath(root, a)
		if err != nil || !isKnowledgeRel(rel) || seen[rel] {
			continue
		}
		seen[rel] = true
		if len(e.Objects) >= 128 {
			e.Truncated = true
			break
		}
		obj := usageObject{Path: rel}
		obj.ID, obj.Before, obj.UsedBefore = usageSnapshot(abs)
		e.Objects = append(e.Objects, obj)
	}
	return e
}

func usageSnapshot(path string) (string, string, int) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 5<<20 {
		return "", "", 0
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "", 0
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 5<<20 {
		return "", "", 0
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", "", 0
	}
	fm, err := parseFile(path)
	if err != nil {
		return "", hex.EncodeToString(h.Sum(nil)), 0
	}
	return fm.ID, hex.EncodeToString(h.Sum(nil)), fm.UsedCount
}

func (e *usageEvent) finish(root string, err error) {
	e.DurationMS = time.Since(e.Time).Milliseconds()
	e.Outcome = "success"
	if err != nil {
		e.Outcome = "error"
		e.Error = clipped(err.Error(), 512)
	}
	var exit *exec.ExitError
	if e.Command == "run" && len(e.Args) > 0 && e.Args[0] == "rg" && errors.As(err, &exit) && exit.ExitCode() == 1 {
		e.Outcome = "no_match"
		e.Error = ""
	}
	objects := e.Objects[:0]
	for _, o := range e.Objects {
		id, hash, count := usageSnapshot(filepath.Join(root, o.Path))
		if o.ID == "" {
			o.ID = id
		}
		o.After = hash
		o.UsedAfter = count
		if e.Command != "patch" || o.Before != o.After {
			objects = append(objects, o)
		}
	}
	e.Objects = objects
}

func usageLogDir(root string) (string, error) {
	base := os.Getenv("AGENT_WIKI_LOG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "state", "agent-wiki")
	}
	sum := sha256.Sum256([]byte(root))
	return filepath.Join(base, fmt.Sprintf("%x", sum[:16])), nil
}

// The caller holds the wiki lock until the worker has closed and drained its
// maintenance goroutine. Child stderr is isolated from the command's output.
func recordUsageEvent(root string, e usageEvent) {
	if os.Getenv("AGENT_WIKI_LOG_DISABLED") == "1" {
		return
	}
	dir, err := usageLogDir(root)
	if err != nil {
		return
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return
	}
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	for len(data) > 8191 && len(e.Objects) > 0 {
		e.Objects = e.Objects[:len(e.Objects)-1]
		e.Truncated = true
		data, _ = json.Marshal(e)
	}
	for len(data) > 8191 && len(e.Args) > 0 {
		e.Args = e.Args[:len(e.Args)-1]
		e.Truncated = true
		data, _ = json.Marshal(e)
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--internal-log-write", dir)
	cmd.Stdin = bytes.NewReader(append(data, '\n'))
	// Discard library diagnostics; the fixed-size health record exposes failure.
	diagnostics := &limitedLogDiagnostic{}
	cmd.Stderr = diagnostics
	err = cmd.Run()
	if err != nil || diagnostics.text != "" {
		health := map[string]any{"time": time.Now().UTC(), "event_id": e.ID, "error": diagnostics.text}
		if err != nil {
			health["error"] = err.Error()
		}
		b, _ := json.Marshal(health)
		_ = os.WriteFile(filepath.Join(dir, "last-error.json"), b, 0600)
	}
}

type limitedLogDiagnostic struct{ text string }

func (w *limitedLogDiagnostic) Write(p []byte) (int, error) {
	w.text = clipped(w.text+string(p), 1024)
	return len(p), nil
}

func writeUsageLog(dir string, r io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(r, 8193))
	if err != nil {
		return err
	}
	if len(data) > 8192 {
		return errors.New("event too large")
	}
	var e usageEvent
	if err = json.Unmarshal(data, &e); err != nil {
		return err
	}
	logger := &timberjack.Logger{Filename: filepath.Join(dir, "events.jsonl"), MaxSize: 4, MaxAge: 180, MaxBackups: 15, Compression: "gzip", FileMode: 0600}
	_, err = logger.Write(data)
	return errors.Join(err, logger.Close())
}

// Query is intentionally separate from the Agent skill workflow and does not
// create usage events. Reads archives one record at a time; never loads a log.
func queryUsageLogs(root string, args []string) error {
	flags := flag.NewFlagSet("logs", flag.ContinueOnError)
	since := flags.String("since", "", "inclusive RFC3339 timestamp or UTC date")
	command := flags.String("command", "", "command filter")
	limit := flags.Int("limit", 1000, "maximum events")
	status := flags.Bool("status", false, "show location, retained files and last log error")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *limit < 1 {
		return errors.New("limit must be positive")
	}
	var cutoff time.Time
	if *since != "" {
		var err error
		cutoff, err = time.Parse(time.RFC3339, *since)
		if err != nil {
			cutoff, err = time.Parse("2006-01-02", *since)
		}
		if err != nil {
			return err
		}
	}
	dir, err := usageLogDir(root)
	if err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(dir, "events*.jsonl*"))
	if err != nil {
		return err
	}
	if *status {
		health, _ := os.ReadFile(filepath.Join(dir, "last-error.json"))
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"directory": dir, "files": files, "last_error": string(health), "max_file_mib": 4, "max_backups": 15, "max_age_days": 180})
	}
	n := 0
	for _, path := range files {
		if !strings.HasSuffix(path, ".jsonl") && !strings.HasSuffix(path, ".jsonl.gz") {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		var r io.Reader = f
		var gz *gzip.Reader
		if strings.HasSuffix(path, ".gz") {
			gz, err = gzip.NewReader(f)
			if err != nil {
				f.Close()
				return err
			}
			r = gz
		}
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 8192), 16384)
		for scanner.Scan() {
			var e usageEvent
			if err = json.Unmarshal(scanner.Bytes(), &e); err != nil {
				break
			}
			if e.Time.Before(cutoff) || (*command != "" && e.Command != *command) {
				continue
			}
			fmt.Println(string(scanner.Bytes()))
			n++
			if n >= *limit {
				break
			}
		}
		if err == nil {
			err = scanner.Err()
		}
		if gz != nil {
			gz.Close()
		}
		f.Close()
		if err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		if n >= *limit {
			break
		}
	}
	return nil
}
