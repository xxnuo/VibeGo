package blockterm

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBashAcceptedInputLifecycle(t *testing.T) {
	testAcceptedInputLifecycle(t, "bash")
}

func TestZshAcceptedInputLifecycle(t *testing.T) {
	if modules := os.Getenv("BLOCKTERM_TEST_ZSH_MODULES"); modules != "" {
		dir := t.TempDir()
		t.Setenv("ZDOTDIR", dir)
		if err := os.WriteFile(filepath.Join(dir, ".zshenv"), []byte("module_path=('"+modules+"')\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	testAcceptedInputLifecycle(t, "zsh")
}

func TestFishAcceptedInputLifecycle(t *testing.T) {
	testAcceptedInputLifecycle(t, "fish")
}

func TestPowerShellAcceptedInputLifecycle(t *testing.T) {
	testAcceptedInputLifecycle(t, "pwsh")
}

func TestWindowsPowerShellAcceptedInputLifecycle(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell fixture")
	}
	testAcceptedInputLifecycle(t, "powershell")
}

func testAcceptedInputLifecycle(t *testing.T, shell string) {
	t.Helper()
	isPowerShell := shell == "pwsh" || shell == "powershell"
	t.Setenv("LC_ALL", "C")
	if runtime.GOOS == "windows" && !isPowerShell {
		t.Skip("Unix Shell fixture")
	}
	if _, err := exec.LookPath(shell); err != nil {
		t.Skip(shell + " unavailable")
	}
	s, err := Open(filepath.Join(t.TempDir(), "accept.sqlite"), shell)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("accepted", t.TempDir(), shell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "test"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		command, status string
		diagnostic      bool
	}{
		{")", "not_executed", true}, {"# a comment", "not_executed", false}, {"printf 'AFTER_REJECTION\\n'", "done", false},
	} {
		if isPowerShell {
			if strings.HasPrefix(tc.command, "#") {
				tc.status = "done"
			}
			if strings.HasPrefix(tc.command, "printf") {
				tc.command = "[Console]::WriteLine('AFTER_REJECTION')"
			}
		}
		if shell == "zsh" && strings.HasPrefix(tc.command, "#") {
			continue
		}
		if shell == "fish" && strings.HasPrefix(tc.command, "#") {
			tc.status = "done" // Fish emits preexec even for a comment-only commandline.
		}
		b, err := s.Submit(info.ID, "test", tc.command, tc.command)
		if err != nil {
			t.Fatal(err)
		}
		awaitReady(t, s, info.ID)
		var stored Block
		if err := s.db.First(&stored, "id = ?", b.ID).Error; err != nil {
			t.Fatal(err)
		}
		if stored.Status != tc.status {
			t.Fatalf("%q status: %+v", tc.command, stored)
		}
		if tc.status == "done" && (stored.StartedAt < stored.CreatedAt || stored.StartedAt > stored.FinishedAt) {
			t.Fatalf("execution timestamps invalid: %+v", stored)
		}
		if tc.status == "not_executed" && stored.StartedAt != 0 {
			t.Fatalf("unexecuted input has an execution timestamp: %+v", stored)
		}
		var output strings.Builder
		started := false
		for _, event := range allEvents(t, s, info.ID) {
			if event.BlockID != b.ID {
				continue
			}
			if event.Type == "output" {
				output.Write(event.Data)
			}
			if event.Type == "block" {
				var block Block
				_ = json.Unmarshal(event.Data, &block)
				started = started || block.Status == "running"
			}
		}
		if tc.status != "done" && started {
			t.Fatalf("unexecuted input became running: %q", tc.command)
		}
		if tc.diagnostic && (!(strings.Contains(output.String(), "syntax error") || strings.Contains(output.String(), "parse error") || (shell == "fish" && strings.Contains(output.String(), "Unexpected ')'")) || (isPowerShell && strings.Contains(output.String(), "Unexpected token"))) || stored.ExitCode != nil || stored.ShellStatus == nil || *stored.ShellStatus == 0) {
			t.Fatalf("parser diagnostic lost: %q %+v", output.String(), stored)
		}
	}
	for _, empty := range []string{"", "   "} {
		before, err := s.Get(info.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.BeginNative(info.ID, "test", empty); err != nil {
			t.Fatal(err)
		}
		if err := s.Input(info.ID, "test", []byte("\r")); err != nil {
			t.Fatal(err)
		}
		awaitReady(t, s, info.ID)
		for _, event := range allEvents(t, s, info.ID) {
			if event.Seq <= before.Seq || event.Type != "block" {
				continue
			}
			var block Block
			if err := json.Unmarshal(event.Data, &block); err != nil {
				t.Fatal(err)
			}
			if block.Status == "running" {
				t.Fatalf("blank native input marked running: %+v", block)
			}
		}
	}
	for _, cancel := range []bool{true, false} {
		opening := "if true; then"
		if shell == "fish" {
			opening = "if true"
		}
		if isPowerShell {
			opening = "if ($true) {"
		}
		if err := s.BeginNative(info.ID, "test", opening); err != nil {
			t.Fatal(err)
		}
		if err := s.Input(info.ID, "test", []byte("\r")); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			state, err := s.Get(info.ID)
			if err != nil {
				t.Fatal(err)
			}
			if state.Phase == "submitted" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("continuation not accepted: %+v", state)
			}
			time.Sleep(10 * time.Millisecond)
		}
		data := []byte("printf 'CONTINUATION_OK\\n'\rfi\r")
		if shell == "fish" {
			data = []byte("printf 'CONTINUATION_OK\\n'\rend\r")
		}
		if isPowerShell {
			data = []byte("[Console]::WriteLine('CONTINUATION_OK')\r}\r")
		}
		if cancel {
			data = []byte{3}
		}
		if err := s.Input(info.ID, "test", data); err != nil {
			t.Fatal(err)
		}
		awaitReady(t, s, info.ID)
		var latest Block
		if err := s.db.Where("session_id = ? AND kind = ?", info.ID, "command").Order("created_at DESC, id DESC").First(&latest).Error; err != nil {
			t.Fatal(err)
		}
		if cancel && latest.Status != "interrupted" {
			t.Fatalf("continuation cancel: %+v", latest)
		}
		closing := "fi"
		if shell == "fish" {
			closing = "end"
		}
		if isPowerShell {
			closing = "}"
		}
		if !cancel && (latest.Status != "done" || !strings.Contains(latest.Command, closing)) {
			t.Fatalf("continuation command lost: %+v", latest)
		}
	}
	a, err := s.active(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	before := a.info.Seq
	s.hook(a, "end;0;L3RtcA==;;;"+strconv.FormatUint(a.hookSeq, 10))
	if a.info.Seq != before {
		t.Error("duplicate prompt mutated ready session")
	}
	a.mu.Unlock()
}
