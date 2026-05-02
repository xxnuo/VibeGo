package blockterm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

func TestRealBashEOFPreservesCompletedBlockAndTail(t *testing.T) {
	for _, tc := range []struct {
		name, command string
		code          int
	}{
		{"eof", "", 0},
		{"exit-zero", "exit 0", 0},
		{"exit-nonzero", "exit 23", 23},
		{"exec-replacement", "exec sh -c 'exit 7'", 7},
		{"signal-kill", "kill -KILL $$", -1},
	} {
		t.Run(tc.name, func(t *testing.T) { testRealShellExit(t, "bash", tc.command, tc.code) })
	}
}

func TestRealShellExitMatrix(t *testing.T) {
	for _, shell := range []string{"zsh", "fish", "pwsh"} {
		for _, code := range []int{0, 23} {
			t.Run(fmt.Sprintf("%s/%d", shell, code), func(t *testing.T) { testRealShellExit(t, shell, fmt.Sprintf("exit %d", code), code) })
		}
	}
}

func testRealShellExit(t *testing.T, shell, command string, code int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Unix PTY test")
	}
	if _, err := exec.LookPath(shell); err != nil {
		t.Skip(shell + " unavailable")
	}
	if shell == "zsh" && os.Getenv("BLOCKTERM_TEST_ZSH_MODULES") != "" {
		dir := t.TempDir()
		t.Setenv("ZDOTDIR", dir)
		if err := os.WriteFile(filepath.Join(dir, ".zshenv"), []byte("module_path=('"+os.Getenv("BLOCKTERM_TEST_ZSH_MODULES")+"')\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), shell)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	info, err := s.Create("eof-tail", t.TempDir(), shell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	if err := s.Claim(info.ID, "test"); err != nil {
		t.Fatal(err)
	}
	tailCommand := "printf 'EOF_TAIL_中文\\n'"
	if shell == "pwsh" {
		tailCommand = "[Console]::WriteLine('EOF_TAIL_中文')"
	}
	block, err := s.Submit(info.ID, "test", "tail", tailCommand)
	if err != nil {
		t.Fatal(err)
	}
	awaitReady(t, s, info.ID)
	a, err := s.active(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if command == "" {
		err = s.Input(info.ID, "test", []byte{4})
	} else {
		_, err = s.Submit(info.ID, "test", "exit", command)
	}
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
		t.Fatal("real Bash EOF cleanup timed out")
	}
	stored, err := s.Get(info.ID)
	if err != nil || stored.Phase != "exited" || stored.Error != "" {
		t.Fatalf("unexpected EOF state: %+v %v", stored, err)
	}
	if code >= 0 {
		if stored.ExitCode == nil || *stored.ExitCode != code || stored.ExitSignal != "" {
			t.Fatalf("normal exit result: %+v", stored)
		}
	} else if stored.ExitCode != nil || stored.ExitSignal == "" {
		t.Fatalf("signal exit result: %+v", stored)
	}
	var output strings.Builder
	var completed Block
	var shellExitBlock Block
	exitSeq := uint64(0)
	for _, event := range allEvents(t, s, info.ID) {
		if exitSeq != 0 {
			t.Fatalf("event %s after final exit", event.Type)
		}
		if event.BlockID == block.ID {
			if event.Type == "output" {
				output.Write(event.Data)
			} else if event.Type == "block" {
				if err := json.Unmarshal(event.Data, &completed); err != nil {
					t.Fatal(err)
				}
			}
		}
		if event.Type == "state" {
			var state Session
			if err := json.Unmarshal(event.Data, &state); err != nil {
				t.Fatal(err)
			}
			if state.Phase == "exited" {
				exitSeq = event.Seq
			}
		}
		if event.Type == "block" {
			var candidate Block
			if err := json.Unmarshal(event.Data, &candidate); err != nil {
				t.Fatal(err)
			}
			if candidate.RequestID == "exit" {
				shellExitBlock = candidate
			}
		}
	}
	if completed.Status != "done" || !strings.Contains(output.String(), "EOF_TAIL_中文") || exitSeq != stored.Seq || exitSeq == 0 {
		t.Fatalf("EOF lost completed result: block=%+v output=%q exit=%d stored=%d", completed, output.String(), exitSeq, stored.Seq)
	}
	if command != "" && code >= 0 && (shellExitBlock.Status != "done" || shellExitBlock.ExitCode == nil || *shellExitBlock.ExitCode != code) {
		t.Fatalf("explicit shell exit result lost: %+v", shellExitBlock)
	}
	if code < 0 && (shellExitBlock.Status != "interrupted" || shellExitBlock.ExitCode != nil) {
		t.Fatalf("signal incorrectly completed command: %+v", shellExitBlock)
	}
}

type finalReadPTY struct {
	ptyx.Session
	data           []byte
	writer         io.Writer
	readErr        error
	waitErr        error
	reads          int
	closed, waited bool
}

func TestShellExitCompletionRequiresConfirmedUninterruptedExecution(t *testing.T) {
	for _, reason := range []string{"normal", "not-started", "unknown-exit", "cancelled", "terminated", "error"} {
		t.Run(reason, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			code := 23
			a := &activeSession{info: Session{ID: "exit", ExitCode: &code}, current: &Block{ID: "block", SessionID: "exit", Status: "running", StartedAt: 1}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24)}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			switch reason {
			case "not-started":
				a.current.StartedAt = 0
			case "unknown-exit":
				a.info.ExitCode = nil
			case "cancelled":
				a.cancelRequested = true
			case "terminated":
				a.terminationRequested.Store(true)
			case "error":
				a.info.Error = "recording failed"
			}
			s.finishRead(a)
			var block Block
			if err := s.db.First(&block, "id = ?", "block").Error; err != nil {
				t.Fatal(err)
			}
			if reason == "normal" {
				if block.Status != "done" || block.ExitCode == nil || *block.ExitCode != 23 {
					t.Fatalf("normal exit lost: %+v", block)
				}
			} else if block.Status != "interrupted" || block.ExitCode != nil {
				t.Fatalf("interruption guessed as completion: %+v", block)
			}
		})
	}
}

