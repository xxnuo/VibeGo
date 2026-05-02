package blockterm

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KennethanCeyer/ptyx"
)

func TestSubmitPreparationFailureCanRetryWithoutPhantomBlock(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	pty := &nativeRecordingPTY{}
	a := &activeSession{info: Session{ID: "submit-prepare", Phase: "ready", Shell: "bash"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: pty, temp: filepath.Join(t.TempDir(), "missing"), vt: newEmulator(80, 24)}
	s.sessions[a.info.ID] = a
	t.Cleanup(func() { delete(s.sessions, a.info.ID); a.vt.InputPipe().(io.Closer).Close(); a.vt.Close(); s.Close() })
	command := "printf 'retry 中文\\n'"
	if _, err := s.Submit(a.info.ID, "owner", "same-request", command); err == nil || !strings.Contains(err.Error(), "输入准备失败") {
		t.Fatalf("expected preparation error, got %v", err)
	}
	blocks, err := s.Blocks(a.info.ID)
	if err != nil || len(blocks) != 0 || a.info.Phase != "ready" || a.info.Error != "" || a.info.Seq != 0 || a.current != nil || pty.input.Len() != 0 {
		t.Fatalf("preparation changed session: %+v blocks=%d input=%d err=%v", a.info, len(blocks), pty.input.Len(), err)
	}
	if err := os.Mkdir(a.temp, 0700); err != nil {
		t.Fatal(err)
	}
	block, err := s.Submit(a.info.ID, "owner", "same-request", command)
	if err != nil || block.Status != "submitted" || block.Command != command || pty.input.Len() == 0 {
		t.Fatalf("retry did not submit: %+v input=%d err=%v", block, pty.input.Len(), err)
	}
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 2 || events[0].Type != "block" || events[0].Seq != 1 || events[1].Type != "state" || events[1].Seq != 2 || a.info.Seq != 2 {
		t.Fatalf("submission event transaction incorrect: %+v %v", events, err)
	}
	data, err := os.ReadFile(filepath.Join(a.temp, "input"))
	if err != nil || string(data) != command {
		t.Fatalf("input data %q: %v", data, err)
	}
	before := pty.input.Len()
	again, err := s.Submit(a.info.ID, "owner", "same-request", command)
	if err != nil || again.ID != block.ID || pty.input.Len() != before {
		t.Fatalf("successful retry lost idempotency: %+v %v", again, err)
	}
}

func TestSubmitStateFailureRollsBackBlockAndEvents(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	pty := &nativeRecordingPTY{}
	a := &activeSession{info: Session{ID: "submit-state-failure", Phase: "ready", Shell: "bash"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: pty, temp: t.TempDir(), vt: newEmulator(80, 24)}
	s.sessions[a.info.ID] = a
	t.Cleanup(func() { delete(s.sessions, a.info.ID); a.vt.InputPipe().(io.Closer).Close(); a.vt.Close(); s.Close() })
	if err := s.db.Create(&a.info).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Exec("CREATE TRIGGER reject_submit_state BEFORE INSERT ON events WHEN NEW.type = 'state' BEGIN SELECT RAISE(ABORT, 'injected state failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(a.info.ID, "owner", "request", "echo test"); err == nil {
		t.Fatal("state failure ignored")
	}
	blocks, err := s.Blocks(a.info.ID)
	if err != nil || len(blocks) != 0 {
		t.Fatalf("phantom block retained: %+v %v", blocks, err)
	}
	events, err := s.Events(a.info.ID, 0)
	if err != nil || len(events) != 0 {
		t.Fatalf("partial event transaction retained: %+v %v", events, err)
	}
	stored, err := s.Get(a.info.ID)
	if err != nil || stored.Phase != "ready" || stored.Seq != 0 || a.info.Seq != 0 || a.current != nil || !a.recordingStopped || a.info.Error == "" || pty.input.Len() != 0 {
		t.Fatalf("failed submit changed durable state or wrote input: %+v %v", stored, err)
	}
	if block, err := s.Submit(a.info.ID, "owner", "request", "echo test"); err == nil || block.ID != "" || pty.input.Len() != 0 {
		t.Fatalf("retry claimed a phantom success: %+v %v", block, err)
	}
}

type nativeRecordingPTY struct {
	ptyx.Session
	input  bytes.Buffer
	writer io.Writer
}

func (p *nativeRecordingPTY) PtyWriter() io.Writer {
	if p.writer != nil {
		return p.writer
	}
	return &p.input
}

type partialInputWriter struct {
	calls int
	err   error
}

func TestSubmitIdempotencyStillRequiresCurrentControl(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	pty := &nativeRecordingPTY{}
	a := &activeSession{info: Session{ID: "retry-control", Phase: "running"}, owner: "current-owner", lease: time.Now().Add(time.Minute), pty: pty}
	s.sessions[a.info.ID] = a
	t.Cleanup(func() { delete(s.sessions, a.info.ID); s.Close() })
	old := Block{ID: "original", SessionID: a.info.ID, RequestID: "request", Command: "echo test", Status: "running"}
	if err := s.db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	for _, owner := range []string{"", "previous-owner"} {
		if block, err := s.Submit(a.info.ID, owner, "request", old.Command); !errors.Is(err, ErrConflict) || block.ID != "" {
			t.Fatalf("invalid controller received submit success: %+v %v", block, err)
		}
	}
	if block, err := s.Submit(a.info.ID, a.owner, "request", old.Command); err != nil || block.ID != old.ID {
		t.Fatalf("current controller lost running idempotency: %+v %v", block, err)
	}
	a.lease = time.Now().Add(-time.Second)
	if block, err := s.Submit(a.info.ID, a.owner, "request", old.Command); !errors.Is(err, ErrConflict) || block.ID != "" {
		t.Fatalf("expired controller received submit success: %+v %v", block, err)
	}
	if pty.input.Len() != 0 {
		t.Fatal("idempotency check wrote terminal input")
	}
}

func TestUncertainSubmitRetryDoesNotClaimSuccess(t *testing.T) {
	for _, writeErr := range []error{nil, io.ErrClosedPipe} {
		s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
		if err != nil {
			t.Fatal(err)
		}
		writer := &partialInputWriter{err: writeErr}
		a := &activeSession{info: Session{ID: "uncertain-submit", Phase: "ready", Shell: "bash"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: &nativeRecordingPTY{writer: writer}, temp: t.TempDir(), vt: newEmulator(80, 24)}
		s.sessions[a.info.ID] = a
		t.Cleanup(func() { delete(s.sessions, a.info.ID); a.vt.InputPipe().(io.Closer).Close(); a.vt.Close(); s.Close() })
		first, err := s.Submit(a.info.ID, "owner", "request", "echo uncertain")
		if err == nil || first.ID == "" || writer.calls != 1 {
			t.Fatalf("missing initial write failure: %+v calls=%d err=%v", first, writer.calls, err)
		}
		for attempt := 0; attempt < 2; attempt++ {
			again, err := s.Submit(a.info.ID, "owner", "request", "echo uncertain")
			if err == nil || !strings.Contains(err.Error(), "结果不确定") || again.ID != first.ID || writer.calls != 1 {
				t.Fatalf("uncertain retry reported success or rewrote input: %+v calls=%d err=%v", again, writer.calls, err)
			}
		}
		if _, err := s.Submit(a.info.ID, "owner", "request", "different command"); !errors.Is(err, ErrConflict) {
			t.Fatalf("request identity conflict lost: %v", err)
		}
	}
}

func (p *partialInputWriter) Write(data []byte) (int, error) {
	p.calls++
	return len(data) / 2, p.err
}

func TestNativePartialWriteIsVisibleAndNotRetried(t *testing.T) {
	for _, writeErr := range []error{nil, io.ErrClosedPipe} {
		s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
		if err != nil {
			t.Fatal(err)
		}
		writer := &partialInputWriter{err: writeErr}
		a := &activeSession{info: Session{ID: "partial", Phase: "ready", Shell: "bash"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: &nativeRecordingPTY{writer: writer}, temp: t.TempDir(), vt: newEmulator(80, 24)}
		s.sessions[a.info.ID] = a
		t.Cleanup(func() {
			delete(s.sessions, a.info.ID)
			a.vt.InputPipe().(io.Closer).Close()
			a.vt.Close()
			s.Close()
		})
		err = s.BeginNative(a.info.ID, "owner", "echo uncertain")
		expected := writeErr
		if expected == nil {
			expected = io.ErrShortWrite
		}
		if !errors.Is(err, expected) || writer.calls != 1 {
			t.Fatalf("write result %v calls %d", err, writer.calls)
		}
		stored, err := s.Get(a.info.ID)
		if err != nil || stored.Error == "" || stored.Phase != "editing" {
			t.Fatalf("uncertain state %+v: %v", stored, err)
		}
		if err := s.BeginNative(a.info.ID, "owner", "echo uncertain"); !errors.Is(err, ErrConflict) || writer.calls != 1 {
			t.Fatalf("unsafe retry %v calls %d", err, writer.calls)
		}
		s.output(a, []byte("output after uncertain input"))
		events, err := s.Events(a.info.ID, stored.Seq)
		if err != nil || len(events) != 1 || events[0].Type != "terminal" || string(events[0].Data) != "output after uncertain input" {
			t.Fatalf("uncertain input must not hide subsequent output: %+v, %v", events, err)
		}
	}
}

func TestBeginNativeDoesNotWriteAfterRecordingOrPreparationFailure(t *testing.T) {
	for _, failure := range []string{"recording", "database", "preparation"} {
		t.Run(failure, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			p := &nativeRecordingPTY{}
			a := &activeSession{info: Session{ID: "native", Phase: "ready", Shell: "bash"}, owner: "owner", lease: time.Now().Add(time.Minute), pty: p, temp: t.TempDir(), vt: newEmulator(80, 24)}
			defer a.vt.Close()
			defer a.vt.InputPipe().(io.Closer).Close()
			s.sessions[a.info.ID] = a
			defer delete(s.sessions, a.info.ID)
			a.gridBlock = "previous"
			_, _ = a.vt.WriteString("\x1b[31mPRESERVE_READY")
			before := a.vt.String()
			switch failure {
			case "recording":
				a.info.Error = "recording stopped"
			case "database":
				if err := s.db.Exec("DROP TABLE events").Error; err != nil {
					t.Fatal(err)
				}
			case "preparation":
				a.temp = filepath.Join(t.TempDir(), "missing")
			}
			err = s.BeginNative(a.info.ID, "owner", "echo must-not-run")
			if err == nil || failure == "recording" && !errors.Is(err, ErrConflict) {
				t.Fatalf("expected rejected native entry, got %v", err)
			}
			if p.input.Len() != 0 || a.info.Phase != "ready" || a.info.Seq != 0 {
				t.Fatalf("failed entry changed state: input=%q phase=%s seq=%d", p.input.String(), a.info.Phase, a.info.Seq)
			}
			if a.gridBlock != "previous" || a.vt.String() != before {
				t.Fatalf("failed native entry changed the terminal grid: id=%s text=%q", a.gridBlock, a.vt.String())
			}
			if failure == "database" && (a.info.Error == "" || !a.recordingStopped) {
				t.Fatal("persistence failure must remain visible")
			}
			if failure == "preparation" {
				a.temp = t.TempDir()
				if err := s.BeginNative(a.info.ID, "owner", "echo retry"); err != nil {
					t.Fatal(err)
				}
				if p.input.String() != "\x1b[23~\t" || a.info.Phase != "editing" || a.info.Seq != 1 {
					t.Fatalf("retry did not enter native editing: input=%q phase=%s seq=%d", p.input.String(), a.info.Phase, a.info.Seq)
				}
				if a.gridBlock != "input" || strings.TrimSpace(a.vt.String()) != "" {
					t.Fatal("successful native entry did not select a fresh input grid")
				}
			}
		})
	}
}
