package blockterm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDecoderEverySplit(t *testing.T) {
	raw := []byte("before\x1b]777;vibego;token;start\aafter\x1b[31m红\x00")
	for split := 0; split <= len(raw); split++ {
		d := NewDecoder("token")
		var out bytes.Buffer
		hooks := []string{}
		output := func(b []byte) { out.Write(b) }
		hook := func(v string) { hooks = append(hooks, v) }
		d.Feed(raw[:split], output, hook)
		d.Feed(raw[split:], output, hook)
		d.Flush(output)
		if out.String() != "beforeafter\x1b[31m红\x00" || len(hooks) != 1 || hooks[0] != "start" {
			t.Fatalf("split %d: %q %v", split, out.String(), hooks)
		}
	}
}

func TestDecoderLargeCommandAndBound(t *testing.T) {
	payload := "start;" + strings.Repeat("A", 1400000) + ";1"
	raw := []byte("\x1b]777;vibego;token;" + payload + "\a")
	d := NewDecoder("token")
	var output bytes.Buffer
	var hooks []string
	for start := 0; start < len(raw); start += 32768 {
		end := min(start+32768, len(raw))
		d.Feed(raw[start:end], func(b []byte) { output.Write(b) }, func(v string) { hooks = append(hooks, v) })
	}
	if output.Len() != 0 || len(hooks) != 1 || hooks[0] != payload {
		t.Fatalf("large hook lost: output=%d hooks=%d", output.Len(), len(hooks))
	}
	d.Feed([]byte("\x1b]777;vibego;token;"+strings.Repeat("A", 2<<20)), func(b []byte) { output.Write(b) }, func(string) { t.Fatal("unfinished hook") })
	if len(d.pending) != 0 || output.Len() == 0 {
		t.Fatal("unfinished hook is not bounded")
	}
}

func awaitReady(t *testing.T, s *Service, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		info, err := s.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if info.Phase == "ready" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	info, _ := s.Get(id)
	events, _ := s.Events(id, 0)
	b, _ := json.Marshal(events)
	t.Fatalf("not ready: %+v events %s", info, b)
}

func allEvents(t *testing.T, s *Service, id string) []Event {
	t.Helper()
	var result []Event
	var cursor uint64
	for {
		events, err := s.Events(id, cursor)
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, events...)
		if len(events) == 0 {
			return result
		}
		cursor = events[len(events)-1].Seq
	}
}