func (p *finalReadPTY) PtyReader() io.Reader { return p }
func (p *finalReadPTY) PtyWriter() io.Writer {
	if p.writer != nil {
		return p.writer
	}
	return io.Discard
}
func (p *finalReadPTY) Read(buffer []byte) (int, error) {
	p.reads++
	if p.readErr != nil {
		return copy(buffer, p.data), p.readErr
	}
	return copy(buffer, p.data), io.EOF
}
func (p *finalReadPTY) Close() error { p.closed = true; return nil }
func (p *finalReadPTY) Wait() error  { p.waited = true; return p.waitErr }

func TestPTYWaitResultPersistsInFinalEvent(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code *int
	}{
		{"success", nil, new(int)},
		{"nonzero", &ptyx.ExitError{ExitCode: 23}, func() *int { n := 23; return &n }()},
		{"signal", &ptyx.ExitError{ExitCode: -1}, nil},
		{"unknown", errors.New("wait fixture failure"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			p := &finalReadPTY{waitErr: tc.err}
			a := &activeSession{info: Session{ID: "wait", Phase: "running"}, pty: p, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), done: make(chan struct{}), temp: t.TempDir()}
			s.sessions[a.info.ID] = a
			go s.read(a)
			select {
			case <-a.done:
			case <-time.After(3 * time.Second):
				t.Fatal("wait cleanup timed out")
			}
			stored, err := s.Get(a.info.ID)
			if err != nil {
				t.Fatal(err)
			}
			states := []Session{stored}
			for _, event := range allEvents(t, s, a.info.ID) {
				if event.Type == "state" {
					var state Session
					if err := json.Unmarshal(event.Data, &state); err != nil {
						t.Fatal(err)
					}
					states = append(states, state)
				}
			}
			for _, state := range states {
				if state.Phase != "exited" || (state.ExitCode == nil) != (tc.code == nil) || (tc.code != nil && *state.ExitCode != *tc.code) {
					t.Fatalf("wait result mismatch: %+v", state)
				}
				if (tc.name == "unknown") != strings.Contains(state.Error, "wait fixture failure") {
					t.Fatalf("wait diagnostic mismatch: %+v", state)
				}
			}
		})
	}
}

