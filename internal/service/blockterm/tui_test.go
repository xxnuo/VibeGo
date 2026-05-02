package blockterm

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRealVimEditResizeAndReturnToShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix Bash and Vim fixture")
	}
	vim, err := exec.LookPath("vim")
	if err != nil {
		t.Skip("vim unavailable")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "edit.txt")
	if err := os.WriteFile(file, []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("tui", dir, "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "tui"); err != nil {
		t.Fatal(err)
	}
	block, err := s.Submit(info.ID, "tui", "vim", fmt.Sprintf("%q -Nu NONE -i NONE -n -- %q", vim, file))
	if err != nil {
		t.Fatal(err)
	}
	output := func() []byte {
		var result []byte
		for _, event := range allEvents(t, s, info.ID) {
			if event.Type == "output" && event.BlockID == block.ID {
				result = append(result, event.Data...)
			}
		}
		return result
	}
	deadline := time.Now().Add(5 * time.Second)
	for !bytes.Contains(output(), []byte("\x1b[?1049h")) {
		if time.Now().After(deadline) {
			t.Fatalf("Vim never entered alternate screen: %q", output())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := s.Resize(info.ID, "tui", 42, 16); err != nil {
		t.Fatal(err)
	}
	if err := s.Input(info.ID, "tui", []byte("gg0i中文 edited \x1b:wq\r")); err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	contents, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "中文 edited original\n" {
		t.Fatalf("unexpected edit: %q", contents)
	}
	if !bytes.Contains(output(), []byte("\x1b[?1049l")) {
		t.Fatal("Vim did not leave alternate screen")
	}
	blocks, err := s.Blocks(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range blocks {
		if item.ID == block.ID && (item.Status != "done" || item.ExitCode == nil || *item.ExitCode != 0) {
			t.Fatalf("Vim lifecycle: %+v", item)
		}
	}
	next, err := s.Submit(info.ID, "tui", "after-vim", "printf AFTER_VIM")
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	var after []byte
	for _, event := range allEvents(t, s, info.ID) {
		if event.Type == "output" && event.BlockID == next.ID {
			after = append(after, event.Data...)
		}
	}
	if !bytes.Contains(after, []byte("AFTER_VIM")) {
		t.Fatalf("next command output missing: %q", after)
	}
}

func TestRealLessSearchAndReturnToShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix Bash and less fixture")
	}
	less, err := exec.LookPath("less")
	if err != nil {
		t.Skip("less unavailable")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "pages.txt")
	var content bytes.Buffer
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&content, "PAGER_ROW_%03d\n", i)
	}
	if err := os.WriteFile(file, content.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("pager", dir, "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "pager"); err != nil {
		t.Fatal(err)
	}
	block, err := s.Submit(info.ID, "pager", "less", fmt.Sprintf("LESS= LESSOPEN= LESSCLOSE= LESSHISTFILE=- %q -- %q", less, file))
	if err != nil {
		t.Fatal(err)
	}
	output := func() []byte {
		var result []byte
		for _, event := range allEvents(t, s, info.ID) {
			if event.Type == "output" && event.BlockID == block.ID {
				result = append(result, event.Data...)
			}
		}
		return result
	}
	waitOutput := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !bytes.Contains(output(), []byte(marker)) {
			if time.Now().After(deadline) {
				t.Fatalf("missing %q: %q", marker, output())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitOutput("PAGER_ROW_000")
	if err := s.Input(info.ID, "pager", []byte(" ")); err != nil {
		t.Fatal(err)
	}
	waitOutput("PAGER_ROW_030")
	if err := s.Resize(info.ID, "pager", 44, 16); err != nil {
		t.Fatal(err)
	}
	if err := s.Input(info.ID, "pager", []byte("/PAGER_ROW_180\r")); err != nil {
		t.Fatal(err)
	}
	// The adjacent row proves search navigation, not merely the echoed search query.
	waitOutput("PAGER_ROW_181")
	if err := s.Input(info.ID, "pager", []byte("q")); err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	waitOutput("\x1b[?1049l")
	blocks, err := s.Blocks(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range blocks {
		if item.ID == block.ID {
			found = true
			if item.Status != "done" || item.ExitCode == nil || *item.ExitCode != 0 {
				t.Fatalf("less lifecycle: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("less block missing")
	}
	next, err := s.Submit(info.ID, "pager", "after-less", "printf AFTER_LESS")
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	var after []byte
	for _, event := range allEvents(t, s, info.ID) {
		if event.Type == "output" && event.BlockID == next.ID {
			after = append(after, event.Data...)
		}
	}
	if !bytes.Contains(after, []byte("AFTER_LESS")) {
		t.Fatalf("next command output missing: %q", after)
	}
}