func TestContinuousBashAndReplay(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell test")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("test", t.TempDir(), "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err = s.Claim(info.ID, "test"); err != nil {
		t.Fatal(err)
	}
	for i, command := range []string{"export VG_TEST_VALUE=continuous; function vg_test_fn() { printf 'function-ok'; }; cd /", "printf '%s:' \"$VG_TEST_VALUE\"; vg_test_fn; pwd"} {
		request := string(rune('a' + i))
		b, err := s.Submit(info.ID, "test", request, command)
		if err != nil {
			t.Fatal(err)
		}
		awaitReady(t, s, info.ID)
		again, err := s.Submit(info.ID, "test", request, command)
		if err != nil || again.ID != b.ID {
			t.Fatalf("idempotence: %+v %v", again, err)
		}
	}
	events, err := s.Events(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	for i, e := range events {
		if e.Seq != uint64(i+1) {
			t.Fatal("sequence gap")
		}
		if e.Type == "output" {
			out.Write(e.Data)
		}
	}
	if !strings.Contains(out.String(), "continuous:function-ok/") {
		t.Fatalf("shell state lost: %q", out.String())
	}
	blocks, _ := s.Blocks(info.ID)
	count := 0
	for _, b := range blocks {
		if b.RequestID != "" {
			count++
			if b.ExitCode == nil || *b.ExitCode != 0 {
				t.Fatalf("bad exit %+v", b)
			}
		}
	}
	if count != 2 {
		t.Fatalf("%d command blocks", count)
	}
	if err = s.Claim(info.ID, "other"); err != ErrConflict {
		t.Fatalf("expected control conflict: %v", err)
	}
}

func TestInteractiveInterruptAndBackground(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell test")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("interactive", t.TempDir(), "bash", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err = s.Claim(info.ID, "test"); err != nil {
		t.Fatal(err)
	}
	b, err := s.Submit(info.ID, "test", "read", "read -r value; printf 'VALUE_%s\\n' \"$value\"")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		current, _ := s.Get(info.ID)
		if current.Phase == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("read did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = s.Input(info.ID, "test", []byte("中文-input\r")); err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	events, _ := s.Events(info.ID, 0)
	var out bytes.Buffer
	for _, e := range events {
		if e.Type == "output" && e.BlockID == b.ID {
			out.Write(e.Data)
		}
	}
	if !strings.Contains(out.String(), "VALUE_中文-input") {
		t.Fatalf("interactive output %q", out.String())
	}
	_, err = s.Submit(info.ID, "test", "interrupt", "sleep 20")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err = s.Input(info.ID, "test", []byte{3}); err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	background, err := s.Submit(info.ID, "test", "background", "(sleep 0.1; printf 'BACKGROUND_MARKER\\n') &")
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	time.Sleep(250 * time.Millisecond)
	events, _ = s.Events(info.ID, 0)
	blocks, _ := s.Blocks(info.ID)
	kinds := map[string]string{}
	for _, b := range blocks {
		kinds[b.ID] = b.Kind
	}
	found := false
	started := false
	for _, e := range events {
		if e.Type == "block" && e.BlockID == background.ID {
			var state Block
			if json.Unmarshal(e.Data, &state) == nil && state.Status == "running" {
				started = true
			}
		}
		if e.Type == "output" && bytes.Contains(e.Data, []byte("BACKGROUND_MARKER")) && kinds[e.BlockID] == "background" {
			found = true
		}
	}
	if !found {
		t.Fatal("background output not separated")
	}
	if !started {
		t.Fatal("background command skipped preexec")
	}
}

func TestRecoveryAppendsAuthoritativeEvents(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info := Session{ID: "stale", Phase: "running", Seq: 0}
	if err = s.db.Create(&info).Error; err != nil {
		t.Fatal(err)
	}
	b := Block{ID: "stale-block", SessionID: info.ID, Status: "submitted"}
	if err = s.db.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	if err = recoverSessions(s.db); err != nil {
		t.Fatal(err)
	}
	events, _ := s.Events(info.ID, 0)
	if len(events) != 2 || events[0].Type != "block" || events[1].Type != "state" {
		t.Fatalf("recovery events %+v", events)
	}
	if err = recoverSessions(s.db); err != nil {
		t.Fatal(err)
	}
	again, _ := s.Events(info.ID, 0)
	if len(again) != 2 {
		t.Fatal("recovery is not idempotent")
	}
}

func TestShellMatrix(t *testing.T) {
	shells := []string{"bash", "zsh", "fish", "pwsh", "powershell"}
	if value := os.Getenv("BLOCKTERM_TEST_SHELLS"); value != "" {
		shells = strings.Split(value, ",")
	}
	for _, shell := range shells {
		t.Run(shell, func(t *testing.T) {
			if shell == "zsh" && os.Getenv("BLOCKTERM_TEST_ZSH_MODULES") != "" {
				dir := t.TempDir()
				t.Setenv("ZDOTDIR", dir)
				if err := os.WriteFile(filepath.Join(dir, ".zshenv"), []byte("module_path=('"+os.Getenv("BLOCKTERM_TEST_ZSH_MODULES")+"')\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := exec.LookPath(shell); err != nil {
				if os.Getenv("BLOCKTERM_TEST_SHELLS") != "" {
					t.Fatal(err)
				}
				t.Skip("shell unavailable")
			}
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), shell)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			info, err := s.Create("matrix", t.TempDir(), shell, 80, 24)
			if err != nil {
				t.Fatal(err)
			}
			awaitReady(t, s, info.ID)
			if err = s.Claim(info.ID, "matrix"); err != nil {
				t.Fatal(err)
			}
			commands := []string{"export VG_MATRIX_VALUE=alpha; vg_matrix() { printf function; }", "printf 'STATE_%s:' \"$VG_MATRIX_VALUE\"; vg_matrix"}
			if shell == "fish" {
				commands = []string{"set -gx VG_MATRIX_VALUE alpha; function vg_matrix; printf function; end", "printf 'STATE_%s:' \"$VG_MATRIX_VALUE\"; vg_matrix"}
			}
			if shell == "pwsh" || shell == "powershell" {
				commands = []string{"$env:VG_MATRIX_VALUE='alpha'; function vg_matrix { [Console]::Write('function') }", `[Console]::Write("STATE_$($env:VG_MATRIX_VALUE):"); vg_matrix`}
			}
			for i, command := range commands {
				if _, err = s.Submit(info.ID, "matrix", strconv.Itoa(i), command); err != nil {
					t.Fatal(err)
				}
				awaitReady(t, s, info.ID)
			}
			multiline := "printf 'MULTI_ONE\\n'\nprintf 'MULTI_TWO\\n'"
			if shell == "pwsh" || shell == "powershell" {
				multiline = "[Console]::WriteLine('MULTI_ONE')\n[Console]::WriteLine('MULTI_TWO')"
			}
			multi, err := s.Submit(info.ID, "matrix", "multiline", multiline)
			if err != nil {
				t.Fatal(err)
			}
			awaitReady(t, s, info.ID)
			multiEvents, err := s.Output(info.ID, multi.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			var multiOutput bytes.Buffer
			for _, event := range multiEvents {
				multiOutput.Write(event.Data)
			}
			if !strings.Contains(multiOutput.String(), "MULTI_ONE") || !strings.Contains(multiOutput.String(), "MULTI_TWO") {
				t.Fatalf("multiline block split: %q", multiOutput.String())
			}
			failureCommand := "false"
			isPowerShell := shell == "pwsh" || shell == "powershell"
			if isPowerShell {
				failureCommand = "Write-Error 'expected test failure'"
			}
			failed, err := s.Submit(info.ID, "matrix", "failure", failureCommand)
			if err != nil {
				t.Fatal(err)
			}
			awaitReady(t, s, info.ID)
			var outcome Block
			if err := s.db.First(&outcome, "id = ?", failed.ID).Error; err != nil {
				t.Fatal(err)
			}
			if outcome.ExitCode == nil || *outcome.ExitCode == 0 || (isPowerShell && (outcome.Success == nil || *outcome.Success)) {
				t.Fatalf("failure reported as success: %+v", outcome)
			}
			if shell == "bash" {
				for i, command := range []string{`printf 'PREVIOUS_STATUS_%s\n' "$?"`, `(printf 'SUBSHELL_MARKER\n')`, `(printf 'ASYNC_MARKER\n') & wait`} {
					b, err := s.Submit(info.ID, "matrix", fmt.Sprintf("bash-boundary-%d", i), command)
					if err != nil {
						t.Fatal(err)
					}
					awaitReady(t, s, info.ID)
					var raw strings.Builder
					for _, event := range allEvents(t, s, info.ID) {
						if event.BlockID == b.ID && event.Type == "output" {
							raw.Write(event.Data)
						}
					}
					marker := []string{"PREVIOUS_STATUS_1", "SUBSHELL_MARKER", "ASYNC_MARKER"}[i]
					if !strings.Contains(raw.String(), marker) || (i < 2 && strings.Contains(raw.String(), "printf '")) {
						t.Fatalf("boundary/echo incorrect: %q", raw.String())
					}
				}
			}
			if shell == "zsh" || shell == "fish" {
				command := `printf 'PREVIOUS_STATUS_%s\n' "$?"`
				if shell == "fish" {
					command = `printf 'PREVIOUS_STATUS_%s\n' "$status"`
				}
				b, err := s.Submit(info.ID, "matrix", "previous-status", command)
				if err != nil {
					t.Fatal(err)
				}
				awaitReady(t, s, info.ID)
				var raw strings.Builder
				for _, event := range allEvents(t, s, info.ID) {
					if event.BlockID == b.ID && event.Type == "output" {
						raw.Write(event.Data)
					}
				}
				if !strings.Contains(raw.String(), "PREVIOUS_STATUS_1") {
					t.Fatalf("previous shell status lost: %q", raw.String())
				}
			}
			if isPowerShell {
				nativeCommand := "sh -c 'exit 7'"
				if runtime.GOOS == "windows" {
					nativeCommand = "cmd /c exit 7"
				}
				if _, err := s.Submit(info.ID, "matrix", "native-failure", nativeCommand); err != nil {
					t.Fatal(err)
				}
				awaitReady(t, s, info.ID)
				cmdlet, err := s.Submit(info.ID, "matrix", "cmdlet-after-native", "Write-Error 'expected cmdlet failure'")
				if err != nil {
					t.Fatal(err)
				}
				awaitReady(t, s, info.ID)
				var cmdletOutcome Block
				if err := s.db.First(&cmdletOutcome, "id = ?", cmdlet.ID).Error; err != nil {
					t.Fatal(err)
				}
				if cmdletOutcome.ExitCode == nil || *cmdletOutcome.ExitCode != 1 || cmdletOutcome.NativeExitCode == nil || *cmdletOutcome.NativeExitCode != 7 {
					t.Fatalf("cmdlet/native statuses conflated: %+v", cmdletOutcome)
				}
				check, err := s.Submit(info.ID, "matrix", "native-preserved", `[Console]::WriteLine("NATIVE_PREVIOUS_$LASTEXITCODE")`)
				if err != nil {
					t.Fatal(err)
				}
				awaitReady(t, s, info.ID)
				output, err := s.Output(info.ID, check.ID, 0)
				if err != nil {
					t.Fatal(err)
				}
				var text strings.Builder
				for _, event := range output {
					text.Write(event.Data)
				}
				if !strings.Contains(text.String(), "NATIVE_PREVIOUS_7") {
					t.Fatalf("LASTEXITCODE overwritten: %q", text.String())
				}
			}
			interruptCommand := "sleep 20"
			if isPowerShell {
				interruptCommand = "Start-Sleep -Seconds 20"
			}
			interrupted, err := s.Submit(info.ID, "matrix", "matrix-interrupt", interruptCommand)
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(5 * time.Second)
			for {
				current, err := s.Get(info.ID)
				if err != nil {
					t.Fatal(err)
				}
				if current.Phase == "running" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("interrupt command did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := s.Input(info.ID, "matrix", []byte{3}); err != nil {
				t.Fatal(err)
			}
			awaitReady(t, s, info.ID)
			var interruptedOutcome Block
			if err := s.db.First(&interruptedOutcome, "id = ?", interrupted.ID).Error; err != nil {
				t.Fatal(err)
			}
			if interruptedOutcome.Status == "running" || interruptedOutcome.Status == "submitted" || interruptedOutcome.FinishedAt == 0 {
				t.Fatalf("interrupt did not finalize block: %+v", interruptedOutcome)
			}
			if interruptedOutcome.ExitCode == nil || *interruptedOutcome.ExitCode == 0 {
				t.Fatalf("interrupted execution reported success: %+v", interruptedOutcome)
			}
			recovered, err := s.Submit(info.ID, "matrix", "after-interrupt", commands[1])
			if err != nil {
				t.Fatal(err)
			}
			awaitReady(t, s, info.ID)
			var recoveredOutcome Block
			if err := s.db.First(&recoveredOutcome, "id = ?", recovered.ID).Error; err != nil {
				t.Fatal(err)
			}
			if recoveredOutcome.Status != "done" || recoveredOutcome.ExitCode == nil || *recoveredOutcome.ExitCode != 0 || recoveredOutcome.StartedAt == 0 || recoveredOutcome.FinishedAt == 0 {
				t.Fatalf("recovered command did not complete: %+v", recoveredOutcome)
			}
			live, err := s.Get(info.ID)
			if err != nil || live.Phase != "ready" || live.ExitCode != nil || live.ExitSignal != "" {
				t.Fatalf("command interruption polluted process state: %+v %v", live, err)
			}
			var recoveredOutput strings.Builder
			for _, event := range allEvents(t, s, info.ID) {
				if event.Type == "output" && event.BlockID == recovered.ID {
					recoveredOutput.Write(event.Data)
				}
			}
			if !strings.Contains(recoveredOutput.String(), "STATE_alpha:function") {
				t.Fatalf("shell state lost after interrupt: %q", recoveredOutput.String())
			}
			events := allEvents(t, s, info.ID)
			var out bytes.Buffer
			for _, e := range events {
				if e.Type == "output" {
					out.Write(e.Data)
				}
			}
			if !strings.Contains(out.String(), "STATE_alpha:function") {
				for _, event := range events {
					t.Logf("%d %s %s", event.Seq, event.Type, string(event.Data))
				}
				t.Fatalf("state lost: %q", out.String())
			}
		})
	}
}