func TestPTYReadRecordsBytesReturnedWithEOF(t *testing.T) {
	for _, phase := range []string{"submitted", "running"} {
		t.Run(phase, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			data := []byte("FINAL_中文\r\n\x00\xff\x1b]777;vibego;nonce;incomplete")
			pty := &finalReadPTY{data: data}
			a := &activeSession{info: Session{ID: "read-eof", Phase: phase}, current: &Block{ID: "command", SessionID: "read-eof", Status: phase}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), accepted: phase == "submitted", pty: pty, done: make(chan struct{}), temp: t.TempDir()}
			s.sessions[a.info.ID] = a
			go s.read(a)
			select {
			case <-a.done:
			case <-time.After(3 * time.Second):
				t.Fatal("PTY EOF cleanup did not finish")
			}
			if pty.reads != 1 || !pty.closed || !pty.waited {
				t.Fatalf("PTY lifecycle incomplete: reads=%d closed=%v waited=%v", pty.reads, pty.closed, pty.waited)
			}
			if _, exists := s.sessions[a.info.ID]; exists {
				t.Fatal("exited session retained in active map")
			}
			var output []byte
			for _, event := range allEvents(t, s, a.info.ID) {
				if event.Type == "output" {
					output = append(output, event.Data...)
				}
			}
			if !bytes.Equal(output, data) {
				t.Fatalf("final read bytes lost: %q", output)
			}
			stored, err := s.Get(a.info.ID)
			if err != nil || stored.Phase != "exited" {
				t.Fatalf("EOF state not durable: %+v %v", stored, err)
			}
		})
	}
}

func TestTerminalReplyWriteFailureIsVisible(t *testing.T) {
	for _, writeErr := range []error{nil, io.ErrClosedPipe} {
		s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		writer := &partialInputWriter{err: writeErr}
		pty := &finalReadPTY{data: []byte("\x1b[5n"), writer: writer}
		a := &activeSession{info: Session{ID: "reply-error", Phase: "running"}, current: &Block{ID: "command", SessionID: "reply-error", Status: "running"}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), pty: pty, done: make(chan struct{}), temp: t.TempDir()}
		s.sessions[a.info.ID] = a
		go s.read(a)
		select {
		case <-a.done:
		case <-time.After(3 * time.Second):
			t.Fatal("reply failure blocked reader cleanup")
		}
		stored, err := s.Get(a.info.ID)
		want := io.ErrShortWrite.Error()
		if writeErr != nil {
			want = writeErr.Error()
		}
		if err != nil || !strings.Contains(stored.Warning, want) || stored.Phase != "exited" || writer.calls != 1 {
			t.Fatalf("reply failure not preserved or retried: %+v calls=%d err=%v", stored, writer.calls, err)
		}
	}
}

func TestPTYReadFailurePreservesFinalOutputAndReason(t *testing.T) {
	for _, readErr := range []error{io.EOF, os.ErrClosed, io.ErrClosedPipe, syscall.EIO, fmt.Errorf("wrapped: %w", io.EOF), io.ErrUnexpectedEOF} {
		t.Run(readErr.Error(), func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			pty := &finalReadPTY{data: []byte("LAST_OUTPUT"), readErr: readErr}
			a := &activeSession{info: Session{ID: "read-error", Phase: "running", Error: "earlier input warning"}, current: &Block{ID: "block", SessionID: "read-error", Status: "running"}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), pty: pty, done: make(chan struct{}), temp: t.TempDir()}
			s.sessions[a.info.ID] = a
			go s.read(a)
			select {
			case <-a.done:
			case <-time.After(3 * time.Second):
				t.Fatal("read failure cleanup stalled")
			}
			stored, err := s.Get(a.info.ID)
			want := "earlier input warning"
			if readErr == io.ErrUnexpectedEOF {
				want += "\n终端读取失败: " + readErr.Error()
			}
			if err != nil || stored.Error != want || stored.Phase != "exited" {
				t.Fatalf("read error state %+v %v", stored, err)
			}
			var output []byte
			for _, event := range allEvents(t, s, a.info.ID) {
				if event.Type == "output" {
					output = append(output, event.Data...)
				}
			}
			if string(output) != "LAST_OUTPUT" {
				t.Fatalf("last output lost: %q", output)
			}
		})
	}
}

func TestEOFRecordsAcceptedDiagnosticsBeforeInterruption(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		a := &activeSession{info: Session{ID: "eof", Phase: "submitted"}, current: &Block{ID: "command", SessionID: "eof", Status: "submitted"}, decoder: NewDecoder("nonce"), vt: newEmulator(80, 24), accepted: accepted}
		defer a.vt.Close()
		defer a.vt.InputPipe().(io.Closer).Close()
		data := []byte("fatal diagnostic\r\n\x00\xff")
		tail := []byte("\x1b]777;vibego;nonce;broken")
		a.decoder.Feed(append(append([]byte(nil), data...), tail...), func(chunk []byte) { s.output(a, chunk) }, func(string) { t.Fatal("incomplete hook dispatched") })
		s.finishRead(a)
		events, err := s.Events("eof", 0)
		if err != nil {
			t.Fatal(err)
		}
		var output []byte
		var interrupted Block
		for _, event := range events {
			if event.Type == "output" {
				if interrupted.ID != "" {
					t.Fatal("diagnostics published after final block state")
				}
				output = append(output, event.Data...)
			}
			if event.Type == "block" {
				if err := json.Unmarshal(event.Data, &interrupted); err != nil {
					t.Fatal(err)
				}
			}
		}
		want := []byte(nil)
		if accepted {
			want = append(data, tail...)
		}
		if !bytes.Equal(output, want) || interrupted.Status != "interrupted" || interrupted.FinishedAt == 0 {
			t.Fatalf("accepted=%v output=%q block=%+v", accepted, output, interrupted)
		}
		if a.info.Phase != "exited" || a.current != nil || a.pendingOutput != nil || a.accepted {
			t.Fatal("EOF did not release pending command state")
		}
	}
}

func TestEOFFinalStatesAreAtomic(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprintf("fail=%v", fail), func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			a := &activeSession{info: Session{ID: "eof", Phase: "running"}, current: &Block{ID: "command", SessionID: "eof", Status: "running"}, decoder: NewDecoder("nonce")}
			if err := s.db.Create(&a.info).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.db.Create(a.current).Error; err != nil {
				t.Fatal(err)
			}
			if fail {
				if err := s.db.Exec("CREATE TRIGGER reject_exit_state BEFORE INSERT ON events WHEN NEW.type = 'state' BEGIN SELECT RAISE(ABORT, 'injected exit failure'); END").Error; err != nil {
					t.Fatal(err)
				}
			}
			s.finishRead(a)
			stored, err := s.Get("eof")
			if err != nil {
				t.Fatal(err)
			}
			var block Block
			if err := s.db.First(&block, "id = ?", "command").Error; err != nil {
				t.Fatal(err)
			}
			events := allEvents(t, s, "eof")
			if fail {
				if stored.Phase != "running" || block.Status != "running" || block.FinishedAt != 0 || stored.Seq != 0 || a.info.Seq != 0 || len(events) != 0 || !a.recordingStopped {
					t.Fatalf("partial EOF commit: session=%+v block=%+v events=%v", stored, block, events)
				}
			} else if stored.Phase != "exited" || block.Status != "interrupted" || block.FinishedAt == 0 || stored.Seq != 2 || len(events) != 2 || events[0].Type != "block" || events[1].Type != "state" {
				t.Fatalf("missing EOF commit: session=%+v block=%+v events=%v", stored, block, events)
			}
			if a.info.Phase != "exited" || a.current != nil || a.accepted || a.pendingOutput != nil {
				t.Fatal("EOF left writable in-memory state")
			}
		})
	}
}
